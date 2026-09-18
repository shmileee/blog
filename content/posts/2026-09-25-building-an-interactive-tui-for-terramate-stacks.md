---
title: Building an interactive TUI for Terramate stacks
description: A terminal UI that answers “where does this stack run?” in a Terramate monorepo with hundreds of stacks.
date: 2026-09-25 09:00:00
categories:
  - terraform
  - terramate
---

After the migration, the repository knew exactly where every stack ran, and I
no longer did. The same stack name now lives in several accounts and regions,
five directory levels down, and finding all of them is a search rather than a
directory listing. So I built a small terminal tool that lists every stack,
shows where each one runs, and puts me in its directory.

> [!NOTE] Series and versions
>
> Fifth post in a series on Terraform and Terramate, after
> [Migrating Terraform stacks to Terramate with an agent](/blog/posts/migrating-terraform-stacks-to-terramate-with-an-agent/).
> The tool is an in-house Go program, shown here against a scratch repository
> with Terramate 0.17.3 and Terraform 1.15.8; account names are placeholders.

## What the deep tree costs

[The first post](/blog/posts/structuring-a-terraform-monorepo-with-terramate/)
made the path carry the facts: a stack lives at
`stacks/aws/<account>/<region>/<stack>`, and its directory tells it which
account, region and environment it belongs to.
[The migration](/blog/posts/migrating-terraform-stacks-to-terramate-with-an-agent/)
moved every legacy `app/<stack>/<env>/` directory into that shape. Both are
right for the machine, and together they cost the person something:

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

With a dozen stacks the cost is nothing. The repository this comes from has
roughly five hundred stack directories, about two hundred distinct stack names
among them, and its most common name exists in around twenty places at once. At
that size “where does `foundation` run” is no longer `ls app/`; it is a `find`
over the tree, or a mental model of it. What a person wants is the inverse of
the tree: one row per stack name, with every place it runs underneath:

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

I built a small Go program for this and called it `terramate-stacks-explorer`.
It has two faces. Run plainly, it prints a table: one row per stack, with the
account, region and environment it runs in. Run interactively, it is a terminal
UI over the same list, with filters, a detail pane and a way to jump into a
stack’s directory. This section is about where the list comes from; the next
one is about the UI.

The difficult part is not walking directories. Account, region and environment
are not written in a stack’s path; they are globals, declared once in
`account.tm.hcl` and `region.tm.hcl` and inherited downward, and a stack can
override any of them. The only thing that knows their final value for a given
stack is Terramate’s own evaluation, the one code generation runs.

Terramate is written in Go, and the `terramate` command is built from packages
a Go program can import. So instead of running `terramate list` and parsing its
output, which gives the paths but not the values, the tool imports three of
those packages, `config`, `stack` and `globals`, and asks them directly. Three
calls do the work:

```go title="main.go"
// The repository, from the directory that holds terramate.tm.hcl.
root, err := config.LoadRoot(rootdir, false)

// Every stack Terramate can see, the set `terramate list` prints.
entries, err := stack.List(root, root.Tree())

// One stack's globals, fully evaluated: inherited and overridden.
for _, e := range entries {
    g := globals.ForStack(root, e.Stack)
    fmt.Println(e.Stack.Dir,
        str(g.Globals, "account_name"),
        str(g.Globals, "region_name"),
        str(g.Globals, "environment"))
}
```

Because the values come from the same evaluation code generation uses, a stack
whose `environment` global says `production` while its path says otherwise
reports `production`. A global comes back as a typed value, so `str` turns it
into text and prints `-` for a key the stack does not define. With a header and
aligned columns on top, that is the whole non-interactive inventory, in under a
hundred lines:

```text
STACK                                         ACCOUNT           REGION     ENV
/stacks/aws/acme-development/eu-west-1/acm    acme-development  eu-west-1  development
/stacks/aws/acme-production/eu-west-1/dns     acme-production   eu-west-1  production
/stacks/saas/github                           -                 -          operations
/stacks/teams/team-payments                   acme-operations   eu-west-1  operations
/stacks/teams/team-platform                   acme-operations   eu-west-1  operations
```

## The terminal UI

The table answers the question once. The interactive version is for the way
the question is actually asked, several times in a row, narrowing as it goes.
It opens on what the inventory contains, counted: environments, regions,
accounts. The left pane is one row per stack name with a deployment count; the
right pane is every deployment of the selected one, grouped by environment with
development before staging before production; the header carries the active
filters. Fuzzy search narrows the list as you type, and selecting a deployment
opens a shell in its directory, which turns “where does this run” into “put me
there”. It is built with [Bubble Tea](https://github.com/charmbracelet/bubbletea),
the usual toolkit for this in Go, over the same list the table prints.

Recorded against a mock repository of 22 deployments:

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

The same views exist without the UI, for scripts and for a quick look. By
stack name:

```text
terramate-stacks-explorer --format table
# STACK        COUNT  ENVIRONMENTS
# acm          4      development, staging, production
# eks-cluster  4      development, staging, production
# foundation   4      development, staging, production
# networking   2      development, production
# ... 8 more ...
# 12 distinct stacks across 22 deployments
```

By deployment, one row per place a stack actually runs, with the same `--env`
and `--region` filters the UI has:

```text
terramate-stacks-explorer --view deployments --env production \
  --format table
# STACK       ACCOUNT          REGION     ENVIRONMENT
# acm         acme-production  eu-west-1  production
# acm         acme-production  us-east-1  production
# foundation  acme-production  eu-west-1  production
# ... 5 more ...
# 8 deployments
```

`--format json` prints every field the loader resolved, account identifier,
AWS profile and stack identifier included, for anything that wants the
inventory as data rather than as a `find` command with conventions baked in.

The tool is thin because the repository does the work, which holds on three
conditions. It runs from anywhere inside a Terramate project and finds the
root by climbing to `terramate.tm.hcl`. It sees the stacks Terramate itself
sees, `.tmskip` and all. And it expects the four globals the layout in
[part one](/blog/posts/structuring-a-terraform-monorepo-with-terramate/) names,
`account_name`, `region_name`, `environment` and `aws_config_profile`; those
are its entire contract with the repository. A stack that omits one is not an
error, it just shows `-`, as the `saas/github` row above does for account and
region.

## Limitations

Importing Terramate’s packages couples the tool to them. They are not a public
API and move between releases, so the tool pins the Terramate version it was
built against and upgrades deliberately. Shelling out to `terramate list` is
the slower, more stable alternative for the paths, though not for the values.

Evaluating globals for every stack is real work per stack, not a directory
walk. It is fast enough at a few hundred stacks when spread across goroutines.

The inventory reports what the globals say, which is what code generation acts
on, and neither knows what is actually deployed. A stack applied this morning
and one last applied six months ago look identical here; the git history of
the directory is the closest thing to an answer, and it only reports on the
code.

## What’s next?

Every post in this series so far assumes the declarations are right: a stack
names its providers, a descriptor names its platforms, a global names its
account. A later post covers what happens when one of them is wrong, and why a
generator is the right place to refuse: `assert` blocks, and the version
contracts they let a shared generator enforce before Terraform ever runs.
