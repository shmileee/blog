---
title: One Terraform Module for Provider Credentials
description: One module maps provider names to secret paths; no Terraform stack knows where credentials live.
date: 2026-09-11 09:00:00
categories:
  - terraform
  - terramate
---

A Terraform module that provisions nothing. It takes a list of logical names,
looks each one up in a registry of secret identifiers, and returns the secret
data as one map. This post covers its interface, the validation that makes a
wrong name fail at plan time, and what changes when the store underneath is
**Google Secret Manager** instead of
[**AWS Secrets Manager**](https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html).
It is the second post in a series on Terraform and Terramate, after
[Structuring a Terraform Monorepo With Terramate](/blog/posts/structuring-a-terraform-monorepo-with-terramate/).

The result is that no stack in the repository contains a secret identifier. A
stack names what it needs, and the module is the single place that knows where
that lives and how to read it.

The stacks it serves are root modules in a Terramate monorepo, laid out as
`stacks/aws/<account>/<region>/<stack>`, but nothing in the module itself
depends on that: it is ordinary Terraform, callable from anywhere.

The module below was validated with Terraform 1.15.8, and the transcripts are
from a scratch repository built for this post. Secret names are generic
placeholders.

## The Credential Sprawl Problem

The PagerDuty provider needs a token before it can do anything, which in
practice means an
[`aws_secretsmanager_secret_version`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/secretsmanager_secret_version)
data source in the stack, and a `jsondecode` wherever the value is used:

```hcl
data "aws_secretsmanager_secret_version" "pagerduty" {
  secret_id = "infrastructure/pagerduty"
}
```

Three lines, and every stack that touches PagerDuty has its own copy. The copies
stop being identical quickly. One reads a secret that has since been renamed and
fails on the next plan. Another reads one that still exists and holds a
credential that was superseded elsewhere. A third reads the right secret and
then asks for a key it does not contain, which fails with `This object does not
have an attribute named` and a key name that looks correct.

Two properties make this worse than ordinary duplication. Identifiers carry no
type information, so nothing in the language rejects a wrong one. And the
credential has to be read at plan time, before any resource exists, so there is
no chance to fix it later in the run. Whatever knows the identifiers has to be
available to every stack, and it has to be one thing.

## A Module That Provisions Nothing

The module has no `resource` blocks. It holds a registry of identifiers, a
filter, a data source, and one output, which makes it safe to instantiate
anywhere: the worst it can do is read.

The interface is two variables. One names what to fetch, the other extends the
registry with entries it cannot know in advance:

```hcl title="modules/providers-credentials/main.tf"
variable "terraform_providers" {
  description = "Logical names to read secrets for; empty reads every known name."
  type        = list(string)
  default     = []
}

variable "custom_paths" {
  description = "Extra name-to-path mappings, merged over the built-in registry."
  type        = map(string)
  default     = {}
}
```

The registry itself is a local, so it is a fact about the repository rather than
something a caller can get wrong. `custom_paths` merges over it, and the
requested subset is filtered out of the result:

```hcl
locals {
  secret_paths = {
    github     = "infrastructure/github-app"
    pagerduty  = "infrastructure/pagerduty"
    slack      = "infrastructure/slack"
    postgresql = "infrastructure/postgres/default"
  }

  merged_secret_paths = merge(local.secret_paths, var.custom_paths)

  requested_secrets = length(var.terraform_providers) > 0 ? {
    for k, v in local.merged_secret_paths : k => v
    if contains(var.terraform_providers, k)
  } : local.merged_secret_paths
}
```

The merge order is the useful part: `custom_paths` wins over the registry for a
name it also defines. That is how a per-instance secret gets a per-instance
identifier. A stack managing one Postgres cluster passes
`custom_paths = { postgresql = "infrastructure/postgres/cluster-a" }` and reads
it under the same `postgresql` name as everything else.

What remains is the read and the output. A third variable, `create`, defaults to
`true` and exists so a caller can switch the reads off without removing the
module block:

```hcl
data "aws_secretsmanager_secret_version" "providers" {
  for_each = var.create ? local.requested_secrets : {}

  secret_id = each.value
}

output "secrets" {
  description = "Secret data keyed by logical name."
  value       = { for k, v in data.aws_secretsmanager_secret_version.providers : k => jsondecode(v.secret_string) }
}
```

