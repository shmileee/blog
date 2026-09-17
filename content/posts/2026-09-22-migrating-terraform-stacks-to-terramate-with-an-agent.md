---
title: Migrating Terraform stacks to Terramate with an agent
description: A per-stack Terraform migration behind an empty-plan gate, driven by an agent through Atlantis.
date: 2026-09-22 09:00:00
categories:
  - terraform
  - terramate
---

Moving a flat Terraform repository into Terramate stacks, one stack at a time,
without destroying or moving anything. The procedure is deliberately boring,
and the gate at the end of it is mechanical enough to hand to someone, or
something, that has never seen the stack before. It is the fifth post in a
series on Terraform and Terramate, after
[Generating Terraform for teams from one JSON file](/blog/posts/generating-terraform-for-teams-from-one-json-file/).

Versions are Terramate 0.17.3 with Terraform 1.15.8. The procedure is the one
used on a private monorepo of 508 stacks, where **85 legacy stacks have moved
this way so far** and 30 are still waiting; buckets, keys and account names are
placeholders.

## One stack at a time, in the right order

The layout being replaced is the usual one: `app/<stack>/<env>/`, each directory
holding its own `main.tf`, its own `terraform.tf` with a backend block, and a
state key derived from its own path.

Converting the whole tree at once is unsafe because the state key moves for
every stack simultaneously. A backend key is what ties a directory to the
resources it manages, so a repository-wide move has every stack planning against
a key that does not exist yet. There is no partial rollback from that, only one
large revert.

Per-stack migration avoids it, but the stacks are not equally safe to move.
Classify before starting:

| Class | Signals | Action |
| --- | --- | --- |
| Go | single AWS context, no remote-state coupling, rarely changes | migrate now |
| Review | several provider aliases, git-ref module sources, provider major differs from the generated constraint | migrate with care |
| Hold | reads or is read via `terraform_remote_state`, owns shared networking or DNS, inline secrets in `*.tf` | migrate later, as a group |

The `terraform_remote_state` rule exists because a producer and its consumers
have to move together, or the producer first: copying a producer’s state to a
new key while a consumer still reads the old one leaves the consumer reading a
snapshot that stops being updated.

## Copy the state, never move it

The mechanical part is short, and only one step of it touches AWS directly.

<figure class="concept-diagram" data-concept-diagram>
  <div class="diagram-exhibit" data-exhibit role="img"
       aria-label="Migration path: scaffold the stack, move the code, copy the state object, then open a pull request for the plan gate">
    <div class="diagram-exhibit-label">PER-STACK MIGRATION</div>
    <div>
      <span>create stack</span><i aria-hidden="true">→</i>
      <span>move code</span><i aria-hidden="true">→</i>
      <span>copy state</span><i aria-hidden="true">→</i>
      <span>plan gate</span>
    </div>
  </div>
  <figcaption class="exhibit-caption">The state copy happens before the pull request opens, because CI plans on open.</figcaption>
</figure>

Scaffolding comes first, so that the new backend key exists on paper before
anything is copied into it:

```bash
cd stacks/aws/<account-folder>/<region>
terramate create <stack-name>
git mv app/<stack-name>/<env>/main.tf \
  stacks/aws/<account-folder>/<region>/<stack-name>/main.tf
```

Then the moved file is edited down. The root `provider "aws"` block comes out,
because the generator now emits it, and the backend block comes out for the same
reason. Every relative module source gains the two extra `../` that the deeper
path costs. What stays is the module invocations and any stack-local
resources.

The state copy is a plain S3 object copy between the old key and the
Terramate-generated one, guarded on both sides:

```bash
# 1. the legacy object exists
aws s3api head-object --profile <profile> \
  --bucket <legacy-bucket> --key <legacy-key>

# 2. the new key is still empty (if not, back it up first)
aws s3api head-object --profile <profile> \
  --bucket <new-bucket> --key <new-key>

# 3. copy, never move
aws s3api copy-object --profile <profile> --bucket <new-bucket> \
  --copy-source <legacy-bucket>/<legacy-key> --key <new-key>
```

Copying rather than moving is what makes the migration reversible. The legacy
object stays byte-for-byte intact, so reverting the pull request restores the
legacy directory and its project resumes planning against its original key, with
the copy left behind as an orphan. Comparing `ETag` and `ContentLength` on both
objects afterwards is a cheap integrity check; state files are usually a single
part, so a matching `ETag` is a strong signal.

## The plan gate

A migrated stack should manage exactly the resources it managed before, and the
plan on the pull request is where that is proven. With the state copied
byte-for-byte and the code moved rather than rewritten, Terraform refreshes
every resource in the copied state, compares it with the moved configuration,
and finds nothing to do.

That gives a gate precise enough to delegate. The migration passes on one line
of plan output:

```text
No changes. Your infrastructure matches the configuration.
```

