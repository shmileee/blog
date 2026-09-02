---
title: "Mise: Faster, Smarter Tool Versioning"
description: Keep project toolchains reproducible with mise, shared version files, directory overrides, and one-off execution.
layout: post
date: 2024-12-15 10:00:00
categories:
  - developer-tools
---

When collaborating on a codebase, ensuring that every contributor uses the same
versions of key tools can prevent countless headaches. Historically, `asdf`
([asdf-vm.com](https://asdf-vm.com)) helped unify tool versions by reading from
a single `.tool-versions` file. Now, `mise`
([mise.jdx.dev](https://mise.jdx.dev)) steps in as a faster, more robust
successor, providing a snappier experience and more powerful commands.

## What Is `mise`?

It is a tool written in Rust that manages and installs language runtimes and
binaries according to specifications listed in `.tool-versions`. Think of
`.tool-versions` as a top-level "meta" file that defines the versions of tools
(e.g., Terraform, Node.js) required by your project. Both `asdf` and `mise` can
read it, so you can maintain compatibility and ease the transition.

With `mise`, a single command can quickly install or update every tool your
project relies on, aligning local (and even CI) setups across contributors.

## Example Usage

### 1. Install `mise`

Follow the [official installation guide](https://mise.jdx.dev/installing-mise.html)
for your operating system, then confirm that `mise` is available in your shell.

```bash
mise --version
```

### 2. Declare the project toolchain

Add a `.tool-versions` file to the repository. Each line pairs a tool with the
version the project expects:

```text
terraform 1.9.7
```

### 3. Install and verify the tools

Install everything declared by the repository:

```bash
mise install
```

That’s it. Terraform is now available at the pinned version. Verify the binary
that your shell resolves:

```bash
which terraform
```

```text
~/.local/share/mise/installs/terraform/1.9.7/bin/terraform
```

### 4. Override a version for one directory

In a monorepo, individual Terraform stacks may require different Terraform
versions. Consider a stack with this constraint:

```hcl
terraform {
  required_version = "1.9.4"
}
```

From that stack’s directory, set the local version:

```bash
mise use terraform@1.9.4
```

This makes `1.9.4` active whenever you work in that directory. For a one-off
command that does not change the directory configuration, run:

```bash
mise x terraform@1.9.4 -- terraform plan
```

The command executes `terraform plan` with the requested version and leaves no
lingering change to your environment.

## Considerations

While `mise` makes it easy to version tools, not every binary needs tight
version control. For instance:

- **`awscli`**: Since AWS CLI updates rarely introduce breaking changes,
  pinning its version offers limited value. With automated dependency updates,
  you don’t want to waste time reviewing trivial pull requests from Renovate or
  Dependabot and making everyone rerun `mise install` just to stay on the latest
  minor release.
- **`python`**: Most OSes ship with a suitable version for light, general
  usage. If your project isn’t Python-focused or doesn’t depend on
  python-version-specific features, you might skip versioning Python here. If you
  _are_ doing heavy Python development involving multiple versions, you might
  want to consider a dedicated Python environment manager like
  [rye](https://github.com/astral-sh/rye).

## Summary

`mise` elevates the concept of a `.tool-versions` file into a lightning-fast,
more flexible tool version manager. It keeps your team aligned, reduces
environment drift, and supports easy overrides and ephemeral runs. Choose your
versioned tools wisely — versioning every last binary might not be practical.
But for those critical runtime dependencies that ensure consistency across
collaborators, `mise` is a powerful, streamlined solution.
