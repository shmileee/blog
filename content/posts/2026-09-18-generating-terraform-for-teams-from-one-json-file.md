---
title: Generating Terraform for teams from one JSON file
description: A JSON descriptor per team, parsed by Terramate, generates every Terraform module that team needs.
date: 2026-09-18 09:00:00
categories:
  - terraform
  - terramate
---

A self-service model where a team’s infrastructure is described by one
`team.json` file and everything else is generated, so adding a team is a
directory, a JSON file and a pull request: no one writes Terraform, and no one
reviews Terraform that was copied from another team. Teams live in their own
subtree, `stacks/teams/<team>`, beside the account-and-region hierarchy the
rest of the repository uses rather than inside it, because a team is not a
thing that belongs to one AWS account. It is the fourth post in a series on
Terraform and Terramate, after
[Generating Terraform providers with Terramate](/blog/posts/generating-terraform-providers-with-terramate/).

Transcripts come from a two-team scratch repository with Terramate 0.17.3,
Terraform 1.15.8 and
[check-jsonschema](https://github.com/python-jsonschema/check-jsonschema) 0.38;
platform names are generic.

## Why a team is infrastructure

A team exists in more places than the org chart. It is a GitHub team with
repository permissions, a Slack channel, an on-call schedule with an escalation
policy, an entry in the service catalogue, and the links between them: the
escalation policy points at the channel, the catalogue entry names the GitHub
team. Each of those lives in a different system with its own admin console, and
a team assembled through the consoles is exactly as consistent as the person who
clicked through them that day.

Declaring teams as code gives them what infrastructure already has. One
declaration produces the same footprint in every system; every change is a
reviewed pull request with a history behind it; a channel renamed by hand shows
up as drift in the next plan; and removing a team is the reverse of creating
one rather than a search through four consoles. The policy, which platforms a
team gets and how they are named and connected, is written once, and every
team gets the same one.

Done by hand, a new team is a ticket with a checklist, and the checklist rots.
Done by copying another team’s stack, the usual fix in a Terraform monorepo, it
is a directory of near-identical HCL per team, with the differences buried in
files that are 95% the same and the platform team in the path of every change,
down to a renamed Slack channel. What a team actually has to say is small: which
GitHub teams, which channel, which time zones the rotation covers. Everything
else is policy, and the descriptor makes that split explicit, with Terramate’s
[code generation](https://terramate.io/docs/cli/code-generation/) supplying the
policy half.

## The team descriptor

The team’s directory name is its identity, and the only other required file is
the descriptor:

```json title="stacks/teams/team-platform/team.json"
{
  "team_name_readable": "Platform",
  "github": {
    "teams": [
      { "type": "default" },
      { "type": "frontend", "description": "Frontend engineers" }
    ]
  },
  "slack": {
    "channel": "team-platform",
    "topic": "Platform team, public"
  },
  "oncall": {
    "schedules": [
      {
        "timezone": "Europe/Warsaw",
        "daily_start_time": "09:00:00",
        "daily_end_time": "17:00:00"
      }
    ]
  }
}
```

Nothing here names a Terraform module, a provider or a resource. The keys are
platforms and the values are the two or three facts each platform needs; every
default lives in the generator.

A [JSON Schema](https://json-schema.org/), checked in pre-commit and in
continuous integration, rejects a malformed descriptor. Its outer shape is
unusual:

```json title="stacks/teams/team.schema.json"
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "oneOf": [
    {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    },
    {
      "type": "object",
      "additionalProperties": false,
      "required": ["team_name_readable"],
      "properties": {
        "team_name_readable": { "type": "string" },
        "github": { "type": "object" },
        "slack": { "type": "object" },
        "oncall": { "type": "object" }
      }
    }
  ]
}
```

The platform objects are spelled out in full in the real file; what matters here
is the shape around them. The first alternative accepts `{}` and nothing else,
which exists so a team can be torn down by emptying its descriptor. The second
is the actual schema, with `additionalProperties` closed so a misspelled key is
an error rather than a silently ignored one. Misspell `type` inside
`github.teams` and the check fails:

```text
check-jsonschema --schemafile stacks/teams/team.schema.json \
  stacks/teams/*/team.json
# Schema validation errors were encountered.
#   stacks/teams/team-platform/team.json::$:
#     ... is not valid under any of the given schemas
#   Best Match:
#     $: Additional properties are not allowed ('github', 'oncall',
#        'slack', 'team_name_readable' were unexpected)
```

## Parsing it with Terramate

One `teams.tm.hcl` at the root of `stacks/teams` applies to every team
directory below it. Two globals do the parsing:

```hcl title="stacks/teams/teams.tm.hcl"
globals {
  team_name             = terramate.stack.path.basename
  team_name_underscores = tm_replace(global.team_name, "-", "_")

  team_config = tm_jsondecode(tm_file("team.json"))
}
```

Globals are evaluated per stack, so this one file yields a different
`team_config` in every team directory, read from that directory’s own
descriptor. The directory name doubles as the team’s name, which is why the
descriptor never repeats it; the underscore variant is for platforms that
reject hyphens.

## One generated file per platform

Each platform gets its own `generate_hcl` block, guarded by whether the
descriptor mentions it at all:

```hcl
generate_hcl "100_terramate_generated_github_teams.tf" {
  condition = tm_can(global.team_config.github)

  lets {
    github_teams = {
      for team in tm_try(global.team_config.github.teams, []) :
      "github_team_${team.type}" => {
        source = "${terramate.stack.path.to_root}/modules/github-team"

        create           = tm_try(team.create, true)
        team_name        = global.team_name
        team_type        = team.type
        team_description = tm_try(team.description, "Managed with Terraform")
        parent_team      = tm_try(team.parent_team, null)
      }
    }
  }

  content {
    tm_dynamic "module" {
      for_each   = let.github_teams_without_nulls
      iterator   = team
      labels     = [team.key]
      attributes = team.value
    }
  }
}
```

A block whose condition is false produces no file, so the generated files mirror
the descriptor’s top-level keys. Two teams, one with three platforms and one
with none, generate this:

```text
terramate generate
# - /stacks/teams/team-payments
#     [+] 000_terramate_generated_terraform.tf
#     [+] 001_terramate_generated_providers.tf
#
# - /stacks/teams/team-platform
#     [+] 000_terramate_generated_terraform.tf
#     [+] 001_terramate_generated_providers.tf
#     [+] 100_terramate_generated_github_teams.tf
#     [+] 102_terramate_generated_slack.tf
#     [+] 103_terramate_generated_oncall.tf
```

The backend and provider files come from the shared imports covered in
[part one](/blog/posts/structuring-a-terraform-monorepo-with-terramate/) and
[part three](/blog/posts/generating-terraform-providers-with-terramate/); the
`100` series is the team’s own. Inside `100`, the JSON array has become one
module instantiation per element, keyed by type:

```hcl title="stacks/teams/team-platform/100_terramate_generated_github_teams.tf"
module "github_team_default" {
  create           = true
  source           = "../../../modules/github-team"
  team_description = "Managed with Terraform"
  team_name        = "team-platform"
  team_type        = "default"
}
# ... github_team_frontend, with the description from the descriptor ...
```

Two details in that generator matter. The first is the comprehension the
`content` block iterates, `github_teams_without_nulls`, which strips attributes
whose value came out `null`:

```hcl
github_teams_without_nulls = {
  for name, attributes in let.github_teams :
  name => {
    for k, v in attributes :
    k => v
    if v != null
  }
}
```

Without it, a descriptor that omits `parent_team` generates `parent_team = null`
rather than omitting the attribute, and to Terraform those are not the same
thing. Measured on 1.15.8: passing `null` to an ordinary input variable leaves
the variable null and the module’s default unused. Omitting the attribute
applies the default. A variable declared `nullable = false` converts the null
back into its default, which is why some modules survive this and others do
not. Generating nothing is the only form that means “use the default” in all
three cases.

The second is that generated files may reference each other. The on-call
generator sets `escalation_channel` from the Slack module, and has to decide at
generation time whether that module will exist:

```hcl
escalation_channel = tm_ternary(
  tm_can(global.team_config.slack)
  && tm_try(global.team_config.slack.create, true),
  module.slack.name,
  null
)
```

`tm_ternary`, `tm_can` and `tm_try` are resolved while generating;
`module.slack.name` is not a Terramate expression at all and is emitted verbatim
for Terraform to resolve at plan time.

## Onboarding and teardown

Adding a team is four steps, and only one of them is a decision:

```bash
mkdir stacks/teams/team-platform
# write stacks/teams/team-platform/team.json
terramate create stacks/teams/team-platform
git add stacks/teams/team-platform && git commit
```

`terramate create` writes the `stack.tm.hcl` marker with its identifier and runs
generation, so the pull request contains the descriptor plus every file derived
from it. A reviewer reads the JSON, and the HCL beside it either matches the
policy or the generator has a bug.

The trade, counted: **37 descriptors totalling 1,009 lines of JSON** and a
288-line generator, for **263 generated files and 7,776 lines** of Terraform
that nobody writes or reviews.

Teardown runs the same machinery backwards. Emptying the descriptor removes
every conditional file, which is why the schema accepts `{}`:

```text
echo '{}' > stacks/teams/team-platform/team.json
terramate generate
# - /stacks/teams/team-platform
#     [-] 100_terramate_generated_github_teams.tf
#     [-] 102_terramate_generated_slack.tf
#     [-] 103_terramate_generated_oncall.tf
```

The module calls are gone from the configuration, so the next plan is a destroy
of exactly those resources, reviewable as a diff before anyone runs it.

## Limitations

Deleting a key is a destroy. That is correct, and it is also one keystroke away
from removing a channel a team is using. The schema and the review are the only
guardrails: nothing in the generation step distinguishes “we no longer want
this” from “I meant to edit the line below”.

The descriptor can only express what the generator already understands. Adding a
platform, or a field the modules do not take yet, is a change to `teams.tm.hcl`
and to a module, which is platform-team work; the self-service surface ends at
the schema.

The teardown affordance costs error quality. A `oneOf` makes the validator
report the branch it judged closest, and for a descriptor with a typo in it that
branch is the empty-object one, so the message blames every top-level key
instead of the misspelled one. Validated against the second alternative alone,
the same file reports `$.github.teams[1]: 'type' is a required property`.

Teams read the first message. Either live with it, or move the empty case out of
the schema and into the pre-commit hook.

JSON has no comments, so the reason a team disabled a rotation lives in the
commit message rather than next to the flag. A schema with descriptions helps a
reader more than it first appears, because it is the only documentation adjacent
to the file.

Every team’s generated files are rewritten when the generator changes, so a
policy change lands as one commit touching every team directory. Splitting it by
team is not possible without splitting the generator edit itself.

## What’s next?

A team descriptor is one instance of a general shape: a small declaration
outside HCL, a generator that turns it into module calls, and no hand-written
Terraform between them. All four posts so far assume the layout is already
there.
[Migrating Terraform stacks to Terramate with an agent](/blog/posts/migrating-terraform-stacks-to-terramate-with-an-agent/)
covers getting to it from a flat repository, with a plan gate mechanical enough
that an agent can drive the migration behind it.
