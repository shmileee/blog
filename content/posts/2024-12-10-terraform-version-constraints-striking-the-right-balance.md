---
title: "Terraform provider constraints: modules, stacks and the lock file"
description: Modules declare the minimum they were tested with, stacks pin the major version, and the lock file decides what actually runs.
date: 2024-12-10 09:00:00
categories:
  - terraform
---

Two constraints and one file decide which provider version a Terraform run
uses. A reusable module declares the minimum it was tested with; a root
module, the stack, pins the major version; and `.terraform.lock.hcl` records
the exact version selected within those, so that tomorrow’s plan uses what
today’s did. The first two are policy. The third is the mechanism most
explanations of `~>` leave out, and the reason the policy is safe.

> [!NOTE] Versions
>
> Terraform 1.9 as of December 2024; nothing here has changed in later
> versions. The provider versions are examples.

## Modules: the minimum that works

A module does not get to choose the version; the root module that calls it
does. What a module states is the oldest version it has been tested against,
so that a root module on anything newer can call it:

```hcl title="modules/acm-certificate/versions.tf"
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}
```

A module that pins harder than that, `~> 5.0` say, blocks every root module
that moves to the next major until the module is edited, and in a repository
with many modules that is the upgrade nobody can schedule.

## Stacks: the major version

The root module pins the major with the pessimistic operator. `~> 5` means
`>= 5, < 6`: any `5.x`, never `6.0`, which is where the breaking changes are
allowed to be:

```hcl title="stacks/aws/acme-production/eu-west-1/acm/versions.tf"
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2"
    }
  }
}
```

Terraform combines every constraint that applies to a provider: the stack’s
`~> 5` and the module’s `>= 5.0` intersect to `>= 5.0, < 6`. Renovate and
Dependabot read the same operator and propose updates inside it, so a `6.0`
release shows up as a pull request that changes the constraint, not as a
surprise in a plan.

## The lock file decides what runs

A constraint is a range, and a range is not a version. `terraform init`
picks the newest release inside the range *once* and writes it, with its
checksums, to `.terraform.lock.hcl`:

```hcl title=".terraform.lock.hcl"
provider "registry.terraform.io/hashicorp/aws" {
  version     = "5.82.2"
  constraints = ">= 5.0, ~> 5"
  hashes = [
    "h1:...",
    # ...
  ]
}
```

Every later `init` uses `5.82.2` until something changes the lock file. So
`~> 5` does not mean “always the latest 5.x”; it means “the 5.x in the lock
file, and any other 5.x is one `terraform init -upgrade` away, with no HCL
edit”. Commit the lock file. Without it, two machines running `init` a week
apart select two versions, and the plan differs for a reason no diff shows.
With it, a provider update is a visible change to one file, and Renovate can
make that change on its own.

## Providers that break in minor versions

Some providers, community-maintained ones especially, ship breaking changes
in minor or patch releases. For those the stack pins tighter, `~> 5.2.1`
(`>= 5.2.1, < 5.3`) or the exact `= 5.2.1`, and accepts that every update is
a deliberate edit. The lock file already gives that stability for the version
actually installed; the tighter constraint adds that an `-upgrade` cannot
move past what was tested.

## Limitations

The intersection can be empty. A module that raises its minimum to `>= 6.0`
while stacks still pin `~> 5` fails `init` with a constraint error naming
both, and the fix is a coordinated change: the stack’s constraint, then the
lock file, then the plan.

A pinned major still admits behaviour changes. Providers deprecate arguments
and change defaults inside a major version, and `~> 5` lets those in on the
next `-upgrade`; the lock file is what makes that a chosen moment rather than
a random one.

The lock file records hashes per platform. A lock file written on macOS and
used in Linux CI needs `terraform providers lock -platform=linux_amd64` run
once, or `init` in CI reports a checksum it cannot verify.

## What’s next?

In a monorepo of many stacks the constraint in every `versions.tf` is the
same line, and it is the line that drifts when a stack is copied.
[Generating Terraform providers with Terramate](/blog/posts/generating-terraform-providers-with-terramate/)
writes it once, as a declaration, and generates every stack’s copy from it.
