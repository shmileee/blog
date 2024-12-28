---
title: Access AWS From CI/CD With OIDC Federation
categories: aws
layout: post
date: 2024-12-28 15:00:00
---

As your CI/CD workflows evolve, they will inevitably require access to cloud
resources. For example, you might need to deploy a static website to an AWS S3
bucket, push Docker images to AWS ECR, or retrieve artifacts from AWS
CodeArtifact. Historically, this was accomplished by creating static
credentials — AWS access and secret keys — tied to an IAM user. These keys were
then stored in the CI/CD secrets manager and used as environment variables to
authenticate with AWS via the `aws` CLI.

While this method is sometimes unavoidable (e.g., in legacy on-premises
environments), it has significant drawbacks, including security risks and
management overhead. Fortunately, for most modern CI/CD systems, static
credentials can be replaced with more secure methods. For instance, you could
use a self-hosted runner with IAM permissions in your own environment. However,
managing self-hosted runners can be complex and is often overkill for many
scenarios.

A much simpler and more secure alternative is leveraging OpenID Connect (OIDC)
integration. With OIDC, you can dynamically authenticate CI/CD workflows with
temporary credentials, eliminating the need for static keys while maintaining
granular access control.

This post will walk you through configuring OIDC for GitHub Actions and
CircleCI, using Terraform.

---

### GitHub Actions

#### Configure OIDC Provider

Based on the [official GitHub documentation for configuring OpenID Connect in
AWS](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services),
use the following Terraform snippet to create an OIDC provider for GitHub
Actions:

```hcl
resource "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"

  client_id_list = [
    "sts.amazonaws.com",
  ]

  # See: https://github.blog/changelog/2023-06-27-github-actions-update-on-oidc-integration-with-aws
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1"
  ]
}
```

#### Create an IAM Role With Required Access

Define an assume role policy that grants access to yet to be created IAM role
for designated repositories within a specified GitHub organization, restricted
to **no** particular branches. Make sure to replace placeholders like
`<my-org/my-repo>` with your actual values.

```hcl
data "aws_iam_policy_document" "github_oidc_assume" {
  statement {
    effect = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:<my-org/my-repo>:*"]
    }
  }
}
```

Create an actual IAM role and give it read access to an example S3 bucket:

```hcl
resource "aws_iam_role" "github_actions" {
  name = "github-actions-role"

  assume_role_policy = data.aws_iam_policy_document.github_oidc_assume.json
}

resource "aws_iam_policy" "s3_read_access" {
  name        = "s3-read-access"
  description = "Allow read access to a specific S3 bucket"

  policy = data.aws_iam_policy_document.s3_read.json
}

data "aws_iam_policy_document" "s3_read" {
  statement {
    effect = "Allow"
    actions = ["s3:GetObject"]
    resources = ["arn:aws:s3:::example-bucket/*"]
  }
}

resource "aws_iam_role_policy_attachment" "github_actions_s3_access" {
  role       = aws_iam_role.github_actions.name
  policy_arn = aws_iam_policy.s3_read_access.arn
}
```

#### Use the Role in Github Actions

```yaml
---
name: example-access-through-oidc
on:
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest

    permissions:
      id-token: write
      contents: read

    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::111111111111:role/github-actions-role
          aws-region: us-east-1

      - run: aws s3 ls s3://example-bucket
```

Make sure to replace placeholders like `111111111111` and `example-bucket` with
your actual values.

---

### CircleCI

#### Configure OIDC Provider

For CircleCI, the OIDC URL is configured differently and depends on your
organization ID. The URL is `https://oidc.circleci.com/org/<organization_id>`,
where `organization_id` is the organization ID (a universally unique
identifier) that represents your organization. You can find your CircleCI
organization ID by navigating to **Organization Settings** > **Overview** in the
[CircleCI UI](https://app.circleci.com).

```hcl
resource "aws_iam_openid_connect_provider" "circleci" {
  url = "https://oidc.circleci.com/org/123e4567-e89b-12d3-a456-426614174000"

  client_id_list = [
    "123e4567-e89b-12d3-a456-426614174000"
  ]

  thumbprint_list = [
    # See: https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc_verify-thumbprint.html
    "9E:99:A4:8A:99:60:B1:49:26:BB:7F:3B:02:E2:2D:A2:B0:AB:72:80"
  ]
}
```

#### Create an IAM Role With Required Access

Define an assume role policy that grants access to yet to be created IAM role
for all projects in an entire CircleCI organization:

```hcl

data "aws_iam_policy_document" "circleci_oidc_assume" {
  statement {
    effect = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.circleci.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "oidc.circleci.com/org/123e4567-e89b-12d3-a456-426614174000:aud"
      values   = ["123e4567-e89b-12d3-a456-426614174000"]
    }
  }
}
```

Create an actual IAM role and give it read access to an example S3 bucket:

```hcl
resource "aws_iam_role" "circleci" {
  name = "circleci-role"

  assume_role_policy = data.aws_iam_policy_document.circleci_oidc_assume.json
}

resource "aws_iam_policy" "s3_read_access" {
  name        = "s3-read-access"
  description = "Allow read access to a specific S3 bucket"

  policy = data.aws_iam_policy_document.s3_read.json
}

data "aws_iam_policy_document" "s3_read" {
  statement {
    effect = "Allow"
    actions = ["s3:GetObject"]
    resources = ["arn:aws:s3:::example-bucket/*"]
  }
}

resource "aws_iam_role_policy_attachment" "circleci_s3_access" {
  role       = aws_iam_role.circleci.name
  policy_arn = aws_iam_policy.s3_read_access.arn
}
```

#### Use the Role in CircleCI

```yaml
version: 2.1

orbs:
  aws-cli: circleci/aws-cli@v5.1.2

jobs:
  example-access-through-oidc:
    executor: aws-cli/default
    steps:
      - aws-cli/setup:
          role_arn: arn:aws:iam::111111111111:role/circleci-role
          region: us-east-1

      - run:
          name: access s3 bucket
          command: aws s3 ls s3://example-bucket
```

Make sure to replace placeholders like `111111111111` and `example-bucket`
with your actual values.
