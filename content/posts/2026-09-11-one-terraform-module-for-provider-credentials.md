---
title: One Terraform module for provider credentials
description: One module maps provider names to secret paths; no Terraform stack knows where credentials live.
date: 2026-09-11 09:00:00
categories:
  - terraform
  - terramate
---

A Terraform module that provisions nothing: it takes a list of logical names,
looks each one up in a registry of secret identifiers, and returns the secret
data as one map, so no stack in the repository contains a secret identifier. A
stack names what it needs, and the module is the single place that knows where
that lives and how to read it. It is ordinary Terraform, callable from any root
module, and it is shown in a plain stack first; the stacks it was written for
live in the Terramate monorepo from
[part one](/blog/posts/structuring-a-terraform-monorepo-with-terramate/), where
the module call itself is generated. This is the second post in a series on
Terraform and Terramate.

Validated with Terraform 1.15.8 against a scratch repository; secret names are
placeholders.

## The credential sprawl problem

The PagerDuty provider needs a token before it can do anything. In a root
module that keeps it in AWS Secrets Manager (laid out the pre-Terramate way
here, one directory per environment), that is an
[`aws_secretsmanager_secret_version`](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/data-sources/secretsmanager_secret_version)
data source, a `jsondecode` and a key lookup, all next to the provider block
they feed:

```hcl title="app/oncall/production/providers.tf"
data "aws_secretsmanager_secret_version" "pagerduty" {
  secret_id = "infrastructure/pagerduty"
}

provider "pagerduty" {
  token = jsondecode(
    data.aws_secretsmanager_secret_version.pagerduty.secret_string
  )["api_token"]
}
```

Every stack that touches PagerDuty has its own copy of this, and the copies
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

## A module that provisions nothing