Zero creates, replaces, destroys or attribute updates. Anything else means
stop, and the diagnosis order matters more than the list:

1. **Provider version drift**: the generated constraint resolves to a different
   major than the legacy lock file. Fix the declaration, never upgrade to clear
   a diff.
2. **A wrong global**: the profile or region resolved from the new path is not
   the one the legacy stack used, so the plan fails to authenticate or wants to
   recreate everything somewhere else.
3. **A renamed provider alias**: aliases must keep their exact old names or
   every aliased resource plans as new.
4. **Module source depth**: off by one `../`, or a git-ref source that now
   resolves to newer code than the last apply.
5. **Path-sensitive functions**: `file()`, `templatefile()`, `fileset()`,
   `path.root` and friends compute different values from a different directory.

Only the first two are common; the rest matter because each produces a plan that
looks like a real infrastructure change and is not.

Deleting the legacy directory belongs in the same pull request, and it has to be
the whole directory: continuous integration that discovers Terraform projects by
directory will still find an empty one and fail initialising it.

## Handing the runbook to an agent

Written down, the procedure above is a runbook, and a runbook whose steps never
vary is a script with prose formatting. It is also close to ideal agent work:
every input is discoverable from the repository, every step is mechanical, and
the success criterion is a diff shape rather than a judgement.

So the runbook became a skill, a Markdown file an
[OpenCode](https://opencode.ai) agent loads on demand, which names the steps and
the rules it may not negotiate:

- **Hold by default.** A stack migrates only if the classification above
  clears it.
  Anything high-blast-radius or coupled is reported and left for a human.
- **Copy state, never move it.** No `terraform state mv`, no deleting the legacy
  object.
- **Never apply locally.** The agent runs `terramate generate`,
  `terraform fmt` and read-only `aws s3api` calls. Nothing else.
- **Match provider versions exactly.** Never upgrade a major to clear a diff.
- **An empty plan is the gate.** Anything else stops the run.
- **Confirm before opening a pull request, and before every apply.**

Each rule closes off a shortcut that would look locally reasonable to an agent
halfway through a migration. The last one matters most: the agent prepares and
waits rather than finishing, because the steps it cannot take are the steps
that change infrastructure.

The tool doing that planning is [Atlantis](https://www.runatlantis.io/): it
plans when a pull request opens and applies when someone comments on it. Two
consequences shape the whole procedure. The state copy has to land **before**
the pull request opens, because the plan runs immediately on open. And the
agent can prepare the change but not apply it, so it opens the pull request,
reads the plan, checks it against the gate, and asks. Approval comes from a
different identity than the one that wrote the branch, which is worth keeping
whether the author is a person or not.

Applying is one comment per stack directory, in sequence:

```bash
gh pr comment "$PR" \
  --body "atlantis apply -d stacks/aws/<account>/<region>/<stack>"
gh pr checks "$PR" --watch
```

A single comment listing several directories does not work, and a bare
`atlantis apply` is unreliable once a pull request carries more than one
project. One directory per comment, waiting for each to report success, is the
only sequence that behaves.

Running several migrations at once is where an agent pays off, and git
worktrees make it safe:

```bash
git worktree add ../migrate-<stack> -b migrate/<stack>-to-terramate
```

One worktree per stack, living outside the repository so neither Terramate nor
Atlantis scans it, each with its own branch, pull request and agent. The paths
each migration touches are disjoint, and the shared imports are never modified,
so the runs do not collide.

They do collide on one file. Every migration pull request edits `CODEOWNERS`,
the file GitHub routes reviews by, to drop the rule for the legacy directory it
deleted, so the first one to
merge leaves the others based on a stale branch with a conflict in exactly
that file. It is mechanical to fix, rebase and re-plan, but it is worth
knowing before three agents report the same failure at once.

## Limitations

An empty plan proves that the copied state, the moved code and what is deployed
agree with each other. It does not prove the legacy directory has stopped being
applied: an apply there after the copy changes infrastructure that the new
stack will then want to revert. Freeze the legacy directory once its object is
copied, and delete it in the migration pull request.

The state copy needs credentials for the destination account, so it cannot be
delegated to continuous integration; everything else is a pull request.

The classification is advisory. It reads provider blocks, remote-state
references and recent churn, all of which are proxies; a stack can look like a
clean candidate and still be the one nobody wants replanned on a Friday. The
gate catches mistakes, the classification only orders the work.

An agent driving this is fast at the mechanical part and no better than the
runbook at the judgement part. It will happily prepare a migration for a stack
that should have been held, which is why holding is the default and why the
confirmation steps are not optional.

## What’s next?

A migrated repository is correct and considerably harder to read. `ls` stops
being an answer to “what do we have”, because the answer is now spread across
accounts and regions.
[Listing every Terramate stack and where it runs](/blog/posts/listing-every-terramate-stack-and-where-it-runs/)
covers getting that overview back by asking Terramate’s own packages what
exists, rather than reading the tree.
