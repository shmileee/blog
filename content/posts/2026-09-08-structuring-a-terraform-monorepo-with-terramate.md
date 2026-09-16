---
title: Structuring a Terraform Monorepo With Terramate
description: A Terramate monorepo layout where a stack's path supplies its account, region and environment.
date: 2026-09-08 09:00:00
categories:
  - terraform
  - terramate
---

A repository layout for a Terraform monorepo managed with
[**Terramate**](https://terramate.io/docs/cli/), where a stack's position in the
tree supplies its account, its region and its environment. It covers the three
directories that carry code, what a single stack directory holds, how change
detection reads the layout, and the conventions that keep a tree of several
hundred stacks workable. This is the first post in a series on Terraform and
Terramate.

With this layout, adding a stack is one command and no copied files. The
backend block, the provider blocks and the shared globals arrive from imports,
and the only hand-written file in the new directory is the one that calls
modules.

The commands below were run against a scratch repository built for this post
with Terramate 0.17.2 and Terraform 1.15.8. The layout itself comes from a
private monorepo of 508 stacks and 95 modules, so account names and profiles
are placeholders.

## The Layout Problem

The default layout for multi-account Terraform is a directory per environment
with the same files copied into each: `development/`, `staging/` and
`production/`, each holding its own `backend.tf`, `providers.tf` and `main.tf`.
It is fine at three environments and one account.

At tens of accounts three things go wrong. Every shared change becomes an
N-file edit, so the AWS provider version, the default tags and the backend
settings drift apart silently. The interesting difference between two
environments, usually a handful of variables, is buried in a diff of otherwise
identical files. And the facts that decide where a stack applies are literal
strings in every copy: the account identifier, the AWS profile, the state
bucket. Those
are exactly the values a copy-paste gets wrong in the direction of production.

A fourth problem is orchestration. Running `terraform plan` across a few
hundred root modules is not free, so continuous integration needs to know
which ones a pull request can affect. With copied files that signal is
whatever `git diff --name-only` happens to return, and a change to a shared
input is invisible.

What the tree should do instead is carry the per-stack facts in its own shape,
and generate everything that is shared. Terramate's
[stacks](https://terramate.io/docs/cli/stacks/) and
[code generation](https://terramate.io/docs/cli/code-generation/) are built for
exactly that split.

## Three Directories That Matter

Everything that holds Terraform code goes in one of three places, and the rule
for each is short:

| Directory | Holds | Rule |
| --- | --- | --- |
| `stacks/` | every root module Terramate manages | one stack is one directory containing `stack.tm.hcl` |
| `modules/` | reusable modules the stacks call | referenced by relative path from inside the repository |
| `stacks/imports/` | shared `*.tm.hcl` fragments | the only place a `generate_hcl` block lives |

Auxiliary directories sit beside them: `templates/` for scaffolding, `scripts/`
for repository automation, `docs/` for the rendered documentation. A repository
that predates Terramate usually also carries a frozen legacy tree, which is
simpler to leave in place and migrate stack by stack than to convert in one
commit.

Keeping `modules/` in the same repository is what makes change detection
transitive. Terramate parses the `module` blocks in a stack's `*.tf` files and
follows local sources, so a commit that touches nothing but a module marks the
stacks that call it as changed:

```bash
git switch -c feat/change-validation-method
# edit modules/acm-certificate/main.tf, nothing else

terramate list --changed
# stacks/aws/acme-development/eu-west-1/acm
```

A module reference that resolves outside the project root is skipped with a
warning, and a module pulled from a registry cannot be diffed at all. Both mean
the same thing: code that stacks depend on belongs inside the tree, or
continuous integration plans the wrong set of stacks.

## Path as Identity

Terramate globals are defined per directory and inherited by everything below,
so the directory a file sits in decides its scope. That turns the path into the
declaration:

```text
stacks/
├── config.tm.hcl                     repo-wide globals
├── imports/                          shared generators
│   ├── 000_terraform.tm.hcl          the S3 backend
│   └── 001_providers.tm.hcl          the providers
├── aws/
│   ├── aws.tm.hcl                    imports the generators
│   └── acme-development/
│       ├── account.tm.hcl            account id, AWS profile, environment
│       └── eu-west-1/
│           ├── region.tm.hcl         region name
│           └── acm/                  a stack
└── saas/                             stacks with no AWS account of their own
```

The two intermediate files are the whole mechanism. An account directory states
what is true of every stack in that account:

```hcl title="stacks/aws/acme-development/account.tm.hcl"
globals {
  environment        = "development"
  account_name       = "acme-development"
  aws_config_profile = "acme-development"
}
```

A region directory states the region, and pulls in the provider defaults that
depend on it:

```hcl title="stacks/aws/acme-development/eu-west-1/region.tm.hcl"
globals {
  region_name = "eu-west-1"
}

import {
  source = "/stacks/imports/aws/provider.tm.hcl"
}
```

A stack three levels down declares none of this, which makes moving one a
`git mv` followed by a regeneration:

```bash
git mv stacks/aws/acme-development/eu-west-1/acm-v2 \
       stacks/aws/acme-production/eu-west-1/acm-v2
terramate generate
# [~] 000_terramate_generated_terraform.tf
# [~] 001_terramate_generated_providers.tf

grep -E 'bucket|key ' stacks/aws/acme-production/eu-west-1/acm-v2/000*.tf
#     bucket         = "tf-state-euw1-222222222222"
#     key            = "terraform/stacks/by-id/a55dd02a-628e-4dc6-89a7-2fb83537a9c2/terraform.tfstate"
```

The bucket, the AWS profile and the environment tag all follow the new path.
The state key does not, because it is derived from the stack's
Terramate-assigned identifier rather than its location, so moving a stack
between accounts rewrites its wiring without migrating its state.

## Stack Anatomy

A stack directory holds exactly three kinds of file: the marker, the generated
files, and the Terraform someone wrote.

```text
stacks/aws/acme-development/eu-west-1/acm/
├── stack.tm.hcl                          the marker
├── 000_terramate_generated_terraform.tf  backend, from imports
├── 001_terramate_generated_providers.tf  providers, from imports
└── main.tf                               module calls, hand written
```

The marker is a `stack` block carrying a name, a description and an identifier:

```hcl title="stacks/aws/acme-development/eu-west-1/acm-v2/stack.tm.hcl"
stack {
  name        = "acm-v2"
  description = "acm-v2"
  id          = "a55dd02a-628e-4dc6-89a7-2fb83537a9c2"
}
```

`terramate create` writes it, identifier included:

```bash
cd stacks/aws/acme-development/eu-west-1
terramate create acm-v2
# Created stack /stacks/aws/acme-development/eu-west-1/acm-v2

ls -1 acm-v2
# 000_terramate_generated_terraform.tf
# 001_terramate_generated_providers.tf
# stack.tm.hcl
```

The generated files are there because `terramate create` also runs code
generation, so a new stack arrives with its backend and providers already
written from the imports above it.

The numeric prefixes keep that listing stable and say where each file came from:
`000` for the backend, `001` to `099` for shared imports, `100` and up for
per-stack generators. Nothing in these files is edited by hand. They are
regenerated from the `*.tm.hcl` sources and committed, which keeps
`terraform plan` working from a plain checkout.

The ratio that results is the argument for the whole layout. Counting the
repository this comes from: 15 files in `stacks/imports`, **2,040 lines** of
generator, produce **1,954 files and 63,618 lines** of Terraform across 508
stacks. None of it is reviewed line by line, because none of it was written by
anyone.

## Keeping the Tree Honest

Committed generated code is only trustworthy if generation is enforced.
`terramate generate` runs in pre-commit, filtered to `^stacks/.*/.*\.tm\.hcl$`,
and again in continuous integration with `--detailed-exit-code`, which returns 0
when nothing changed, 2 when it wrote something, and 1 on error:

```bash
terramate generate --detailed-exit-code
# Nothing to do, generated code is up to date
# after a hand edit: [~] 001_terramate_generated_providers.tf, exit code 2
```

There, exit code 2 is the failure condition: the generated code on the branch
does not match its declarations. Formatters and hooks skip the output entirely,
which is what the marker in the filename is for:

```yaml title=".pre-commit-config.yaml"
exclude: >
  (?x)^(
    .*/.*terramate_generated_.*\.tf$|
    \.terraform/.*
  )$
```

Scaffolding needs one more guard. A `cookiecutter` template for a stack contains
a `stack.tm.hcl` with placeholders in it, and Terramate walks the whole tree, so
every command that reads stacks fails on it, `generate` included:

```text
terramate list
# Error: listing changed stacks error: searching for stacks: validating stack fields: "stack.id" "{{cookiecutter.stack_id}}" doesn't match "^[a-zA-Z0-9_-]{1,64}$"
```

An empty `.tmskip` file in `templates/` takes the directory out of the walk and
the command works again.

Tool versions belong under the same discipline, since the output of
`terramate generate` depends on the binary that produced it. Pin Terramate and
Terraform in the repository with [mise](https://mise.jdx.dev/) or an equivalent,
rather than leaving them to whatever each engineer installed; the setup is in
[Mise: Faster, Smarter Tool Versioning](/blog/posts/mise-faster-smarter-tool-versioning/).

## Limitations

The nesting that makes the path meaningful also makes the tree hard to read. A
stack lives five or six levels down, and the only practical way to see what
exists is `terramate list` or a fuzzy finder over its output.

Change detection is based on what is inside a stack directory, so a change to a
shared import marks a stack as changed only when the generated output actually
changes. Editing a comment in an import and regenerating leaves
`terramate list --changed` empty. That keeps the pipeline quiet, and it also
means the import edit itself is not the trigger, the regenerated file is.

The layout assumes a stack belongs to one account and one region. A stack that
spans two accounts has to pick a home directory, which also picks its state
bucket, and that choice is a convention rather than something the tree enforces.

Finally, this is a target, not a migration path. An existing flat repository
converts one stack at a time, and the legacy tree coexists with the new one for
as long as that takes.

## What's Next?

The generators referenced above are where the layout pays off, and they need one
thing the tree cannot give them: credentials.
[One Terraform Module for Provider Credentials](/blog/posts/one-terraform-module-for-provider-credentials/)
covers the module every stack reads them through, and
[Generating Terraform Providers With Terramate](/blog/posts/generating-terraform-providers-with-terramate/)
takes apart the generator that wires the two together. For the version
constraints those generators emit, see
[Terraform Version Constraints](/blog/posts/terraform-version-constraints-striking-the-right-balance/).
