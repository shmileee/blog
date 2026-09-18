---
title: Pinning tool versions with mise, and what not to pin
description: One file pins Terraform for everyone who clones the repository; the version manager matters less than the decision of which tools deserve a pin at all.
date: 2024-12-15 10:00:00
categories:
  - developer-tools
  - mise
---

Every contributor and every CI job should run the same Terraform, and the way
to get that is a version file in the repository, read by a tool that installs
what it names. I use [mise](https://mise.jdx.dev), which reads asdf’s
`.tool-versions` as well as its own `mise.toml`, so a repository that pinned
versions for asdf keeps working. The setup is three commands. The decision
worth writing down is which tools to pin at all.

> [!NOTE] Versions
>
> mise as of December 2024, Terraform 1.9. mise has kept moving since;
> `mise.toml` is its native format and `.tool-versions` is kept for asdf
> compatibility, and both are shown below.

## The version file

One line per tool, either in asdf’s format:

```text title=".tool-versions"
terraform 1.9.7
```

or in mise’s own:

```toml title="mise.toml"
[tools]
terraform = "1.9.7"
```

`mise install` reads whichever is present and installs what it names, and
the shell then resolves the pinned binary:

```text
mise install
# mise terraform@1.9.7 ✓ installed

which terraform
# ~/.local/share/mise/installs/terraform/1.9.7/bin/terraform

terraform version
# Terraform v1.9.7
```

That is the entire setup for a contributor: clone, `mise install`, done. CI
does the same, so a pipeline and a laptop disagree about a tool version only
when the file changed between them.

## One directory, another version

In a monorepo one stack may still need an older Terraform than the rest:

```hcl
terraform {
  required_version = "1.9.4"
}
```

Two commands cover it. `mise use terraform@1.9.4`, run in that directory,
records the version in that directory’s configuration, and it applies
whenever the shell is inside it. For a one-off run that should not leave
anything behind:

```bash
mise x terraform@1.9.4 -- terraform plan
```

`mise x` installs the version if needed, runs the command with it on the
path, and changes nothing else.

## What not to pin

Pinning is not free. Every pinned tool is a stream of update pull requests
from Renovate or Dependabot, and every merged one makes everyone run
`mise install` again, so a pin has to buy something. Two examples of tools I
leave out:

The AWS CLI. Its minor releases almost never break anything a pipeline
depends on, so a pin trades daily update noise for a guarantee nobody
needed. Let it float.

Python, in a repository that is not a Python project. The system version is
enough for a helper script, and a project that *is* Python has a
Python-native tool (uv, today) managing interpreters and dependencies
together; a second manager for the same interpreter helps nobody.

The tools that earn a pin are the ones whose version changes behaviour a
reviewer cannot see in the diff: Terraform, whose state format and plan
output depend on it; linters and formatters, whose rules do; anything that
generates code that gets committed.

## Limitations

`mise use` changes what `terraform` resolves to only in a shell where mise is
activated (`mise activate` in the shell’s startup file). Without activation,
`mise x` is the reliable form, and a script that assumes activation fails
quietly on a machine without it.

Tools outside mise’s core set are installed through asdf plugins, so the
quality of the install is the quality of that plugin: a plugin that builds
from source turns `mise install` into a compile.

Two version files in one repository, `.tool-versions` for asdf users and
`mise.toml` for mise, drift the moment one is edited without the other. Pick
one; `mise` reads both, so the choice can be made for the asdf holdouts.
