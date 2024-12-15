---
title: "Mise: Faster, Smarter Tool Versioning"
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

1. [Install `mise` itself](https://mise.jdx.dev/installing-mise.html).

2. Add a `.tool-versions` file to specify your desired tools, for example:

   ```bash
   terraform 1.9.7
   ```

3. Run:

   ```bash
   $ mise install
   ```

   That’s it. Your `terraform` is now set up. Verify:

   ```bash
   $ which terraform
   ~/.local/share/mise/installs/terraform/1.9.7/bin/terraform
   ```

4. 💡 If you have a monorepo with multiple Terraform stacks, each may require
   slightly different version of `terraform` binary. For example, consider a
   stack with the following requirement:

   ```hcl
   terraform {
      required_version = "1.9.4"
   }
   ```

   To contextually set the proper version for this stack, you can simply `cd`
   into the directory and run:

   ```bash
   $ mise use terraform@1.9.4
   ```

   This sets `1.9.4` as the active version for that directory. Need a
   quick, one-off command without changing your environment permanently? Run:

   ```bash
   $ mise x terraform@1.9.4 -- terraform plan
   ```

   This executes `terraform plan` with the desired version on the fly, leaving
   no lingering changes to your setup.

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
