---
title: Structuring a Terraform monorepo with Terramate
description: A Terramate monorepo layout where a stack’s path supplies its account, region and environment.
date: 2026-09-08 09:00:00
categories:
  - terraform
  - terramate
---

Adding a Terraform stack should take one command and no copied files. The
layout below makes that true: the directory a stack lives in tells it which
account, region and environment it belongs to, and everything a stack would
otherwise copy from its neighbour is generated.

> [!NOTE] Series and versions
>
> First post in a series on Terraform and
> [Terramate](https://terramate.io/docs/cli/). Examples were run with Terramate
> 0.17.3 and Terraform 1.15.8 against a scratch repository; account names and
> profiles are placeholders.

## The layout problem

The usual layout for multi-account Terraform is a directory per environment
with the same files copied into each: `development/`, `staging/` and
`production/`, each holding its own `backend.tf`, `providers.tf` and `main.tf`.
It is fine at three environments and one account.

At tens of accounts three things go wrong. Every shared change becomes an
N-file edit, so the AWS provider version and the backend settings drift apart
silently. The interesting difference between two environments, usually a
handful of variables, is buried in a diff of otherwise identical files. And the
facts that decide where a stack applies are literal strings in every copy: the
account identifier, the AWS profile, the state bucket. Those are exactly the
values a copy-paste gets wrong in the direction of production.

A fourth problem is orchestration. Running `terraform plan` across a few
hundred root modules is not free, so continuous integration needs to know
which ones a pull request can affect. With copied files that signal is
whatever `git diff --name-only` happens to return, and a change to a shared
input is invisible.

What the tree should do instead is carry the per-stack facts in its own shape,
and generate everything that is shared.

## What Terramate adds

Terramate is a thin layer over an ordinary Terraform repository. It does not
replace Terraform or wrap its state; it adds four ideas, and the whole layout
is built from them.

A **stack** is one root module and its directory, marked by a `stack.tm.hcl`
file. Terramate lists stacks, runs Terraform in them, and works out which of
them a change affects.

**Globals** are values declared in a `.tm.hcl` file for a directory and
everything below it. A value declared at the account level is visible in every
stack of that account; a value declared at the region level in every stack of
that region. A stack inherits its configuration from where it sits.

**Code generation** turns those values into Terraform. A `generate_hcl` block
is a template: it renders one `.tf` file into every stack under it, reading
globals and stack metadata as it goes. The output is committed next to the
hand-written code, so `terraform plan` sees an ordinary root module.

**Imports** make the first three reusable. A generator or a shared declaration
is written once, in a file under `stacks/imports/`, and an `import` block pulls
it into a directory. That is why the shared things live in one folder: a change
to the backend template or to the AWS provider defaults is one edit in one
file, and every subtree that imports it picks the change up on the next
`terramate generate`.

The rest of this post is those four ideas placed in a tree.

## Three directories that matter

Everything that holds Terraform code goes in one of three places, and the rule
for each is short:

| Directory | Holds | Rule |
| --- | --- | --- |
| `stacks/` | every root module Terramate manages | one stack is one directory containing `stack.tm.hcl` |
| `modules/` | reusable modules the stacks call | referenced by relative path from inside the repository |
| `stacks/imports/` | shared `*.tm.hcl` fragments | the only place a `generate_hcl` block lives |

Modules stay in the same repository, and stacks call them by relative path
rather than through a registry. Part of the reason is change detection, which
the last section comes back to once a stack has been taken apart.

## Path as identity

Globals are inherited by everything below the directory that declares them,
so the directory a file sits in decides its scope. That turns the path into
the declaration:

```text
stacks/
├── imports/                          shared generators
│   ├── 000_terraform.tm.hcl          the S3 backend
│   └── 001_providers.tm.hcl          the providers
├── aws/
│   ├── aws.tm.hcl                    imports the generators
│   └── acme-development/
│       ├── account.tm.hcl            account id, profile, environment
│       ├── eu-west-1/
│       │   ├── region.tm.hcl         region name
│       │   └── acm/                  a stack
│       └── us-east-1/
│           └── region.tm.hcl
└── saas/                             stacks without an AWS account
```

`aws.tm.hcl` pulls the two generators into the subtree, so every stack below it
gets a backend file and a providers file. The backend generator is shown
below; the providers generator is the next post’s subject.

```hcl title="stacks/aws/aws.tm.hcl"
import {
  source = "/stacks/imports/000_terraform.tm.hcl"
}

import {
  source = "/stacks/imports/001_providers.tm.hcl"
}
```

The two files in between carry everything a stack inherits. An account
directory states what is true of every stack in that account:

```hcl title="stacks/aws/acme-development/account.tm.hcl"
globals {
  environment        = "development"
  account_name       = "acme-development"
  account_id         = "111111111111"
  aws_config_profile = "acme-development"
}
```

A region directory states the region, and pulls in the AWS provider
declaration that depends on it (the next post shows its contents):

```hcl title="stacks/aws/acme-development/eu-west-1/region.tm.hcl"
globals {
  region_name = "eu-west-1"
}

import {
  source = "/stacks/imports/aws/provider.tm.hcl"
}
```

The generators read those globals. The backend one is the smaller of the two:
the bucket belongs to the account, and the key to the stack’s identifier,
which `terramate create` assigns:

```hcl title="stacks/imports/000_terraform.tm.hcl"
generate_hcl "000_terramate_generated_terraform.tf" {
  content {
    terraform {
      backend "s3" {
        bucket       = "tf-state-euw1-${global.account_id}"
        key          = "terraform/stacks/by-id/${terramate.stack.id}/terraform.tfstate"
        region       = "eu-west-1"
        use_lockfile = true
      }
    }
  }
}
```

> [!NOTE] Where state lives is a choice
>
> Many teams keep all Terraform state in one dedicated account and bucket and
> reach it through cross-account IAM roles, which centralises access control,
> versioning and backups. Others keep a state bucket in each account, beside
> the resources it describes. This series uses a bucket per account, named for
> the account’s home region and its id, because it needs no cross-account role
> to demonstrate and keeps the examples short. The generator above is the only
> place that decision is written down, so changing it is one edit.

A stack three levels down declares none of this, so relocating one to another
region is a `git mv` followed by a regeneration:

```bash
git mv stacks/aws/acme-development/eu-west-1/acm \
       stacks/aws/acme-development/us-east-1/acm
terramate generate
# [~] 001_terramate_generated_providers.tf

grep region stacks/aws/acme-development/us-east-1/acm/001*.tf
#   region  = "us-east-1"
```

> [!NOTE] Reading the transcript
>
> `[~]` is Terramate’s mark for a file it rewrote; `[+]` marks a file it
> created and `[-]` one it removed.

The provider region follows the new path, and nothing in the stack directory
was edited. The backend file did not change at all: the bucket is the
account’s and the key is the stack’s, and the move touched neither, so no
state object moved either.

Moving a stack between accounts is a different case: the bucket changes, so
the state object has to be copied to the new bucket under the same key before
the first plan. That copy, and the checks around it, are the subject of
[Migrating Terraform stacks to Terramate with an agent](/blog/posts/migrating-terraform-stacks-to-terramate-with-an-agent/),
later in this series.

## Stack anatomy

A stack directory holds exactly three kinds of file: the marker, the generated
files, and the Terraform someone wrote.

```text
stacks/aws/acme-development/eu-west-1/dns/
├── stack.tm.hcl                          the marker
├── 000_terramate_generated_terraform.tf  backend, from imports
├── 001_terramate_generated_providers.tf  providers, from imports
└── main.tf                               module calls, hand written
```

The marker is a `stack` block carrying a name, a description and an identifier:

```hcl title="stacks/aws/acme-development/eu-west-1/dns/stack.tm.hcl"
stack {
  name        = "dns"
  description = "Route 53 zone and records for the public API"
  id          = "a55dd02a-628e-4dc6-89a7-2fb83537a9c2"
}
```

`terramate create` writes it, identifier included:

```bash
cd stacks/aws/acme-development/eu-west-1
terramate create dns
# Created stack /stacks/aws/acme-development/eu-west-1/dns

ls -1 dns
# 000_terramate_generated_terraform.tf
# 001_terramate_generated_providers.tf
# stack.tm.hcl
```

The generated files are there because `terramate create` also runs code
generation, so a new stack arrives with its backend and providers already
written from the imports above it. Nothing in these files is edited by hand.
They are regenerated from the `*.tm.hcl` sources and committed, which keeps
`terraform plan` working from a plain checkout, and continuous integration runs
`terramate generate --detailed-exit-code` to fail a branch whose committed
output is stale.

> [!IMPORTANT] File numbering
>
> Generated files carry a numeric prefix so that a stack directory lists in a
> stable order and each file says where it came from. The scheme is my
> convention, not Terramate’s:
>
> - `000` — the backend, from `stacks/imports/`.
> - `001`–`099` — provider configuration and other shared imports, also from
>   `stacks/imports/`.
> - `100` and up — files generated for one subtree only, such as the team
>   files a later post in this series generates from `stacks/teams/`.

The only file a person writes is `main.tf`: plain Terraform, calling modules by
relative path. For the `acm` stack that is one module, five levels up to the
repository root and back down into `modules/`:

```hcl title="stacks/aws/acme-development/eu-west-1/acm/main.tf"
module "certificate" {
  source      = "../../../../../modules/acm-certificate"
  domain_name = "api.example.com"
}
```

In the production repository this layout was first set up and tested in, about
fifteen generator files, some two thousand lines in all, produce close to two
thousand Terraform files and tens of thousands of lines across roughly five
hundred stacks. None of it is reviewed line by line, because none of it was
written by anyone.

## Change detection follows module calls

That relative path is also what makes change detection transitive. Terramate
compares the branch with the default branch, parses the `module` blocks in each
stack’s `*.tf` files and follows local sources, so a commit that touches
nothing but a module marks the stacks that call it as changed:

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

## What’s next?

The generators are where the layout pays off.
[Generating Terraform providers with Terramate](/blog/posts/generating-terraform-providers-with-terramate/)
takes apart the one that renders every stack’s provider blocks; the credentials
those blocks reference come from
[One Terraform module for provider credentials](/blog/posts/one-terraform-module-for-provider-credentials/),
a note that stands on its own and needs no Terramate to be useful.
