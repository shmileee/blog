---
title: Terraform Version Constraints — Striking the Right Balance
categories: terraform
layout: post
date: 2024-12-10
---

Managing provider versions in Terraform is an exercise in balancing stability
with flexibility. Locking down versions too tightly can stifle progress, while
overly loose constraints risk unexpected breakage. Here’s how to apply version
constraints thoughtfully to ensure smooth operations across regular modules and
root modules (aka stacks).

#### Modules: Use Minimum Working & Tested Version

When defining regular modules, specify the minimum provider version that has been
tested and confirmed to work. For example:

```hcl
required_providers {
  aws = {
    source  = "hashicorp/aws"
    version = ">= 5.0"
  }
}
```

#### Stacks: Use Pessimistic Version Constraints with MAJOR Version Pinning

For stacks (root modules), use the pessimistic constraint operator (`~>`) to
pin only the major version. This ensures compatibility while allowing automatic
updates for minor and patch versions. For example:

```hcl
required_providers {
  aws = {
    source  = "hashicorp/aws"
    version = "~> 5"
  }
  vault = {
    source  = "hashicorp/vault"
    version = "~> 3"
  }
  kubernetes = {
    source  = "hashicorp/kubernetes"
    version = "~> 2"
  }
}
```

In this example, `~> 5` for the `aws` provider allows any version `>= 5.0.0`
but `< 6.0.0`, including versions such as `5.1`, `5.2.3`, and `5.8`. Major
versions (e.g., `6.0.0`) are excluded, as they may include breaking changes.

**Advantages of `~> 5`:**

- Automatically includes minor and patch updates, ensuring you stay up-to-date
  with non-breaking changes.
- Excludes major updates, reducing the risk of unexpected breaking changes.
- Requires no manual intervention for most updates, as the latest compatible
  version is used by default.
- Renovate or similar tools will not suggest updates outside the specified
  major version.

> ⚠️ In Terraform, `~> 5` is shorthand for `~> 5.x`.

#### Considerations for Providers with Potential Breaking Changes

For providers known to introduce breaking changes in minor or patch updates
(e.g., `elastic` or some community-maintained SQL providers), adopt stricter
version pinning in stacks:

- Use a specific patch version with the pessimistic operator: `~> 5.2.1`.
- Alternatively, pin an exact version: `= 5.2.1`.

This approach ensures stability for providers where updates may introduce
unexpected issues.
