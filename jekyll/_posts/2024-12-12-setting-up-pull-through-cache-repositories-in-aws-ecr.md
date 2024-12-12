---
title: Setting Up Pull Through Cache Repositories in AWS ECR
categories:
  - aws
  - terraform
layout: post
date: 2024-12-12 08:00:00
---

A pull through cache repository acts as a proxy of an upstream Docker registry.
There are several reasons to use it:

- **Security Requirements:** In corporate environments, pre-approving a
  specific set of public registries ensures compliance and reduces risks by
  restricting access to only these trusted sources.
- **Resilience:** If there’s concern about upstream registries becoming
  temporarily unavailable, a cache repository ensures images are still
  accessible, mitigating potential disruptions.
- **Cost Efficiency:** Frequently pulling public images, especially from
  registries like DockerHub, can lead to additional costs or restrictions.
  DockerHub, for instance, imposes rate limits on the number of pulls per day,
  which can become problematic in dynamic environments like Kubernetes clusters
  where deployments may restart or reschedule frequently, triggering repeated
  image pulls.

---

In this post, we'll explore how to configure pull through cache repositories
using Terraform for an AWS ECR that is hosted in a shared services account,
with multiple other AWS accounts requiring access (e.g., workload EKS clusters
pulling images from it).

#### Step 1: Define Upstream Registries

First, specify the upstream registries you want to cache:

```hcl
locals {
  upstream_repositories = {
    public-ecr = {
      upstream_registry_url = "public.ecr.aws"
    }
    docker-hub = {
      upstream_registry_url = "registry-1.docker.io"
      credential_arn        = module.secrets_manager_dockerhub_credentials.secret_arn
    }
  }
}
```

> ℹ️ Note: DockerHub requires authentication. You can store credentials in AWS
> Secrets Manager and reference them via ARN.

#### Step 2: (Optional) Manage DockerHub Credentials in Secrets Manager

Create a secret in AWS Secrets Manager for DockerHub credentials. Here’s how to
do it with a community Terraform module:

```hcl
data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
}

module "secrets_manager_dockerhub_credentials" {
  source  = "terraform-aws-modules/secrets-manager/aws"
  version = "~> 1.0"

  name_prefix             = "ecr-pullthroughcache/dockerhub-credentials"
  description             = "DockerHub credentials"
  recovery_window_in_days = 30
  create_policy           = true
  block_public_policy     = true

  secret_string = jsonencode(
    {
      username    = "example-username"
      accessToken = "example-token"
    }
  )

  policy_statements = {
    read = {
      sid = "AllowAccountRead"
      principals = [
        {
          type        = "AWS",
          identifiers = ["arn:aws:iam::${local.account_id}:root"]
        }
      ]
      actions   = ["secretsmanager:GetSecretValue"]
      resources = ["*"]
    }
  }
}
```

#### Step 3: Configure Repository Access

Allow organization-wide access to pull images. Adding `ecr:CreateRepository` is
crucial to handle scenarios where ECR repositories may not yet exist during
when the EKS node tries to pull it for the first time:

```hcl
data "aws_organizations_organization" "current" {}

locals {
  repository_policy_statements = {
    AllowReadFromOrganization = {
      sid = "AllowReadFromOrganization"
      actions = [
        "ecr:CreateRepository",
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:BatchImportUpstreamImage",
        "ecr:DescribeImages",
        "ecr:GetAuthorizationToken",
        "ecr:GetDownloadUrlForLayer"
      ]
      effect = "Allow"
      principals = [
        {
          type = "AWS",
          identifiers = ["*"]
        }
      ]
      conditions = [
        {
          test     = "StringEquals"
          variable = "AWS:PrincipalOrgID"
          values   = [data.aws_organizations_organization.current.id]
        }
      ]
    }
  }
}
```

#### Step 4: Instantiate the Repository Module

Finally, create the pull through cache repositories:

```hcl
module "ecr_pull_through_caches" {
  source  = "terraform-aws-modules/ecr/aws//modules/repository-template"
  version = "~> 2.3.0"

  for_each = local.upstream_repositories

  description                    = each.value.upstream_registry_url
  prefix                         = try(each.value.prefix, replace(each.key, "_", "-"))
  create_pull_through_cache_rule = true
  upstream_registry_url          = each.value.upstream_registry_url
  credential_arn                 = try(each.value.credential_arn, null)
  image_tag_mutability           = "MUTABLE"
  repository_policy_statements   = local.repository_policy_statements
}
```

#### Step 5: Grant EKS Nodes Access to Pull Images

For EKS nodes, ensure their instance profile includes the necessary permissions
to pull images from ECR. Again, a key consideration is granting the
`ecr:CreateRepository` permission. This allows to automatically create a
repository the first time an image is fetched if it doesn’t already exist.
Without this, nodes might fail to pull images during initialization.

```hcl
data "aws_iam_policy_document" "ecr_pull_through" {
  statement {
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:BatchImportUpstreamImage",
      "ecr:GetAuthorizationToken",
      "ecr:GetDownloadUrlForLayer",

      # This permission is critical to prevent a chicken-and-egg issue.
      # When an EKS node tries to pull an image from a non-existent repository,
      # the repository will be automatically created during the first pull.
      #
      # For more details, see: https://github.com/aws/containers-roadmap/issues/2053
      "ecr:CreateRepository"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "container_registry_pull_through_access" {
  name        = "container-registry-pull-through-access"
  description = "Policy for EKS nodes to access ECR pull through cache repositories"
  policy      = data.aws_iam_policy_document.ecr_pull_through.json
}

resource "aws_iam_role_policy_attachment" "container_registry_pull_through_access" {
  role       = "<your-eks-nodes-iam-role-arn>"
  policy_arn = aws_iam_policy.container_registry_pull_through_access.arn
}
```
