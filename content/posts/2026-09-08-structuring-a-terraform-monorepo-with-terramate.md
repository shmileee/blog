---
title: Structuring a Terraform monorepo with Terramate
description: A Terramate monorepo layout where a stack’s path supplies its account, region and environment.
date: 2026-09-08 09:00:00
categories:
  - terraform
  - terramate
---

A repository layout for a Terraform monorepo managed with
[**Terramate**](https://terramate.io/docs/cli/), where a stack’s position in the
tree supplies its account, its region and its environment, so adding a stack is
one command and no copied files: the backend, the providers and the shared
globals arrive from imports, and the only hand-written file in the new
directory is the one that calls modules. This is the first post in a series on
Terraform and Terramate.

Commands were run against a scratch repository with Terramate 0.17.3 and
Terraform 1.15.8; the layout comes from a private monorepo of 508 stacks and 95
modules, so account names and profiles are placeholders.

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
and generate everything that is shared. Terramate’s
[stacks](https://terramate.io/docs/cli/stacks/) and
[code generation](https://terramate.io/docs/cli/code-generation/) are built for
exactly that split.

## Three directories that matter

Everything that holds Terraform code goes in one of three places, and the rule
for each is short:

| Directory | Holds | Rule |
| --- | --- | --- |
| `stacks/` | every root module Terramate manages | one stack is one directory containing `stack.tm.hcl` |
| `modules/` | reusable modules the stacks call | referenced by relative path from inside the repository |
| `stacks/imports/` | shared `*.tm.hcl` fragments | the only place a `generate_hcl` block lives |

Keeping `modules/` in the same repository makes change detection
transitive. Terramate parses the `module` blocks in a stack’s `*.tf` files and
follows local sources. The `acm` stack’s hand-written file calls one module:

```hcl title="stacks/aws/acme-development/eu-west-1/acm/main.tf"
module "certificate" {
  source      = "../../../../../modules/acm-certificate"
  domain_name = "api.example.com"
}
```

A commit that touches nothing but that module marks the stack as changed:

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

## Path as identity

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
│       ├── account.tm.hcl            account id, profile, environment
│       ├── eu-west-1/
│       │   ├── region.tm.hcl         region name
│       │   └── acm/                  a stack
│       └── us-east-1/
│           └── region.tm.hcl
└── saas/                             stacks without an AWS account
```

`aws.tm.hcl` pulls the two generators into the subtree, so every stack below it
gets a backend file and a providers file:

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

The provider region follows the new path, and nothing in the stack directory
was edited. The backend file did not change at all: the bucket is the
account’s and the key is the stack’s, and the move touched neither, so no
state object moved either. A move between accounts is the case that changes
the bucket, and then the object is copied to the new bucket under the same
key, the copy
[the migration post](/blog/posts/migrating-terraform-stacks-to-terramate-with-an-agent/)
uses.

## Stack anatomy

A stack directory holds exactly three kinds of file: the marker, the generated
files, and the Terraform someone wrote.

```text
stacks/aws/acme-development/eu-west-1/acm-v2/
├── stack.tm.hcl                          the marker
├── 000_terramate_generated_terraform.tf  backend, from imports
├── 001_terramate_generated_providers.tf  providers, from imports
└── main.tf                               module calls, hand written
```

The marker is a `stack` block carrying a name, a description and an identifier:

```hcl title="stacks/aws/acme-development/eu-west-1/acm-v2/stack.tm.hcl"
stack {
  name        = "acm-v2"
  description = "ACM certificates for the public API"
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
`terraform plan` working from a plain checkout, and continuous integration runs
`terramate generate --detailed-exit-code` to fail a branch whose committed
output is stale.

Counting the repository this comes from: 15 files in `stacks/imports`, **2,040 lines** of
generator, produce **1,954 files and 63,618 lines** of Terraform across 508
stacks. None of it is reviewed line by line, because none of it was written by
anyone.

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

The generators referenced above are where the layout pays off, and they need one
thing the tree cannot give them: credentials.
[One Terraform module for provider credentials](/blog/posts/one-terraform-module-for-provider-credentials/)
covers the module stacks read them through, and
[Generating Terraform providers with Terramate](/blog/posts/generating-terraform-providers-with-terramate/)
takes apart the generator that wires the two together. For the version
constraints those generators emit, see
[Terraform version constraints](/blog/posts/terraform-version-constraints-striking-the-right-balance/).
