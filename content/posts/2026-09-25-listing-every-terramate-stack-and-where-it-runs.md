---
title: Listing every Terramate stack and where it runs
description: The nested layout hides what exists, so rebuild the overview from Terramate’s own packages.
date: 2026-09-25 09:00:00
categories:
  - terraform
  - terramate
---

An inventory of every stack in a Terramate repository and where each one is
deployed, assembled from the same packages the `terramate` command uses rather
than from the directory tree. It is the sixth post in a series on Terraform and
Terramate, after
[Migrating Terraform stacks to Terramate with an agent](/blog/posts/migrating-terraform-stacks-to-terramate-with-an-agent/).

The inventory program was written and run against a scratch repository with
Terramate 0.17.3 and Terraform 1.15.8; account names are placeholders.

## What the deep tree costs

The migration trades one problem for another. `app/<stack>/<env>/` was two
levels deep and `ls` was a complete inventory. The Terramate layout is
`stacks/aws/<account>/<region>/<stack>`, five or six levels down, and the same
stack name exists several times over:

<figure class="concept-diagram" data-concept-diagram>
  <div class="diagram-exhibit" data-exhibit role="img"
       aria-label="Before: app slash foundation slash development, three path segments, one directory per environment. After: stacks slash aws slash acme-production slash us-east-1 slash foundation, five path segments, one directory per deployment">
    <div class="diagram-exhibit-label">BEFORE · ONE DIRECTORY PER ENVIRONMENT</div>
    <div>
      <span>app</span><i aria-hidden="true">/</i>
      <span>foundation</span><i aria-hidden="true">/</i>
      <span>development</span>
    </div>
    <div class="diagram-exhibit-label diagram-exhibit-label-secondary">AFTER · ONE DIRECTORY PER DEPLOYMENT</div>
    <div>
      <span>stacks</span><i aria-hidden="true">/</i>
      <span>aws</span><i aria-hidden="true">/</i>
      <span>acme-production</span><i aria-hidden="true">/</i>
      <span>us-east-1</span><i aria-hidden="true">/</i>
      <span>foundation</span>
    </div>
  </div>
  <figcaption class="exhibit-caption">Three segments become five: the environment folds into the account name, the region appears, and the stack name becomes the leaf.</figcaption>
</figure>

The tree is better for everything a machine does with it and worse for every
question a person asks of it. "Where does `foundation` run" was a directory
listing and is now a search with a mental model attached. The repository this
comes from has **508 stack directories that resolve to 223 distinct stack
names**, and its most duplicated name exists in 20 places at once.

What a person wants is the inverse of the tree: one row per stack identity, with
its deployments underneath.

<figure class="concept-diagram wide" data-concept-diagram>
  <div class="diagram-exhibit" data-exhibit>
    <svg viewBox="0 0 640 208" role="img" aria-label="One stack identity named foundation fans out to three deployments: development in eu-west-1, production in eu-west-1, and production in us-east-1">
      <defs>
        <marker id="mig-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--color-border)" />
        </marker>
      </defs>
      <rect x="8" y="80" width="170" height="48" rx="6" fill="var(--color-accent-surface)" stroke="var(--color-accent-border)" />
      <text x="93" y="100" text-anchor="middle" font-family="var(--font-mono)" font-size="13" fill="var(--color-accent)">foundation</text>
      <text x="93" y="117" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">1 identity</text>
      <path d="M178 104 C 220 104, 220 32, 262 32" stroke="var(--color-border)" fill="none" marker-end="url(#mig-arrow)" />
      <path d="M178 104 H 262" stroke="var(--color-border)" fill="none" marker-end="url(#mig-arrow)" />
      <path d="M178 104 C 220 104, 220 176, 262 176" stroke="var(--color-border)" fill="none" marker-end="url(#mig-arrow)" />
      <rect x="264" y="8" width="368" height="48" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="280" y="28" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">development</text>
      <text x="280" y="45" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">acme-development · eu-west-1</text>
      <rect x="264" y="80" width="368" height="48" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="280" y="100" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">production</text>
      <text x="280" y="117" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">acme-production · eu-west-1</text>
      <rect x="264" y="152" width="368" height="48" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="280" y="172" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">production</text>
      <text x="280" y="189" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">acme-production · us-east-1</text>
    </svg>
  </div>
  <figcaption class="exhibit-caption">The view a person wants: identity on the left, every deployment of it on the right, grouped by environment.</figcaption>
</figure>

## Building the inventory

Producing that view needs the account, region and environment of every stack,
and those are not in the path alone: they are globals, inherited from wherever
they were declared. Shelling out to the command and parsing its output gets
the paths but not the evaluated values, so the better route is the library
that command is built on. Four calls do the work:

```go
rootdir, err := findRoot(".")            // walk up to terramate.tm.hcl
root, err := config.LoadRoot(rootdir, false)
entries, err := stack.List(root, root.Tree())

for _, e := range entries {
    g := globals.ForStack(root, e.Stack)
    fmt.Println(e.Stack.Dir,
        str(g.Globals, "account_name"), str(g.Globals, "environment"))
}
```

`globals.ForStack` returns the fully evaluated globals for one stack, the same
evaluation code generation uses, so a stack whose `environment` global says
`production` while its path says otherwise reports `production`. Reading a
single value out is a key-path lookup that returns a `cty` value, so a small
`str` helper is worth writing once.

Two practical notes. The library logs through `zerolog` at debug level, so
`zerolog.SetGlobalLevel(zerolog.Disabled)` belongs at the top of `main`. And
`findRoot` walking up to `terramate.tm.hcl` makes the tool runnable from any
stack directory, which matters more than it sounds: the question is usually
asked from deep inside the tree.

Under a hundred lines, that is a complete non-interactive inventory:

