---
title: Generating Terraform for teams from one JSON file
description: Developers describe their team’s Slack channel, GitHub teams and on-call rotation in one JSON file, and everything else is generated.
date: 2026-09-18 09:00:00
categories:
  - terraform
  - terramate
---

Adding a team is a directory, a JSON file and a pull request. The file says
what the team has, a Slack channel, GitHub teams, an on-call rotation, and a
generator writes the Terraform for it; nobody copies it from the team next
door.

> [!NOTE] Series and versions
>
> Third post in a series on Terraform and Terramate, after
> [Generating Terraform providers with Terramate](/blog/posts/generating-terraform-providers-with-terramate/).
> Terramate 0.17.3, Terraform 1.15.8 and
> [check-jsonschema](https://github.com/python-jsonschema/check-jsonschema) 0.38;
> team names are placeholders.

## Why a team is infrastructure

A team exists in more places than the org chart: a GitHub team with repository
permissions, a Slack channel, an on-call schedule with an escalation policy,
and the links between them. Each lives in a different system with its own admin
console, and a team assembled by clicking through them is as consistent as the
person who did the clicking.

Declaring teams as code gives them what infrastructure already has: one
declaration produces the same footprint in every system, every change is a
reviewed pull request, a channel renamed by hand shows up as drift in the next
plan, and removing a team is the reverse of creating one. What a team has to
say about itself is small, which GitHub teams, which channel, which hours the
rotation covers. Everything else is policy, written once for every team, and
Terramate’s [code generation](https://terramate.io/docs/cli/code-generation/)
supplies it.

## The team descriptor

In [the layout from the first post](/blog/posts/structuring-a-terraform-monorepo-with-terramate/),
a stack is a directory under `stacks/` marked by a `stack.tm.hcl` file, and it
inherits globals from the directories above it. Teams get a subtree of their
own, `stacks/teams/<team>`, beside the account-and-region hierarchy rather than
inside it, because a team does not belong to one AWS account:

```text
stacks/teams/
├── teams.tm.hcl              parses team.json, holds the generators
├── team.schema.json          what a descriptor may contain
├── team-platform/            one stack per team
│   ├── stack.tm.hcl          the marker, from terramate create
│   └── team.json             the descriptor, hand written
├── team-payments/
├── team-search/
├── team-mobile/
└── team-data/
```

The directory name is the team’s identity, and the descriptor is the only file
a person writes:

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
continuous integration, rejects a malformed descriptor. The three platform
definitions are the long part of the file and are left out here; what matters
is `additionalProperties` closed at every level, so a misspelled key is an
error rather than a silently ignored one:

```json title="stacks/teams/team.schema.json"
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "type": "object",
  "additionalProperties": false,
  "required": ["team_name_readable"],
  "properties": {
    "team_name_readable": { "type": "string" },
    "github": { "$ref": "#/definitions/github" },
    "slack": { "$ref": "#/definitions/slack" },
    "oncall": { "$ref": "#/definitions/oncall" }
  }
}
```

Misspell `type` inside `github.teams` and the check fails:

```text
check-jsonschema --schemafile stacks/teams/team.schema.json \
  stacks/teams/*/team.json
# Schema validation errors were encountered.
#   stacks/teams/team-platform/team.json::$.github.teams[1]:
#     'type' is a required property
```

## Parsing it with Terramate

One `teams.tm.hcl` at the root of `stacks/teams` applies to every team
directory below it. Two globals do the parsing:

```hcl title="stacks/teams/teams.tm.hcl"
globals {
  team_name   = terramate.stack.path.basename
  team_config = tm_jsondecode(tm_file("team.json"))
}
```

Globals are evaluated per stack, so this one file yields a different
`team_config` in every team directory, read from that directory’s own
descriptor. The directory name doubles as the team’s name, which is why the
descriptor never repeats it.

## One generated file per platform

Each platform gets its own `generate_hcl` block in the same file, guarded by
whether the descriptor mentions it at all. As in the provider generator,
functions prefixed `tm_` are Terraform’s, run at generation time:

```hcl title="stacks/teams/teams.tm.hcl"
generate_hcl "100_terramate_generated_github_teams.tf" {
  condition = tm_can(global.team_config.github)

  lets {
    github_teams = {
      for team in tm_try(global.team_config.github.teams, []) :
      "github_team_${team.type}" => {
        # path from the stack back up to the repository root
        source = "${terramate.stack.path.to_root}/modules/github-team"

        team_name        = global.team_name
        team_type        = team.type
        team_description = tm_try(team.description, "Managed with Terraform")
      }
    }
  }

  content {
    tm_dynamic "module" {
      for_each   = let.github_teams
      iterator   = team
      labels     = [team.key]
      attributes = team.value
    }
  }
}
```

A block whose condition is false produces no file, so a team’s generated files
mirror its descriptor’s top-level keys:

<figure class="concept-diagram wide" data-concept-diagram>
  <div class="diagram-exhibit" data-exhibit>
    <svg viewBox="0 0 640 240" role="img" aria-label="A team.json descriptor enters teams.tm.hcl, which holds three generate_hcl blocks, each guarded by whether the descriptor mentions github, slack or oncall. Each block that fires writes one file: 100_terramate_generated_github_teams.tf with one module per GitHub team, 101_terramate_generated_slack.tf with one Slack module, 102_terramate_generated_oncall.tf with one module per schedule.">
      <defs>
        <marker id="team-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="var(--color-border)" />
        </marker>
      </defs>
      <rect x="8" y="120" width="128" height="56" rx="6" fill="var(--color-accent-surface)" stroke="var(--color-accent-border)" />
      <text x="20" y="142" font-family="var(--font-mono)" font-size="12" fill="var(--color-accent)">team.json</text>
      <text x="20" y="160" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">the descriptor</text>
      <path d="M136 148 H 158" stroke="var(--color-border)" fill="none" marker-end="url(#team-arrow)" />
      <rect x="160" y="8" width="136" height="224" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="228" y="30" text-anchor="middle" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">teams.tm.hcl</text>
      <text x="228" y="46" text-anchor="middle" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">generate_hcl × 3</text>
      <rect x="174" y="72" width="108" height="28" rx="4" fill="var(--color-accent-surface)" stroke="var(--color-accent-border)" />
      <text x="228" y="91" text-anchor="middle" font-family="var(--font-mono)" font-size="12" fill="var(--color-accent)">if github</text>
      <rect x="174" y="132" width="108" height="28" rx="4" fill="var(--color-accent-surface)" stroke="var(--color-accent-border)" />
      <text x="228" y="151" text-anchor="middle" font-family="var(--font-mono)" font-size="12" fill="var(--color-accent)">if slack</text>
      <rect x="174" y="192" width="108" height="28" rx="4" fill="var(--color-accent-surface)" stroke="var(--color-accent-border)" />
      <text x="228" y="211" text-anchor="middle" font-family="var(--font-mono)" font-size="12" fill="var(--color-accent)">if oncall</text>
      <path d="M282 86 H 318" stroke="var(--color-border)" fill="none" marker-end="url(#team-arrow)" />
      <path d="M282 146 H 318" stroke="var(--color-border)" fill="none" marker-end="url(#team-arrow)" />
      <path d="M282 206 H 318" stroke="var(--color-border)" fill="none" marker-end="url(#team-arrow)" />
      <rect x="320" y="64" width="312" height="44" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="332" y="83" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">100_terramate_generated_github_teams.tf</text>
      <text x="332" y="99" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">one module per github team</text>
      <rect x="320" y="124" width="312" height="44" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="332" y="143" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">101_terramate_generated_slack.tf</text>
      <text x="332" y="159" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">one slack module</text>
      <rect x="320" y="184" width="312" height="44" rx="6" fill="var(--color-surface)" stroke="var(--color-border)" />
      <text x="332" y="203" font-family="var(--font-mono)" font-size="12" fill="var(--color-text)">102_terramate_generated_oncall.tf</text>
      <text x="332" y="219" font-family="var(--font-mono)" font-size="11" fill="var(--color-text-muted)">one module per schedule</text>
    </svg>
  </div>
  <figcaption class="exhibit-caption">One descriptor in, one Terraform file out per platform it names; a platform the descriptor leaves out produces no file.</figcaption>
</figure>

`team-platform` declares three platforms and `team-payments` none yet, so one
gets three files and the other only the two every stack gets from the shared
imports:

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
#     [+] 101_terramate_generated_slack.tf
#     [+] 102_terramate_generated_oncall.tf
#
# ... team-search, team-mobile, team-data ...
```

Files `000` and `001` come from the shared imports in
[part one](/blog/posts/structuring-a-terraform-monorepo-with-terramate/) and
[part two](/blog/posts/generating-terraform-providers-with-terramate/). The
`100` file is the team’s own: one module call per entry in the descriptor’s
`github.teams` array, keyed by type:

```hcl title="stacks/teams/team-platform/100_terramate_generated_github_teams.tf"
// TERRAMATE: GENERATED AUTOMATICALLY DO NOT EDIT

module "github_team_default" {
  source           = "../../../modules/github-team"
  team_description = "Managed with Terraform"
  team_name        = "team-platform"
  team_type        = "default"
}
module "github_team_frontend" {
  source           = "../../../modules/github-team"
  team_description = "Frontend engineers"
  team_name        = "team-platform"
  team_type        = "frontend"
}
```

## Onboarding and teardown

Adding a team is four steps, and only one of them is a decision:

```bash
mkdir stacks/teams/team-search
# write stacks/teams/team-search/team.json
terramate create stacks/teams/team-search
git add stacks/teams/team-search && git commit
```

`terramate create` writes the `stack.tm.hcl` marker with its identifier and runs
generation, so the pull request contains the descriptor plus every file derived
from it. A reviewer reads the JSON, and the HCL beside it either matches the
policy or the generator has a bug.

In the production repository this runs in, a few dozen descriptors, about a
thousand lines of JSON in all, and a generator under three hundred lines stand
in for several thousand lines of Terraform that nobody writes or reviews.

Teardown runs the same machinery backwards. The real schema wraps the object
shown earlier in a `oneOf` whose other branch accepts an empty object and
nothing else:

```json title="stacks/teams/team.schema.json"
{
  "$schema": "https://json-schema.org/draft-07/schema#",
  "oneOf": [
    {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    },
    { "$ref": "#/definitions/team" }
  ]
}
```

So a team is torn down by emptying its descriptor, which removes every
conditional file:

```text
echo '{}' > stacks/teams/team-platform/team.json
terramate generate
# - /stacks/teams/team-platform
#     [-] 100_terramate_generated_github_teams.tf
#     [-] 101_terramate_generated_slack.tf
#     [-] 102_terramate_generated_oncall.tf
```

The module calls are gone from the configuration, so the next plan is a destroy
of exactly those resources, reviewable as a diff before anyone runs it.

## Limitations

Deleting a key is a destroy. That is correct, and it is also one keystroke from
removing a channel a team is using; the schema and the review are the only
guardrails.

The descriptor can only say what the generator already understands. A new
platform, or a field the modules do not take yet, is a change to `teams.tm.hcl`
and to a module, which is platform-team work; self-service ends at the schema.

Accepting `{}` costs error quality. A `oneOf` makes the validator report the
branch it judged closest, and for a descriptor with one typo that is the
empty-object branch, so the message blames every top-level key instead of the
misspelled one. Moving the empty case out of the schema and into the pre-commit
hook fixes that.

JSON has no comments, so the reason behind an unusual value lives in the commit
message. The schema’s `description` fields are the only documentation next to
the file.

A generator change rewrites every team’s files, so a policy change lands as one
commit touching every team directory.

## What’s next?

Everything so far assumes the layout already exists.
[Migrating Terraform stacks to Terramate with an agent](/blog/posts/migrating-terraform-stacks-to-terramate-with-an-agent/)
is about getting there from a flat repository: one stack at a time, behind a
plan gate strict enough that an agent can do the moving.