A secret version is a single string, so the `jsondecode` is what turns each one
into a map and gives the output its shape: one entry per requested name, each
holding that secret's keys. The module does not know what those keys are, so
adding a field to a secret needs no change here, and a consumer reads
`module.providers_credentials.secrets.pagerduty.api_token` directly.

## Validating the Request

A name that is not in the registry is the one mistake worth catching early, and
a [`validation`](https://developer.hashicorp.com/terraform/language/block/variable)
block on the variable catches it. The condition reads `local.secret_paths`,
which is a reference out of the variable and into the rest of the module:

```hcl
validation {
  condition = alltrue([
    for name in var.terraform_providers :
    contains(concat(keys(local.secret_paths), keys(var.custom_paths)), name)
  ])
  error_message = "Unknown names requested. Known names: ${join(", ", keys(local.secret_paths))}."
}
```

On Terraform 1.15.8 that rule is checked when the plan is generated and not by
`terraform validate`, so a wrong name survives `validate` and fails the plan
with the list of names that would have worked:

```text
terraform plan
# Error: Invalid value for variable
#
#   on main.tf line 7, in module "providers_credentials":
#    7:   terraform_providers = ["github", "datadog"]
#
# Unknown names requested. Known names: github, pagerduty, postgresql, slack.
```

That message is the module's documentation as far as most callers are
concerned, which is why it enumerates the registry instead of saying the input
is invalid.

## Swapping the Store

Nothing above is specific to Secrets Manager except the data source. Reading the
same credentials out of
[Google Secret Manager](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/secret_manager_secret_version)
changes the provider requirement, the data source, one attribute on it, and one
argument in the output:

```hcl
data "google_secret_manager_secret_version" "providers" {
  for_each = var.create ? local.requested_secrets : {}

  secret = each.value
}

output "secrets" {
  description = "Secret data keyed by logical name."
  value       = { for k, v in data.google_secret_manager_secret_version.providers : k => jsondecode(v.secret_data) }
}
```

The registry now holds whatever identifies a secret in that store, and every
consumer stays as it was, because a consumer only ever named a secret and read a
key out of the result. What the output promises is a map per name, not a
particular encoding: a store that already returns structured data needs no
`jsondecode` at all.

## Consuming It From a Stack

No stack writes the module block by hand. The
[provider generator](/blog/posts/generating-terraform-providers-with-terramate/)
computes the list of names a stack actually needs and emits the call, so a stack
that enables the GitHub and PagerDuty providers gets:

```hcl title="stacks/saas/github/001_terramate_generated_providers.tf"
module "providers_credentials" {
  source = "../../../modules/providers-credentials"
  terraform_providers = [
    "github",
    "pagerduty",
  ]
}
```

Secrets frequently live in a different account from the resources a stack
manages. Where they do, the generated block passes the reader explicitly:
`providers = { aws = aws.shared-services }`, naming an alias the stack already
declares. The module itself assumes nothing about where it reads from.

## Limitations

Secret data read through a `data` block is stored in the state file in
plaintext. That is a property of Terraform, not of this module, and it applies
equally to the three-line data source it replaces. What centralizing the reads
adds is how easy it becomes to pull more secrets into a stack than that stack's
state should hold.

The identity running a stack needs read access to every secret its requested
names resolve to. The default is to read the whole registry, so a module call
with no `terraform_providers` asks for all of them. Pass the list.

Secret values are read at plan time and baked into the plan, so rotating a
credential requires a new plan rather than an apply of the existing one.

The registry is a local in one module, which means adding a name is a change to
a shared file that every stack consumes. That is the point of the pattern, and
it also puts the module on the critical path of a great many plans: **273 of the
508 stacks** in the repository this comes from instantiate it. Treat changes to
it accordingly.

## What's Next?

The list of names in that generated module block is not written by anyone: it is
the intersection of the providers a stack enabled and the names this module
knows about.
[Generating Terraform Providers With Terramate](/blog/posts/generating-terraform-providers-with-terramate/)
covers the generator that computes it, along with the provider blocks and
version constraints it emits alongside.