```text
STACK                                         ACCOUNT           REGION     ENV
/stacks/aws/acme-development/eu-west-1/acm    acme-development  eu-west-1  development
/stacks/aws/acme-production/eu-west-1/acm-v2  acme-production   eu-west-1  production
/stacks/saas/github                           -                 -          operations
/stacks/teams/team-payments                   acme-operations   eu-west-1  operations
/stacks/teams/team-platform                   acme-operations   eu-west-1  operations
```

## The explorer

I built the tool I use for this and called it `terramate-stacks-explorer`. It
is an in-house Go binary rather than something you can install, so what follows
is what it does and what it needs.

It has two views over the same data. The default one is by identity, which is
the question the deep tree makes hard to answer:

```text
terramate-stacks-explorer --format table
# STACK             COUNT  GROUPS  ENVIRONMENTS                      REGIONS
# ----------------  -----  ------  --------------------------------  -------
# acm               4      acme    development, staging, production  eu-west-1, us-east-1
# eks-cluster       4      acme    development, staging, production  eu-west-1, us-east-1
# foundation        4      acme    development, staging, production  eu-west-1, us-east-1
# networking        2      acme    development, production           eu-west-1
# ... 8 more ...
# 12 distinct stacks across 22 deployments
```

The other view is by deployment, one row per place a stack actually runs, and
both views take the same `--group`, `--env` and `--region` filters:

```text
terramate-stacks-explorer --view deployments --env production --format table
# STACK         GROUP  ACCOUNT          REGION     ENVIRONMENT
# ------------  -----  ---------------  ---------  -----------
# acm           acme   acme-production  eu-west-1  production
# acm           acme   acme-production  us-east-1  production
# foundation    acme   acme-production  eu-west-1  production
# ... 5 more ...
# 8 deployments
```

`--values` prints the dimensions themselves with counts, which is how you
learn what a repository contains before you know what to filter on, and
`--format json` emits every field the loader resolved, including the account
identifier, the AWS profile, the Terraform version constraint and the stack’s
identifier: an inventory a script can consume, rather than a `find` command
with conventions baked into it.

### What it needs from the repository

The tool is thin because the repository does the work, and that only holds if
four things are true.

It needs a Terramate project root above the working directory. `findRoot`
climbs until it sees `terramate.tm.hcl`, and says so when it does not:

```text
cd /tmp && terramate-stacks-explorer --format table
# error: no terramate.tm.hcl found from /tmp upward
```

It needs stacks Terramate itself can see, which means the same walk that
`terramate list` does, `.tmskip` and all. And it needs a git repository, because
the last commit and the history count per stack come from `git log` scoped to
the stack directory.

And it needs the globals to be named the way the layout in
[part one](/blog/posts/structuring-a-terraform-monorepo-with-terramate/) names
them: `account_name`, `region_name`, `environment`, `aws_config_profile`. Those
four are the tool’s entire contract with the repository. A stack that omits one
is not an error, it just has less to show. A SaaS stack with no AWS region
reports `-` for region and falls back to the path segment for its account:

```text
# STACK             GROUP  ACCOUNT           REGION     ENVIRONMENT
# github            saas   saas              -          operations
```

The inventory is only as good as the globals, which is an argument for setting
them at the account and region level, once, rather than per stack.

### The terminal user interface

Three things make the interactive version worth the extra work, none of which a
table can do: fuzzy filtering by account, region or environment; grouping
deployments under one identity in lifecycle order rather than alphabetically;
and acting on a selection, where opening a subshell in the stack’s directory
turns “where does this run” into “put me there”.
[Bubble Tea](https://github.com/charmbracelet/bubbletea) is the obvious toolkit
in Go, and keeping the inventory a plain list underneath keeps `--format json`
usable for scripting.

Recorded against a mock repository of 22 deployments, it looks like this:

<figure class="media-figure media-figure-wide wide">
  <div class="media-frame media-frame-dark">
    <video
      src="/blog-static/terramate-stacks-explorer.mp4"
      poster="/blog-static/terramate-stacks-explorer-poster.webp"
      width="1400"
      height="800"
      controls
      playsinline
      preload="metadata"
      aria-label="Terminal recording: a UI listing twelve distinct stacks; selecting one shows its four deployments grouped by environment, then the inventory is filtered to production and fuzzy-searched for eks"
    ></video>
  </div>
  <figcaption>Twelve identities, 22 deployments: browse, filter to one environment, search, then act on the selection.</figcaption>
</figure>

It opens on what the inventory contains, counted: groups, environments, regions,
accounts. After that the left pane is one row per identity with a deployment
count, the right pane is every deployment of the selected one, and the header
carries the active filters. Nothing in it knows about Terraform; it is the four
calls above plus a list, a detail pane and three pickers.

## Limitations

An inventory built on the library is coupled to it. `config.LoadRoot`,
`stack.List` and `globals.ForStack` are internal-facing interfaces that move
between Terramate releases, so the tool pins the version it was built against
and upgrades deliberately. Shelling out to `terramate list` is the slower,
more stable alternative.

Evaluating globals for every stack is not free. It is fast enough at a few
hundred stacks when the work is spread across goroutines, but it is real work
per stack, not a directory walk.

The inventory reports what the globals say, which is the same thing code
generation acts on, and neither of them knows what is actually deployed. A stack
whose globals say `production` and whose last apply was six months ago looks
identical here to one applied this morning. The git history column is the
closest thing to an answer, and it only reports on the code.

## What’s next?

Every post in this series so far assumes the declarations are right: a stack
names its providers, a descriptor names its platforms, a global names its
account. A later post covers what happens when one of them is wrong, and why a
generator is the right place to refuse: `assert` blocks, and the version
contracts they let a shared generator enforce before Terraform ever runs.