The module has no `resource` blocks: a registry of identifiers, a filter, a
data source and one output. HashiCorp’s module composition guide calls this a
[data-only module](https://developer.hashicorp.com/terraform/language/modules/develop/composition#data-only-modules),
a module that creates nothing and exists to encapsulate how something that
already exists is looked up, so that callers depend on the name they ask for
rather than on the lookup. The usual examples resolve a network or a machine
image; here the thing resolved is a credential, and the module is safe to
instantiate anywhere because the worst it can do is read.

The interface is two variables. One names what to fetch, the other extends the
registry with entries it cannot know in advance:

```hcl title="modules/providers-credentials/main.tf"
variable "terraform_providers" {
  description = "Logical names to read; empty reads every known name."
  type        = list(string)
  default     = []
}

variable "custom_paths" {
  description = "Name-to-path entries merged over the built-in registry."
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

  requested_secrets = (
    length(var.terraform_providers) == 0
    ? local.merged_secret_paths
    : {
      for k, v in local.merged_secret_paths :
      k => v if contains(var.terraform_providers, k)
    }
  )
}
```

`custom_paths` wins over the registry for a name both define, which is how a
per-instance secret keeps a shared name: a stack managing one Postgres cluster
passes `custom_paths = { postgresql = "infrastructure/postgres/cluster-a" }` and
reads it as `postgresql` like everything else.

What remains is the read and the output:

```hcl
data "aws_secretsmanager_secret_version" "providers" {
  for_each = local.requested_secrets

  secret_id = each.value
}

output "secrets" {
  description = "Secret data keyed by logical name."
  value       = {
    for k, v in data.aws_secretsmanager_secret_version.providers :
    k => jsondecode(v.secret_string)
  }
}
```

Each secret is a JSON document, so the output is one map per requested name.
The module never enumerates the keys inside, so adding a field to a secret
needs no change here, and a consumer reads
`module.providers_credentials.secrets.pagerduty.api_token` directly.

## Validating the request

A name that is not in the registry is the mistake worth catching early, and a
[`validation`](https://developer.hashicorp.com/terraform/language/block/variable)
block inside `variable "terraform_providers"` catches it. The condition reads
`local.merged_secret_paths`, a reference out of the variable and into the rest
of the module, which Terraform allows since 1.9:

```hcl
validation {
  condition = alltrue([
    for name in var.terraform_providers :
    contains(keys(local.merged_secret_paths), name)
  ])
  error_message = format(
    "Unknown names. Known: %s.",
    join(", ", keys(local.secret_paths)),
  )
}
```

On Terraform 1.15.8 that rule is checked when the plan is generated and not by
`terraform validate`, so a wrong name survives `validate` and fails the plan
with the list of names that would have worked:

```text
terraform plan
# Error: Invalid value for variable
#
#   on providers.tf line 3, in module "providers_credentials":
#    3:   terraform_providers = ["github", "datadog"]
#
# Unknown names. Known: github, pagerduty, postgresql, slack.
```

That message is the module’s documentation as far as most callers are
concerned, which is why it enumerates the registry instead of saying the input
is invalid.

## Swapping the store

Nothing above is specific to Secrets Manager except the data source. Reading the
same credentials out of
[Google Secret Manager](https://registry.terraform.io/providers/hashicorp/google/latest/docs/data-sources/secret_manager_secret_version)
changes the provider requirement, the data source, one attribute on it, and one
argument in the output:

```hcl
data "google_secret_manager_secret_version" "providers" {
  for_each = local.requested_secrets

  secret = each.value
}

output "secrets" {
  description = "Secret data keyed by logical name."
  value       = {
    for k, v in data.google_secret_manager_secret_version.providers :
    k => jsondecode(v.secret_data)
  }
}
```

The registry now holds whatever identifies a secret in that store, and every
consumer stays as it was, because a consumer only ever named a secret and read a
key out of the result. What the output promises is a map per name, not a
particular encoding: a store that already returns structured data needs no
`jsondecode` at all.

## Consuming it from a stack

In a plain Terraform stack the module block replaces the data source, and the
provider reads its token from the output:

```hcl title="app/oncall/production/providers.tf"
module "providers_credentials" {
  source              = "../../../modules/providers-credentials"
  terraform_providers = ["pagerduty"]
}

provider "pagerduty" {
  token = module.providers_credentials.secrets.pagerduty.api_token
}
```

The stack no longer contains a secret identifier, and a renamed secret is a
one-line change to the registry instead of a search through root modules. What
it still contains is a module block and a provider block written by hand, and
in a repository of a few hundred stacks those are the next thing to stop
writing. With Terramate a stack declares which providers it enables, and a
generator emits both blocks with the list of names computed from that
declaration; that generator is the next post.

Secrets often live in a different account from the resources a stack manages.
Where they do, the caller passes the reader explicitly,
`providers = { aws = aws.shared-services }`, naming an aliased AWS provider the
stack already declares (part three generates those aliases). The module assumes
nothing about where it reads from.

## Limitations

Secret data read through a `data` block is stored in the state file in
plaintext. That is a property of Terraform, not of this module, and it applies
equally to the data source it replaces. What centralising the reads
adds is how easy it becomes to pull more secrets into a stack than that stack’s
state should hold.

The identity running a stack needs read access to every secret its requested
names resolve to. The default is to read the whole registry, so a module call
with no `terraform_providers` asks for all of them; pass the list.

Secret values are read at plan time and baked into the plan, so rotating a
credential requires a new plan rather than an apply of the existing one.

The registry is a local in one module, which means adding a name is a change to
a shared file that every stack consumes. That is the point of the pattern, and
it also puts the module on the critical path of a great many plans: **273 of the
508 stacks** in the repository this comes from instantiate it. Treat changes to
it accordingly.

## What’s next?

The module block above is one more thing to write per stack, and the list of
names in it follows from the providers the stack declares.
[Generating Terraform providers with Terramate](/blog/posts/generating-terraform-providers-with-terramate/)
covers the generator that computes that list and emits the module call, the
provider blocks and the version constraints together.
