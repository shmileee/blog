---
title: Generating Terraform providers with Terramate
description: Declare providers once as hierarchical globals and let Terramate render every stack’s provider blocks.
date: 2026-09-15 09:00:00
categories:
  - terraform
  - terramate
---

A pattern for generating Terraform provider configuration from a single
generator instead of copying `provider` blocks into every root module. It covers
declaring providers as hierarchical [**Terramate**](https://terramate.io/docs/cli/)
globals, rendering them with `generate_hcl`, keeping aliases out of the version
constraints, and referencing credentials the stack never spells out. It is the
third post in a series on Terraform and Terramate, after
[the repository layout](/blog/posts/structuring-a-terraform-monorepo-with-terramate/)
these generators live in and
[the module](/blog/posts/one-terraform-module-for-provider-credentials/) they read
secrets through.

With this in place a stack declares which providers it needs and nothing else.
The version constraint, the `provider` block, the AWS default tags and the
credential plumbing are all derived from that declaration.

The layout assumed throughout is `stacks/aws/<account-alias>/<region>/<stack>`,
with Terramate globals declared at each level and inherited downward. Everything
below was tested with Terramate 0.17.3 and Terraform 1.15.8. The snippets come
from a minimal reproduction of a pattern that runs in a private repository, so
account names, profiles and secret paths are placeholders.

## The provider boilerplate problem

A monorepo of Terraform root modules repeats the same three things in every
stack: a `required_providers` block, one `provider` block per provider with the
region and credentials filled in, and an `alias` variant of it for each account
the stack reaches into. None of it describes infrastructure. All of it is
load-bearing, and it is copy-pasted.

The cost shows up on every change that crosses stacks. Moving the AWS provider
from `~> 5.0` to `~> 6.0` is one edit per root module. Adding a key to the
mandatory tagging policy is another. A stack whose `default_tags` block was
copied before the policy changed keeps provisioning untagged resources, and
nothing in `terraform plan` points at it: the omission stays invisible until
somebody audits the account.

The obvious fixes do not hold. Provider configuration belongs to the root
module: a reusable module may declare `required_providers`, but a module that
carries its own `provider` block
[cannot be called](https://developer.hashicorp.com/terraform/language/modules/develop/providers)
with `count`, `for_each` or `depends_on`. That rules out pushing the
configuration down into a shared module.

Symlinking one `providers.tf` into every stack fails for a different reason: the
file is never identical, since the region, the AWS profile and the set of
aliases differ per stack. Templating it with a script works, and then the
repository owns a template engine and the drift problem moves into it.

What is missing is a declaration: each stack states which providers it needs,
and something else renders the HCL. That is what Terramate’s
[code generation](https://terramate.io/docs/cli/code-generation/) does.

## Declaring providers as globals

[Part one](/blog/posts/structuring-a-terraform-monorepo-with-terramate/) covers
how [globals](https://terramate.io/docs/cli/code-generation/variables/globals)
inherit down a directory tree. What matters here is the other half of the
feature: a
[labelled](https://terramate.io/docs/cli/code-generation/variables/globals#labeled-globals)
`globals` block contributes one key to a map, so the providers a stack sees are
assembled from every level above it. A block labelled
`"terraform" "providers" "aws"` therefore populates
`global.terraform.providers.aws`, and where the file sits decides which stacks
see it:

```text
stacks/
├── imports/
│   ├── 001_providers.tm.hcl             the generator
│   └── aws/provider.tm.hcl              the aws provider defaults
└── aws/
    ├── aws.tm.hcl                       imports the generator
    └── acme-development/                environment, aws_config_profile
        └── eu-west-1/                   region_name, imports the provider
            └── acm/stack.tm.hcl         the stack, plus its own aliases
```

The AWS provider is declared once, at the region level, in terms of globals the
leaf directories supply:

```hcl title="stacks/imports/aws/provider.tm.hcl"
globals "terraform" "providers" "aws" {
  enabled = true
  source  = "hashicorp/aws"
  version = "~> 5.0"
  config = {
    region  = global.region_name
    profile = tm_try(global.aws_config_profile, terramate.stack.path.basename)
  }
}
```

A stack adds only what is specific to it. Here the `acm` stack needs a second
AWS provider pointed at a shared-services account, which it declares as the
labelled key `aws.shared-services`:

```hcl title="stacks/aws/acme-development/eu-west-1/acm/stack.tm.hcl"
globals "terraform" "providers" "aws.shared-services" {
  enabled = true
  config = {
    region  = global.region_name
    profile = "acme-shared-services"
  }
}
```

The `enabled` flag is what makes this composable: a provider declared high in
the tree can be switched off for one subtree without deleting the declaration.

## Generating the provider blocks

The generator is a single `generate_hcl` block in `stacks/imports`, imported by
the root of each subtree, as described in part one. Its
[`lets`](https://terramate.io/docs/cli/code-generation/variables/lets) section
turns the provider map into the shapes the output needs. The version constraints
come from a comprehension that skips aliases:

```hcl
lets {
  required_providers = { for k, v in tm_try(global.terraform.providers, {}) :
    k => {
      source  = v.source
      version = v.version
    }
    if tm_alltrue([
      tm_try(v.enabled, true),
      tm_length(tm_split(".", k)) == 1,
    ])
  }
  # ... providers and providers_aliases differ only in that filter: == 1 and == 2 ...
}
```

Splitting the key on `.` is the whole trick. Terraform requires the entire
configuration to agree on
[one version per provider](https://developer.hashicorp.com/terraform/language/providers/requirements),
so `aws.shared-services` must contribute a `provider` block but must not
contribute a version constraint. A single-segment key is a provider, a
two-segment key is an alias of one, and each comprehension takes the segment
count it wants.

The `content` block renders both maps. The version map goes out as a single
line, `tm_dynamic "required_providers" { attributes = let.required_providers }`,
nested in a `terraform` block. The providers themselves are a `tm_dynamic` over
the other map: one `provider` block per entry, with a nested `default_tags`
block only where the provider is `aws`. Their attributes are the stack’s own
`config`, merged with the credential references covered in the next section.

```hcl
content {
  tm_dynamic "provider" {
    for_each = let.providers
    labels   = [provider.key]
    attributes = tm_merge(
      provider.value.config,
      { for k, v in provider.value.config_partial : k => tm_hcl_expression(v) },
    )

    content {
      tm_dynamic "default_tags" {
        condition = provider.key == "aws"
        content {
          tags = let.aws_default_tags
        }
      }
    }
  }
}
```

The aliased providers are a second `tm_dynamic` over `providers_aliases`, where
the label is the first segment of the key and the `alias` attribute is the
second:

```hcl
tm_dynamic "provider" {
  for_each = let.providers_aliases
  labels   = [tm_split(".", provider.key)[0]]
  # ... the same attributes merge as above ...

  content {
    alias = tm_split(".", provider.key)[1]
    # ... the same conditional default_tags block ...
  }
}
```

`terramate generate` writes the result next to each stack. For the `acm` stack,
two globals files and one alias declaration produce this:

```hcl title="stacks/aws/acme-development/eu-west-1/acm/001_terramate_generated_providers.tf"
// TERRAMATE: GENERATED AUTOMATICALLY DO NOT EDIT

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}
provider "aws" {
  profile = "acme-development"
  region  = "eu-west-1"
  default_tags {
    tags = {
      Application = "acm"
      StackId     = "5a850d00-c6b5-4f7d-9d85-bc9f77816c01"
      env         = "development"
      terraform   = "true"
    }
  }
}
provider "aws" {
  profile = "acme-shared-services"
  region  = "eu-west-1"
  alias   = "shared-services"
  # ... identical default_tags block ...
}
```

The tags are assembled in the generator with `tm_merge`, framework keys last, so
a stack can extend the set through its own global but cannot override `StackId`
or `env` by reusing the key. `tm_dynamic` is documented under
[generate_hcl](https://terramate.io/docs/cli/code-generation/generate-hcl#the-tm-dynamic-block).

## Wiring credentials into providers

Most SaaS providers need a token, and the token comes from the
[lookup module](/blog/posts/one-terraform-module-for-provider-credentials/) that
part two covers. Referencing its output from a generator takes one extra step: a
generated attribute is rendered as a value, so writing
`module.providers_credentials.secrets.github.app_id` into one produces a quoted
string where Terraform needs an unquoted reference. The generator keeps those
references as strings in a `config_partial` map and converts them with
[`tm_hcl_expression`](https://terramate.io/docs/cli/code-generation/functions/tm_hcl_expression),
which turns a string into verbatim HCL:

```hcl
default_config_partials = {
  static = {
    pagerduty = {
      token = "module.${let.credentials_module}.secrets.pagerduty.api_token"
    }
  }
  dynamic = {
    github = {
      id              = "module.${let.credentials_module}.secrets.github.app_id"
      installation_id = "module.${let.credentials_module}.secrets.github.app_installation_id"
      pem_file        = "base64decode(module.${let.credentials_module}.secrets.github.private_key_b64_encoded)"
    }
  }
}
```

The `static` entries become plain attributes; the `dynamic` ones become nested
blocks, here GitHub’s `app_auth`. Both reference the same module output, one map
of secret data keyed by provider name. The generator instantiates that module
only when a stack enables a provider that needs credentials, computed as a
`tm_setintersection` of the providers that have a partial and the providers that
are enabled. For a stack enabling `github` and `pagerduty`:

```hcl title="stacks/saas/github/001_terramate_generated_providers.tf"
module "providers_credentials" {
  source = "../../../modules/providers-credentials"
  terraform_providers = [
    "github",
    "pagerduty",
  ]
}
provider "github" {
  owner = "acme"
  app_auth {
    id              = module.providers_credentials.secrets.github.app_id
    installation_id = module.providers_credentials.secrets.github.app_installation_id
    pem_file        = base64decode(module.providers_credentials.secrets.github.private_key_b64_encoded)
  }
}
provider "pagerduty" {
  token = module.providers_credentials.secrets.pagerduty.api_token
}
```

No stack references a secret identifier, and a stack that enables no such
provider gets no secret lookup and no module block at all.

## Reviewing a provider change

Because the output is committed and generation is
[enforced in continuous integration](/blog/posts/structuring-a-terraform-monorepo-with-terramate/),
a provider change arrives in review as one edit to a declaration plus the exact
set of stacks it rewrites. Moving the AWS provider to the next major version is
a single `version` field in `stacks/imports/aws/provider.tm.hcl`. In the
repository this comes from, that one field feeds **445 generated provider
blocks**. The diff that comes with it names every stack that picks the change
up, and `terramate list --changed` on the branch is the list the pipeline will
plan.

A major upgrade is still a large mechanical commit, and splitting it by subtree
reviews better than landing every stack at once. The
[command reference](https://terramate.io/docs/cli/reference/cmdline/generate)
covers the rest of the generation flags, including `--changed` for generating
only in stacks touched by the current branch.

## Limitations

The single-version rule is Terraform’s, not Terramate’s. A stack that genuinely
needs two major versions of one provider cannot be expressed this way, because
the alias shares the constraint emitted for the base provider.

Everything inside `config_partial` is a string until `tm_hcl_expression` pastes
it into the output, so `terramate generate` will happily render a reference to
an output that does not exist. The error surfaces at `terraform init` or
`terraform validate`, one step later than the mistake.

Attributes come from the declaration, but blocks do not. A provider whose
credentials or options live in a nested block, as GitHub’s `app_auth` and AWS’s
`default_tags` do, needs its own `tm_dynamic` and condition in the generator.
Adding such a provider is a generator edit, not just a global.

## What’s next?

Generating the code a stack repeats is one use of `generate_hcl`. The other is
generating code a stack does not have at all, from a declaration that is not
HCL:
[Generating Terraform for teams from one JSON file](/blog/posts/generating-terraform-for-teams-from-one-json-file/)
turns a `team.json` descriptor into a team’s entire set of module calls with the
same mechanism.
