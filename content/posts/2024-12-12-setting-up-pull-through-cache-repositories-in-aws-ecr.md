---
title: Setting up pull through cache repositories in AWS ECR
description: Cache Docker Hub, Quay and the Kubernetes registry once in a shared-services ECR and let every account in the organisation pull through it; the Terraform, and the two permissions that are easy to miss.
date: 2024-12-12 08:00:00
categories:
  - aws
  - terraform
  - ecr
---

A pull through cache repository is ECR acting as a proxy for a public
registry: the first pull of an image fetches it upstream and stores it, later
pulls are served from ECR. I set one up in a shared-services account for three
reasons: an approved list of upstream registries instead of whatever a manifest
happens to name, images that stay available when the upstream is not, and an
end to Docker Hub rate limits on clusters that reschedule pods all day. This
is the Terraform for it, and the two permissions that are easy to miss.

> [!NOTE] Versions and placeholders
>
> Terraform AWS provider 5.x with `terraform-aws-modules/ecr` 2.3 and
> `terraform-aws-modules/secrets-manager` 1.x, as run in December 2024. The
> account id `111111111111`, the region `eu-west-1` and the credentials are
> placeholders. The list of registries ECR can cache has grown since; the
> [current list](https://docs.aws.amazon.com/AmazonECR/latest/userguide/pull-through-cache.html)
> is in the AWS documentation.

## How a pull goes through the cache

A pull through cache rule maps a prefix in your registry to one upstream. A
client pulls from your registry under that prefix, ECR fetches the image from
the upstream on the first request and creates a repository for it, and every
later pull is served from ECR:

| Upstream | Prefix | Image reference to pull |
| --- | --- | --- |
| `registry-1.docker.io` | `docker-hub` | `<registry>/docker-hub/library/python:3.12` |
| `public.ecr.aws` | `public-ecr` | `<registry>/public-ecr/ubuntu/ubuntu:edge` |
| `quay.io` | `quay` | `<registry>/quay/prometheus/node-exporter:v1.8.2` |
| `registry.k8s.io` | `registry-k8s-io` | `<registry>/registry-k8s-io/pause:3.10` |

`<registry>` is `111111111111.dkr.ecr.eu-west-1.amazonaws.com` throughout.
Two things follow from “creates a repository on the first pull”. The identity
pulling needs permission to create repositories in the shared account, and
the repository ECR creates needs a policy that lets the other accounts read
it. Both are below; both are the part people forget.

## Docker Hub credentials

Of the four upstreams above only Docker Hub requires authentication. ECR reads
the credentials from a Secrets Manager secret whose name must start with
`ecr-pullthroughcache/`; a secret named anything else is rejected when the
rule is created. The secret holds a Docker Hub username and an access token:

```hcl title="secrets.tf"
module "dockerhub_secret" {
  source  = "terraform-aws-modules/secrets-manager/aws"
  version = "~> 1.0"

  name_prefix = "ecr-pullthroughcache/dockerhub-credentials"
  description = "Docker Hub credentials for the ECR pull through cache"

  secret_string = jsonencode({
    username    = "example-username"
    accessToken = "example-token"
  })
}
```

## The upstream registries

The rules are a map, one entry per upstream, with the credential attached to
the one that needs it:

```hcl title="locals.tf"
locals {
  upstream_repositories = {
    docker-hub = {
      upstream_registry_url = "registry-1.docker.io"
      credential_arn        = module.dockerhub_secret.secret_arn
    }
    public-ecr = {
      upstream_registry_url = "public.ecr.aws"
    }
    quay = {
      upstream_registry_url = "quay.io"
    }
    registry-k8s-io = {
      upstream_registry_url = "registry.k8s.io"
    }
  }
}
```

## Letting the organisation read

The repositories the cache creates do not exist when this is written, so
their access policy is attached to a repository creation template, and ECR
applies it to every repository it creates under the prefix. The policy allows
any principal in the AWS organisation to read, and to create the repository
its first pull needs:

```hcl title="policy.tf"
data "aws_organizations_organization" "current" {}

locals {
  repository_policy_statements = {
    AllowReadFromOrganization = {
      effect = "Allow"
      actions = [
        "ecr:CreateRepository",
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:BatchImportUpstreamImage",
        "ecr:DescribeImages",
        "ecr:GetAuthorizationToken",
        "ecr:GetDownloadUrlForLayer",
      ]
      principals = [{ type = "AWS", identifiers = ["*"] }]
      conditions = [{
        test     = "StringEquals"
        variable = "aws:PrincipalOrgID"
        values   = [data.aws_organizations_organization.current.id]
      }]
    }
  }
}
```

One module call creates the rule and the creation template for every entry
of the map:

```hcl title="main.tf"
module "ecr_pull_through_caches" {
  source  = "terraform-aws-modules/ecr/aws//modules/repository-template"
  version = "~> 2.3.0"

  for_each = local.upstream_repositories

  description                    = each.value.upstream_registry_url
  prefix                         = each.key
  create_pull_through_cache_rule = true
  upstream_registry_url          = each.value.upstream_registry_url
  credential_arn                 = try(each.value.credential_arn, null)
  image_tag_mutability           = "MUTABLE"
  repository_policy_statements   = local.repository_policy_statements
}
```

Tags in a cache have to stay mutable: `python:3.12` upstream moves to a new
digest with every patch release, and ECR follows it only if the tag may
change.

## What the nodes need

An EKS node pulling through the cache needs the usual read actions plus
`ecr:CreateRepository` and `ecr:BatchImportUpstreamImage`, because the first
pull of any image creates its repository and imports the image on the node’s
behalf. Without the create permission the pull fails with a repository-not-found
error that says nothing about permissions; the
[containers roadmap issue](https://github.com/aws/containers-roadmap/issues/2053)
is where AWS explains why. The policy attaches to the node role:

```hcl title="nodes.tf"
data "aws_iam_policy_document" "ecr_pull_through" {
  statement {
    effect = "Allow"
    actions = [
      "ecr:BatchGetImage",
      "ecr:BatchImportUpstreamImage",
      "ecr:CreateRepository",
      "ecr:GetAuthorizationToken",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "ecr_pull_through" {
  name   = "ecr-pull-through-access"
  policy = data.aws_iam_policy_document.ecr_pull_through.json
}

resource "aws_iam_role_policy_attachment" "ecr_pull_through" {
  role       = "<eks-node-role-name>"
  policy_arn = aws_iam_policy.ecr_pull_through.arn
}
```

## The first pull

After `docker login` to the shared registry from any account in the
organisation, a pull under a prefix fetches the image upstream, and the
repository exists afterwards:

```text
docker pull 111111111111.dkr.ecr.eu-west-1.amazonaws.com/docker-hub/library/python:3.12
# 3.12: Pulling from docker-hub/library/python
# ...
# Status: Downloaded newer image for 111111111111.dkr.ecr.eu-west-1.amazonaws.com/docker-hub/library/python:3.12

aws ecr describe-repositories --repository-names docker-hub/library/python \
  --query 'repositories[].repositoryName' --output text
# docker-hub/library/python
```

The second pull of the same tag, from any account, is served from that
repository.

## Limitations

ECR caches a fixed list of upstreams. Docker Hub, ECR Public, Quay and the
Kubernetes registry are above; GitHub, GitLab and Azure container registries
have been added since and need credentials the way Docker Hub does. A
registry outside the list cannot be proxied.

A cached tag is checked against the upstream at most once every 24 hours, so
a moving tag such as `latest` can lag a day behind. The first pull of any
image pays the upstream fetch in full.

Everything an organisation pulls is stored, and billed, in the shared account.
A lifecycle policy on the created repositories is the fix, and the creation
template is where it goes.

The read policy admits the whole organisation. Narrowing it to specific
accounts means listing them in the template, which then changes whenever an
account is added.

## What’s next?

Manifests still name `docker.io`, `quay.io` and `registry.k8s.io`, and editing
every one of them across clusters is the slow part.
[Rewriting Docker image registries with Kyverno](/blog/posts/rewriting-docker-image-registries-with-kyverno/)
points pods at the cache without touching the manifests.
