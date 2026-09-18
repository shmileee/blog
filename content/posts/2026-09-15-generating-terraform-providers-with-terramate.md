---
title: Generating Terraform providers with Terramate
description: Declare providers once as hierarchical globals and let Terramate render every stack’s provider blocks.
date: 2026-09-15 09:00:00
categories:
  - terraform
  - terramate
---

In a repository of many root modules, provider configuration is the file most
likely to be copied from the neighbouring stack: the version constraints, a
`provider` block with its region and credentials, an alias for each extra
account. Here a stack declares only which providers it needs, and one
generator renders the rest.

> [!NOTE] Series and versions
>
> Second post in a series on Terraform and Terramate.
>
> - Layout: `stacks/aws/<account>/<region>/<stack>`, with globals inherited
>   downward, from
>   [the first post](/blog/posts/structuring-a-terraform-monorepo-with-terramate/).
> - Credentials: [a data-only module](/blog/posts/one-terraform-module-for-provider-credentials/),
>   described in its own note.
> - Versions: Terramate 0.17.3 and Terraform 1.15.8; account names, profiles
>   and secret paths are placeholders.

## The provider boilerplate problem

None of that configuration describes infrastructure, and all of it has to be
right. The cost shows up on every change that crosses stacks: moving the AWS
provider from `~> 5.0` to `~> 6.0` is one edit per root module, and a stack
that was copied before the change keeps the old constraint until somebody
notices.

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
Three files, three levels, one map:

<figure class="concept-diagram wide" data-concept-diagram>
  <div class="diagram-exhibit" data-exhibit>
    <svg viewBox="0 0 640 232" role="img" aria-label="Three files at three levels of the tree. account.tm.hcl supplies aws_config_profile and account_id; below it, region.tm.hcl supplies region_name and declares the aws provider; below that, acm/stack.tm.hcl declares the aws.shared-services alias. Arrows from the region and stack files lead into one map, global.terraform.providers as the acm stack sees it, holding the keys aws and aws.shared-services.">
      <defs>
        <marker id="prov-arrow-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--color-border)" />
        </marker>
      </defs>
      <rect x="8" y="8" width="268" height="52" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="20" y="29" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">acme-development/account.tm.hcl</text>
      <text x="20" y="47" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">aws_config_profile, account_id</text>
      <path d="M18 60 V116 H26" stroke="var(--color-border)" fill="none" />
      <rect x="28" y="90" width="248" height="52" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="40" y="111" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">eu-west-1/region.tm.hcl</text>
      <text x="40" y="129" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">region_name · declares aws</text>
      <path d="M38 142 V198 H46" stroke="var(--color-border)" fill="none" />
      <rect x="48" y="172" width="228" height="52" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="60" y="193" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">acm/stack.tm.hcl</text>
      <text x="60" y="211" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">declares aws.shared-services</text>
      <path d="M276 116 H 384" stroke="var(--color-border)" fill="none" marker-end="url(#prov-arrow-a)" />
      <path d="M276 198 C 330 198, 330 157, 384 157" stroke="var(--color-border)" fill="none" marker-end="url(#prov-arrow-a)" />
      <rect x="372" y="44" width="260" height="144" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="388" y="68" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">global.terraform.providers</text>
      <text x="388" y="85" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">as the acm stack sees it</text>
      <rect x="388" y="100" width="228" height="30" rx="4" fill="var(--color-accent-surface)" stroke="var(--color-accent-border)" />
      <text x="402" y="120" font-family="var(--font-mono)" font-size="12" fill="var(--color-accent)">aws</text>
      <rect x="388" y="142" width="228" height="30" rx="4" fill="var(--color-accent-surface)" stroke="var(--color-accent-border)" />
      <text x="402" y="162" font-family="var(--font-mono)" font-size="12" fill="var(--color-accent)">aws.shared-services</text>
    </svg>
  </div>
  <figcaption class="exhibit-caption">Each level declares what it knows; a stack sees the union of everything above it.</figcaption>
</figure>

## Generating the provider blocks

The generator is a single `generate_hcl` block in `stacks/imports`, imported by
the root of each subtree. It has two inputs, the map above and a map of
credential references covered in the next section, and it renders five kinds
of block from them:

