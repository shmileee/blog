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
The version constraint, the `provider` block and the credential plumbing are
all derived from that declaration.

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
from `~> 5.0` to `~> 6.0` is one edit per root module, and a stack that was
copied before the change keeps the old constraint until somebody notices.

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
inherit down a directory tree. The other half of the feature is that a
[labelled](https://terramate.io/docs/cli/code-generation/variables/globals#labeled-globals)
`globals` block contributes one key to a map, so the providers a stack sees are
assembled from every level above it, and where a file sits decides which stacks
see its entry:

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
    profile = tm_try(
      global.aws_config_profile,
      terramate.stack.path.basename,
    )
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
the root of each subtree. Terraform allows
[one version constraint per provider](https://developer.hashicorp.com/terraform/language/providers/requirements)
across the whole configuration, so an alias must produce a `provider` block and
no `required_providers` entry. Keeping the alias in the key,
`aws.shared-services`, is what lets the
[`lets`](https://terramate.io/docs/cli/code-generation/variables/lets) section
tell the two apart:

```hcl
lets {
  required_providers = {
    for k, v in tm_try(global.terraform.providers, {}) :
    k => {
      source  = v.source
      version = v.version
    }
    if tm_alltrue([
      tm_try(v.enabled, true),
      tm_length(tm_split(".", k)) == 1,
    ])
  }
  # ... providers: the same filter; providers_aliases: == 2 instead ...
}
```

The `content` block renders the maps with
[`tm_dynamic`](https://terramate.io/docs/cli/code-generation/generate-hcl#the-tm-dynamic-block):
a `required_providers` block from the first, one `provider` block per entry of
the second, each carrying its own `config` merged with the credential references
covered in the next section:

```hcl
content {
  terraform {
    tm_dynamic "required_providers" {
      attributes = let.required_providers
    }
  }

  tm_dynamic "provider" {
    for_each = let.providers
    labels   = [provider.key]
    attributes = tm_merge(
      provider.value.config,
      {
        for k, v in provider.value.config_partial :
        k => tm_hcl_expression(v)
      },
    )
  }
}
```

Aliases come from the third map, with the label and the `alias` attribute taken
from the two halves of the key:

```hcl
tm_dynamic "provider" {
  for_each = let.providers_aliases
  labels   = [tm_split(".", provider.key)[0]]
  # ... the same attributes merge as above ...

  content {
    alias = tm_split(".", provider.key)[1]
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
}
provider "aws" {
  profile = "acme-shared-services"
  region  = "eu-west-1"
  alias   = "shared-services"
}
```

## Wiring credentials into providers

Most SaaS providers need a token, and the token comes from the
[lookup module](/blog/posts/one-terraform-module-for-provider-credentials/) that
part two covers. A generated attribute is rendered as a value, so a reference
to that module’s output would land in the output file as a quoted string. The
generator keeps such references as strings and converts them with
[`tm_hcl_expression`](https://terramate.io/docs/cli/code-generation/functions/tm_hcl_expression),
which emits a string as verbatim HCL:

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
      pem_file        = "base64decode(module.${let.credentials_module}.secrets.github.private_key_b64)"
    }
  }
}
```

`static` entries become attributes and `dynamic` ones nested blocks, here
GitHub’s `app_auth`. The module is instantiated only in a stack that enables a
provider with a partial, with exactly those names requested. For a stack
enabling `github` and `pagerduty`:

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
    pem_file        = base64decode(module.providers_credentials.secrets.github.private_key_b64)
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
credentials live in a nested block, as GitHub’s `app_auth` does, needs its own
`tm_dynamic` and condition in the generator. Adding such a provider is a
generator edit, not just a global.

## What’s next?

Generating the code a stack repeats is one use of `generate_hcl`. The other is
generating code a stack does not have at all, from a declaration that is not
HCL:
[Generating Terraform for teams from one JSON file](/blog/posts/generating-terraform-for-teams-from-one-json-file/)
turns a `team.json` descriptor into a team’s entire set of module calls with the
same mechanism.
