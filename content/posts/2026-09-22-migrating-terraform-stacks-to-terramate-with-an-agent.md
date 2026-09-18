---
title: Migrating Terraform stacks to Terramate with an agent
description: One stack at a time, move the code, copy the state, and let an empty plan prove nothing changed. Boring enough to hand to an agent.
date: 2026-09-22 09:00:00
categories:
  - terraform
  - terramate
---

The layout in this series is a target. Getting an existing repository there is
one stack at a time: move the code, copy the state object, and prove with a
plan that nothing changed. Every step is mechanical and the proof is one line
of output, which is why the last section hands the procedure to an agent.

> [!NOTE] Series and versions
>
> Fourth post in a series on Terraform and Terramate, after
> [Generating Terraform for teams from one JSON file](/blog/posts/generating-terraform-for-teams-from-one-json-file/).
> Terramate 0.17.3 and Terraform 1.15.8. The procedure comes from a private
> monorepo where most of the legacy stacks have moved this way; buckets, keys
> and account names are placeholders.

## Why one stack at a time

The legacy layout is `app/<stack>/<env>/`, each directory with its own backend
block and a state key derived from its own path. That key is what ties a
directory to the resources it manages, so converting the whole tree at once
has every stack planning against a key that does not exist yet, and no
rollback smaller than one large revert. Per stack, a failed migration is one
pull request to close.

Not every stack is equally safe to move first:

| Class | Signals | Action |
| --- | --- | --- |
| Go | single AWS context, no remote-state coupling, rarely changes | migrate now |
| Review | several provider aliases, git-ref module sources, provider major differs from the generated constraint | migrate with care |
| Hold | reads or is read via `terraform_remote_state`, owns shared networking or DNS, inline secrets in `*.tf` | migrate later, as a group |

A `terraform_remote_state` producer and its consumers move together, or the
producer first; otherwise the consumer keeps reading a snapshot that is no
longer updated.

## Move the code, copy the state

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

The moved `main.tf` loses its `provider` and backend blocks, which the
generators now emit, and every relative module source gains the `../` segments
the deeper path costs. What stays is the module calls and any stack-local
resources.

The state copy is a plain S3 object copy between the old key and the generated
one, guarded on both sides:

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

Copying rather than moving keeps the migration reversible: revert the pull
request and the legacy directory resumes planning against its untouched key,
with the copy left behind as an orphan. Comparing `ETag` and `ContentLength`
on both objects is a cheap check that the copy is complete.

## The plan gate

With the state copied byte for byte and the code moved rather than rewritten,
the plan on the pull request refreshes every resource in the copied state,
compares it with the moved configuration, and should find nothing to do:

```text
No changes. Your infrastructure matches the configuration.
```

Anything else means stop. In practice it is one of two things: the generated
provider constraint resolves to a different major version than the legacy lock
file, which is fixed in the declaration and never by upgrading to clear a diff;
or a global resolved from the new path, the profile or the region, is not the
one the legacy stack used, so the plan fails to authenticate or wants to
recreate everything somewhere else. Rarer causes are a renamed provider alias,
a module source off by one `../`, and path-sensitive functions such as
`file()` or `path.root` now evaluated from a different directory. Each
produces a plan that looks like an infrastructure change and is not.

The legacy directory is deleted in the same pull request, and it has to be the
whole directory: a pipeline that discovers projects by directory will still
find an empty one and fail to initialise it.

## Handing it to an agent

A runbook whose steps never vary is a script with prose formatting, and this
one has the shape agents are good at: every input is in the repository, every
step is mechanical, and success is a diff shape rather than a judgement. So it
became a skill, a Markdown file an [OpenCode](https://opencode.ai) agent loads
on demand, with the steps above and the rules it may not negotiate:

- **Hold by default.** A stack migrates only if the classification clears it;
  anything coupled or high-blast-radius is reported and left to a person.
- **Copy state, never move it.** No `terraform state mv`, no deleting the
  legacy object.
- **Never apply locally.** `terramate generate`, `terraform fmt` and read-only
  `aws s3api` calls; nothing else.
- **Match provider versions exactly.** Never upgrade a major to clear a diff.
- **An empty plan is the gate.** Anything else stops the run.
- **Confirm before opening a pull request, and before every apply.**

Each rule closes off a shortcut that would look reasonable to an agent halfway
through a migration.

Plans and applies run through [Atlantis](https://www.runatlantis.io/), which
plans when a pull request opens and applies when someone comments on it. That
fixes two things about the procedure: the state copy lands before the pull
request opens, and the agent prepares but never applies. It opens the pull
request, reads the plan against the gate, and asks; approval comes from a
different identity than the one that wrote the branch. Applying is one comment
per stack directory, in sequence, because a single comment naming several
directories does not work once a pull request carries more than one project:

```bash
gh pr comment "$PR" \
  --body "atlantis apply -d stacks/aws/<account>/<region>/<stack>"
gh pr checks "$PR" --watch
```

Running several migrations at once is where the agent pays off. One git
worktree per stack, outside the repository so neither Terramate nor Atlantis
scans it, each with its own branch, pull request and agent:

```bash
git worktree add ../migrate-<stack> -b migrate/<stack>-to-terramate
```

The paths each migration touches are disjoint and the shared imports are never
edited, so the runs collide on exactly one file: every migration edits
`CODEOWNERS` to drop the legacy directory it deleted, and the first one to
merge leaves the others with a conflict there. Rebase and re-plan; it is
mechanical, and worth knowing before three agents report the same failure at
once.

## Limitations

An empty plan proves that the copied state, the moved code and what is
deployed agree. It does not prove the legacy directory has stopped being
applied; freeze it once its object is copied, and delete it in the migration
pull request.

The state copy needs credentials for the destination account, so that step
stays on a workstation. Everything else is a pull request.

The classification is advisory. It reads proxies, and a stack can look like a
clean candidate and still be the one nobody wants replanned on a Friday. The
gate catches mistakes; the classification only orders the work.

An agent is fast at the mechanical part and no better than the runbook at the
judgement part. That is why holding is the default and the confirmations are
not optional.

## What’s next?

A migrated repository is correct and harder to read: the same stack name now
lives in several accounts and regions, five directory levels down.
[Building an interactive TUI for Terramate stacks](/blog/posts/building-an-interactive-tui-for-terramate-stacks/)
is the tool I built to get the overview back.