<figure class="concept-diagram wide" data-concept-diagram>
  <div class="diagram-exhibit" data-exhibit>
    <svg viewBox="0 0 640 292" role="img" aria-label="Two inputs, the map global.terraform.providers with a key per provider or alias, and let.credentials with references kept as strings, enter one generate_hcl block. It emits five kinds of block: required_providers from the keys without a dot; a provider block per such key with the config from its declaration; an aliased provider block per key with a dot; a module block, providers_credentials, for the providers that need a token; and provider blocks such as pagerduty whose token comes from that module.">
      <defs>
        <marker id="prov-arrow-b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--color-border)" />
        </marker>
      </defs>
      <rect x="8" y="36" width="212" height="56" rx="6" fill="var(--color-accent-surface)" stroke="var(--color-accent-border)" />
      <text x="20" y="58" font-family="var(--font-mono)" font-size="12" fill="var(--color-accent)">global.terraform.providers</text>
      <text x="20" y="76" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">a key per provider or alias</text>
      <rect x="8" y="196" width="212" height="56" rx="6" fill="var(--color-accent-surface)" stroke="var(--color-accent-border)" />
      <text x="20" y="218" font-family="var(--font-mono)" font-size="12" fill="var(--color-accent)">let.credentials</text>
      <text x="20" y="236" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">references, as strings</text>
      <path d="M220 64 H 240" stroke="var(--color-border)" fill="none" marker-end="url(#prov-arrow-b)" />
      <path d="M220 224 H 240" stroke="var(--color-border)" fill="none" marker-end="url(#prov-arrow-b)" />
      <rect x="242" y="8" width="100" height="268" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="292" y="138" text-anchor="middle" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">generate_hcl</text>
      <text x="292" y="156" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">tm_dynamic</text>
      <path d="M342 30 H 364" stroke="var(--color-border)" fill="none" marker-end="url(#prov-arrow-b)" />
      <path d="M342 86 H 364" stroke="var(--color-border)" fill="none" marker-end="url(#prov-arrow-b)" />
      <path d="M342 142 H 364" stroke="var(--color-border)" fill="none" marker-end="url(#prov-arrow-b)" />
      <path d="M342 198 H 364" stroke="var(--color-border)" fill="none" marker-end="url(#prov-arrow-b)" />
      <path d="M342 254 H 364" stroke="var(--color-border)" fill="none" marker-end="url(#prov-arrow-b)" />
      <rect x="366" y="8" width="250" height="44" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="378" y="27" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">required_providers</text>
      <text x="378" y="43" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">keys without a dot</text>
      <rect x="366" y="64" width="250" height="44" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="378" y="83" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">provider "aws"</text>
      <text x="378" y="99" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">config from the declaration</text>
      <rect x="366" y="120" width="250" height="44" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="378" y="139" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">provider "aws" { alias }</text>
      <text x="378" y="155" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">keys with a dot, one block each</text>
      <rect x="366" y="176" width="250" height="44" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="378" y="195" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">module "providers_credentials"</text>
      <text x="378" y="211" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">providers that need a token</text>
      <path d="M616 210 C 636 210, 636 246, 618 246" stroke="var(--color-border)" fill="none" marker-end="url(#prov-arrow-b)" />
      <rect x="366" y="232" width="250" height="44" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="378" y="251" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">provider "pagerduty"</text>
      <text x="378" y="267" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">token from the module above</text>
    </svg>
  </div>
  <figcaption class="exhibit-caption">One generator, two inputs, five kinds of output; the module block’s outputs feed the provider blocks that need a token.</figcaption>
</figure>

Terraform allows
[one version constraint per provider](https://developer.hashicorp.com/terraform/language/providers/requirements)
across the whole configuration, so an alias must produce a `provider` block and
no `required_providers` entry. Keeping the alias in the key,
`aws.shared-services`, is how the generator’s
[`lets`](https://terramate.io/docs/cli/code-generation/variables/lets), its
local values, tell the two apart. Functions prefixed `tm_` are Terraform’s
functions run by Terramate at generation time:

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
covered in the next section. Inside a `tm_dynamic` the current entry is named
after the block label, here `provider`:

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
[lookup module](/blog/posts/one-terraform-module-for-provider-credentials/)
described in its own note. A generated attribute is rendered as a value, so a reference
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
  # path from the stack back up to the repository root, e.g. ../../..
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

A SaaS stack sits outside the account tree, so it declares its own providers
the way the region declared AWS, with whatever configuration is not a
credential. It still needs an AWS provider, because that is what the lookup
module reads Secrets Manager through:

```hcl title="stacks/saas/github/providers.tm.hcl"
globals "terraform" "providers" "aws" {
  enabled = true
  source  = "hashicorp/aws"
  version = "~> 5.0"
  config = {
    region  = "eu-west-1"
    profile = "acme-shared-services"
  }
}

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

GitHub and PagerDuty have credential entries, so the stack gets the module
block and each of those providers gets its references:

```hcl title="stacks/saas/github/001_terramate_generated_providers.tf"
// ... required_providers for aws, github and pagerduty; provider "aws" ...

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
a single `version` field in `stacks/imports/aws/provider.tm.hcl`. In the
production repository this comes from, that one field feeds several hundred
generated provider blocks. The diff that comes with it names every stack that picks the change
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
output that does not exist.

Attributes come from the declaration, but blocks do not. A provider whose
credentials live in a nested block, as GitHub’s `app_auth` does, needs its own
`tm_dynamic` and condition in the generator. Adding such a provider is a
generator edit, not just a global.

## What’s next?

Everything in this series so far is for people who write Terraform. The next
post turns the same generator machinery towards people who do not:
[Generating Terraform for teams from one JSON file](/blog/posts/generating-terraform-for-teams-from-one-json-file/)
lets a team describe its Slack channel, GitHub teams and on-call rotation in a
`team.json`, and the monorepo produces the Terraform. It is the point where an
infrastructure monorepo starts paying off for developers, not only for the
platform team.
