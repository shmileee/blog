---
title: Generating Terraform providers with Terramate
description: Declare providers once as hierarchical globals and let Terramate render every stack’s provider blocks.
date: 2026-09-15 09:00:00
categories:
  - terraform
  - terramate
---

A pattern for generating Terraform provider configuration from a single
[**Terramate**](https://terramate.io/docs/cli/) generator instead of copying
`provider` blocks into every root module: a stack declares which providers it
needs and nothing else, and the version constraint, the `provider` block and
the credential plumbing are derived from that declaration. It is the third post
in a series on Terraform and Terramate, after
[the repository layout](/blog/posts/structuring-a-terraform-monorepo-with-terramate/)
these generators live in and
[the module](/blog/posts/one-terraform-module-for-provider-credentials/) they read
secrets through.

The layout assumed throughout is `stacks/aws/<account-alias>/<region>/<stack>`,
with Terramate globals declared at each level and inherited downward. Tested
with Terramate 0.17.3 and Terraform 1.15.8; account names, profiles and secret
paths are placeholders.

## The provider boilerplate problem

A monorepo of Terraform root modules repeats the same three things in every
stack: a `required_providers` block, one `provider` block per provider with the
region and credentials filled in, and an `alias` variant of it for each account
the stack reaches into. None of it describes infrastructure. All of it has to
be right, and it is copy-pasted.

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
    profile = global.aws_config_profile
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
`aws.shared-services`, is how the generator’s
[`lets`](https://terramate.io/docs/cli/code-generation/variables/lets) tell the
two apart:

```hcl
lets {
  required_providers = {
    for k, v in tm_try(global.terraform.providers, {}) :
    k => {
      source  = v.source
      version = v.version
    }
    if tm_try(v.enabled, true) && tm_length(tm_split(".", k)) == 1
  }
  providers = {
    for k, v in tm_try(global.terraform.providers, {}) :
    k => v
    if tm_try(v.enabled, true) && tm_length(tm_split(".", k)) == 1
  }
  providers_aliases = {
    for k, v in tm_try(global.terraform.providers, {}) :
    k => v
    if tm_try(v.enabled, true) && tm_length(tm_split(".", k)) == 2
  }
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
      tm_try(provider.value.config, {}),
      {
        for k, v in tm_try(let.credentials[provider.key], {}) :
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
generator keeps the references as strings and converts them with
[`tm_hcl_expression`](https://terramate.io/docs/cli/code-generation/functions/tm_hcl_expression),
which emits a string as verbatim HCL. References that become attributes are
kept apart from those that belong inside a nested block, because a block needs
a `tm_dynamic` of its own:

```hcl
lets {
  secrets = "module.providers_credentials.secrets"

  credentials = {
    pagerduty = {
      token = "${let.secrets}.pagerduty.api_token"
    }
  }

  credential_blocks = {
    github = {
      app_auth = {
        id              = "${let.secrets}.github.app_id"
        installation_id = "${let.secrets}.github.app_installation_id"
        pem_file        = "base64decode(${let.secrets}.github.private_key_b64)"
      }
    }
  }
}
```

The `content` block above merges `let.credentials` into each provider’s
attributes; a nested block is rendered inside the provider’s own `content`,
conditioned on the provider that has one:

```hcl
tm_dynamic "provider" {
  for_each = let.providers
  labels   = [provider.key]
  # ... the attributes merge as above ...

  content {
    tm_dynamic "app_auth" {
      condition = provider.key == "github"
      attributes = {
        for k, v in let.credential_blocks.github.app_auth :
        k => tm_hcl_expression(v)
      }
    }
  }
}
```

The module block itself is generated from the intersection of the providers a
stack enables and the providers the two maps hold credentials for, and only
when that intersection is not empty:

```hcl
lets {
  modules = "${terramate.stack.path.to_root}/modules"

  credential_providers = tm_setintersection(
    tm_keys(let.providers),
    tm_keys(tm_merge(let.credentials, let.credential_blocks)),
  )
}

content {
  # ... the required_providers and provider blocks above ...

  tm_dynamic "module" {
    condition = tm_length(let.credential_providers) > 0
    labels    = ["providers_credentials"]
    content {
      source              = "${let.modules}/providers-credentials"
      terraform_providers = let.credential_providers
    }
  }
}
```

A SaaS stack declares its providers the same way the region declared AWS,
with whatever configuration is not a credential:

```hcl title="stacks/saas/github/providers.tm.hcl"
globals "terraform" "providers" "github" {
  enabled = true
  source  = "integrations/github"
  version = "~> 6.0"
  config = {
    owner = "acme"
  }
}

globals "terraform" "providers" "pagerduty" {
  enabled = true
  source  = "pagerduty/pagerduty"
  version = "~> 3.0"
}
```

Both have credential entries, so the stack gets the module block, and each
provider gets its references:

```hcl title="stacks/saas/github/001_terramate_generated_providers.tf"
// ... terraform { required_providers { github, pagerduty } } ...

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

No stack references a secret identifier, and a stack whose providers need no
credentials gets no module block at all.

## Reviewing a provider change

Because the output is committed and generation is
[enforced in continuous integration](/blog/posts/structuring-a-terraform-monorepo-with-terramate/),
a provider change arrives in review as one edit to a declaration plus the exact
set of stacks it rewrites. Moving the AWS provider to the next major version is
a single `version` field in `stacks/imports/aws/provider.tm.hcl`. In a
repository of 508 stacks, that one field feeds **445 generated provider
blocks**. The diff that comes with it names every stack that picks the change
up, and `terramate list --changed` on the branch is the list the pipeline will
plan.

A major upgrade is still a large mechanical commit, and splitting it by subtree
reviews better than landing every stack at once.

## Limitations

The single-version rule is Terraform’s, not Terramate’s. A stack that genuinely
needs two major versions of one provider cannot be expressed this way, because
the alias shares the constraint emitted for the base provider.

Every credential reference is a string until `tm_hcl_expression` pastes it
into the output, so `terramate generate` will happily render a reference to an
output that does not exist. The error surfaces at `terraform init` or
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
