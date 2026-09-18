---
title: Access AWS from CI/CD with OIDC federation
description: "GitHub Actions and CircleCI assume an IAM role with a short-lived token instead of a stored access key: the Terraform for both, and the trust conditions that decide who gets in."
date: 2024-12-28 15:00:00
categories:
  - aws
  - terraform
  - cicd
---

A pipeline that deploys to AWS needs credentials, and the usual answer used to
be an IAM user’s access key stored in the CI system’s secrets. The key never
expires, anyone with access to the secrets can copy it, and rotating it is a
project. OpenID Connect replaces it: the CI system signs a token that says
which repository is running, AWS checks the signature and hands out
credentials that expire in an hour. This is the Terraform for GitHub Actions
and CircleCI, and the conditions in the trust policy that decide who gets in.

> [!NOTE] Versions and placeholders
>
> Terraform AWS provider 5.x, `aws-actions/configure-aws-credentials@v4` and
> the `circleci/aws-cli@5.1.2` orb, as of December 2024. The account id
> `111111111111`, `example-bucket`, `<my-org/my-repo>` and the CircleCI
> organisation id `123e4567-e89b-12d3-a456-426614174000` are placeholders.

## How the trust works

Three parties are involved. The CI provider issues a signed JSON Web Token for
every job, carrying an issuer (`iss`), an audience (`aud`) and a subject
(`sub`) that names what is running. AWS holds an *OIDC identity provider* per
issuer, from which it fetches the issuer’s public keys. An IAM role’s trust
policy names that provider and puts conditions on the claims; a job that
presents a token matching them may call `sts:AssumeRoleWithWebIdentity` and
gets credentials for the role, valid for an hour by default. Nothing is
stored anywhere, so the conditions are the only place access is decided:

| Claim | GitHub Actions | CircleCI |
| --- | --- | --- |
| `iss` | `https://token.actions.githubusercontent.com` | `https://oidc.circleci.com/org/<org-id>` |
| `aud` | `sts.amazonaws.com` | `<org-id>` |
| `sub` | `repo:<org>/<repo>:ref:refs/heads/main` | `org/<org-id>/project/<project-id>/user/<user-id>` |

GitHub’s subject carries the repository and the ref, so the trust policy
below conditions on `sub`. CircleCI’s issuer is already scoped to one
organisation, so the simplest policy conditions on `aud`, and a per-project
one adds a `sub` condition.

## What the role may do

Both roles below get the same permission, read access to one bucket, so the
policy is written once and attached twice:

```hcl title="permissions.tf"
data "aws_iam_policy_document" "s3_read" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:ListBucket"]
    resources = ["arn:aws:s3:::example-bucket", "arn:aws:s3:::example-bucket/*"]
  }
}

resource "aws_iam_policy" "s3_read" {
  name   = "s3-read-example-bucket"
  policy = data.aws_iam_policy_document.s3_read.json
}
```

## GitHub Actions

One identity provider per AWS account represents GitHub. The thumbprint is the
well-known one from
[GitHub’s documentation](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services);
since mid-2023 AWS validates GitHub’s tokens against its own trusted root
certificates rather than this value, as
[GitHub’s changelog](https://github.blog/changelog/2023-06-27-github-actions-update-on-oidc-integration-with-aws)
explains, so it no longer needs rotating:

```hcl title="github.tf"
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}
```

The trust policy admits one repository, on any ref:

```hcl title="github.tf"
data "aws_iam_policy_document" "github_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:<my-org/my-repo>:*"]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name               = "github-actions-role"
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

resource "aws_iam_role_policy_attachment" "github_actions_s3" {
  role       = aws_iam_role.github_actions.name
  policy_arn = aws_iam_policy.s3_read.arn
}
```

The workflow needs `id-token: write` to be issued a token at all, and the
official action does the exchange:

```yaml title=".github/workflows/deploy.yaml"
name: deploy
on:
  push:
    branches: [main]

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

      - run: aws sts get-caller-identity
      - run: aws s3 ls s3://example-bucket
```

The first `run` step is the proof: the job is the role, under a session named
by the action, and no key was involved:

```text
aws sts get-caller-identity
# {
#   "UserId": "AROAEXAMPLEID:GitHubActions",
#   "Account": "111111111111",
#   "Arn": "arn:aws:sts::111111111111:assumed-role/github-actions-role/GitHubActions"
# }
```

## CircleCI

CircleCI issues tokens per organisation, so the provider URL and the audience
both carry the organisation id, found under **Organization Settings** →
**Overview** in the [CircleCI UI](https://app.circleci.com). The thumbprint is
that of the issuer’s certificate chain, obtained the way
[AWS documents](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc_verify-thumbprint.html),
written as forty hexadecimal characters:

```hcl title="circleci.tf"
locals {
  circleci_org_id = "123e4567-e89b-12d3-a456-426614174000"
}

resource "aws_iam_openid_connect_provider" "circleci" {
  url             = "https://oidc.circleci.com/org/${local.circleci_org_id}"
  client_id_list  = [local.circleci_org_id]
  thumbprint_list = ["9e99a48a9960b14926bb7f3b02e22da2b0ab7280"]
}
```

The trust policy admits every project in the organisation. Restricting it to
one project is a second condition, `StringLike` on `sub` with
`org/<org-id>/project/<project-id>/user/*`:

```hcl title="circleci.tf"
data "aws_iam_policy_document" "circleci_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.circleci.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "oidc.circleci.com/org/${local.circleci_org_id}:aud"
      values   = [local.circleci_org_id]
    }
  }
}

resource "aws_iam_role" "circleci" {
  name               = "circleci-role"
  assume_role_policy = data.aws_iam_policy_document.circleci_assume.json
}

resource "aws_iam_role_policy_attachment" "circleci_s3" {
  role       = aws_iam_role.circleci.name
  policy_arn = aws_iam_policy.s3_read.arn
}
```

The `aws-cli` orb does the exchange:

```yaml title=".circleci/config.yml"
version: 2.1

orbs:
  aws-cli: circleci/aws-cli@5.1.2

jobs:
  deploy:
    executor: aws-cli/default
    steps:
      - aws-cli/setup:
          role_arn: arn:aws:iam::111111111111:role/circleci-role
          region: us-east-1
      - run: aws sts get-caller-identity
      - run: aws s3 ls s3://example-bucket
```

The same `get-caller-identity` step prints `assumed-role/circleci-role/…`, and
the same check applies: no key anywhere in the configuration.

## Limitations

An AWS account holds one identity provider per issuer URL. A second
`aws_iam_openid_connect_provider` for GitHub in the same account fails with
`EntityAlreadyExists`, so in a repository of many Terraform stacks the
provider belongs to one shared stack and the roles reference its ARN.

`repo:<my-org/my-repo>:*` admits every branch, tag and pull request of the
repository. A role that can deploy should match the ref,
`repo:my-org/my-repo:ref:refs/heads/main`, or the environment,
`repo:my-org/my-repo:environment:production`. Those two are exclusive: a job
that references a GitHub environment gets the `environment:` form of `sub`
and no longer matches a `ref:` condition, which is the usual reason a
previously working role starts refusing a workflow.

The CircleCI `aud` condition admits every project in the organisation; it
cannot tell a production pipeline from a fork’s. Per-project access needs the
`sub` condition, and the project id in it.

Credentials last an hour unless the action or orb asks for more, up to the
role’s maximum session duration; a job longer than that needs the longer
setting, not a retry.

Where the runner has no OIDC issuer, an on-premises agent with no identity of
its own, the static key remains the only option, and everything above is an
argument for giving that runner an identity instead.
