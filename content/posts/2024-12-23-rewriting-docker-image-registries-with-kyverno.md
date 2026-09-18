---
title: Rewriting Docker image registries with Kyverno
description: One Kyverno mutating policy sends every pod’s images through the ECR pull through cache without editing a manifest, rolled out one namespace at a time.
date: 2024-12-23 12:28:00
categories:
  - kubernetes
  - kyverno
  - argocd
---

[The previous post](/blog/posts/setting-up-pull-through-cache-repositories-in-aws-ecr/)
put a pull through cache in front of Docker Hub, Quay and the Kubernetes
registry. Getting clusters to use it means every image reference in every
manifest changing from `docker.io/library/nginx` to
`<registry>/docker-hub/library/nginx`, across namespaces and clusters owned
by teams with other things to do. A Kyverno policy does the rewrite at
admission time instead, so pods pull through the cache now and the manifests
catch up at whatever pace suits their owners.

> [!NOTE] Versions and placeholders
>
> Kyverno `ClusterPolicy` syntax as of December 2024 (`foreach` with
> `patchStrategicMerge`), tested in the
> [Kyverno playground](https://playground.kyverno.io). `<registry>` stands
> for `111111111111.dkr.ecr.eu-west-1.amazonaws.com`; the account id and
> region are placeholders. The finished policy is
> [open in the playground](https://tinyurl.com/kyverno-playground).

## What Kyverno does here

[Kyverno](https://kyverno.io) is a policy engine that runs as an admission
webhook: a `ClusterPolicy` with a `mutate` rule changes a resource between the
API server receiving it and storing it. The rule here matches pod creation,
looks at each container whose image comes from one of the upstream registries,
and rewrites the image to the cache’s prefix for that registry. Kyverno’s own
[example](https://kyverno.io/policies/other/replace-image-registry-with-harbor/replace-image-registry-with-harbor)
replaces one static registry with another; the version below also handles
what Docker Hub leaves implicit, which is most of the work.

## The policy

One rule, one registry:

```yaml title="patch-docker-io.yaml"
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: patch-docker-io-image-registry
spec:
  # admission only: pods that already exist are left alone
  background: false
  rules:
    - name: patch-image-registry-pod
      match:
        resources:
          kinds: [Pod]
      mutate:
        foreach:
          # `|| []`: a pod with only initContainers has no .spec.containers
          - list: "request.object.spec.containers || []"
            preconditions:
              all:
                # kyverno parses the image, so `python:3.12` is docker.io
                - key: '{{ images.containers."{{element.name}}".registry }}'
                  operator: Equals
                  value: docker.io
            context:
              - name: registry
                variable:
                  value: "111111111111.dkr.ecr.eu-west-1.amazonaws.com"
              - name: prefix
                variable:
                  value: "docker-hub"
              # the capture group is what lands after the prefix
              - name: upstream
                variable:
                  value: "^docker\\.io/(.*)$"
              # `python:3.12` means `library/python:3.12` on docker hub
              - name: withLibrary
                variable:
                  value: >-
                    {{ regex_replace_all('^([^/]+)$',
                    '{{ element.image }}', 'library/$1') }}
              # adds the registry and `:latest` where they were omitted
              - name: normalized
                variable:
                  value: "{{ image_normalize(withLibrary) }}"
              - name: finalImage
                variable:
                  value: >-
                    {{ regex_replace_all('{{ upstream }}', normalized,
                    '{{ registry }}/{{ prefix }}/$1') }}
            patchStrategicMerge:
              spec:
                containers:
                  - name: "{{ element.name }}"
                    image: "{{ finalImage }}"
```

Two things the rule has to know that a manifest does not say. An image with
no slash in it, `python:3.12`, lives under Docker Hub’s `library/` namespace,
and the cache’s repository path has to say so, hence `withLibrary`. And an
image with no registry or no tag is `docker.io/…:latest`;
[`image_normalize`](https://kyverno.io/docs/writing-policies/jmespath/#image_normalize)
writes both out, so the rewritten reference is fully qualified and the
repository ECR creates has an unambiguous name.

## Testing it in the playground

The [playground](https://playground.kyverno.io) takes the policy on the left
and a resource on the right and shows the mutated result. A pod with five
containers covers the cases:

```yaml title="pod.yaml"
apiVersion: v1
kind: Pod
metadata:
  name: multi-registry-example
spec:
  containers:
    - name: nginx
      image: nginx
    - name: library-nginx
      image: library/nginx
    - name: docker-io-library-nginx
      image: docker.io/library/nginx
    - name: acme-api
      image: docker.io/acme/api:1.4
    - name: ubuntu
      image: public.ecr.aws/ubuntu/ubuntu:edge
```

The four Docker Hub images come out fully qualified under the cache, and
the ECR Public one, not this rule’s business, comes out unchanged:

| Image in the manifest | After the policy |
| --- | --- |
| `nginx` | `<registry>/docker-hub/library/nginx:latest` |
| `library/nginx` | `<registry>/docker-hub/library/nginx:latest` |
| `docker.io/library/nginx` | `<registry>/docker-hub/library/nginx:latest` |
| `docker.io/acme/api:1.4` | `<registry>/docker-hub/acme/api:1.4` |

## Init and ephemeral containers

A pod has three container lists, and a policy that patches `containers`
leaves `initContainers` and `ephemeralContainers` pulling from upstream. Each
list is a `foreach` entry of its own, with the same preconditions, context and
patch aimed at its own field:

```yaml
      mutate:
        foreach:
          - list: "request.object.spec.containers || []"
            # ... preconditions, context and patch as above ...
          - list: "request.object.spec.initContainers || []"
            # ... the same, patching spec.initContainers ...
          - list: "request.object.spec.ephemeralContainers || []"
            # ... the same, patching spec.ephemeralContainers ...
```

## One chart, many registries

Three lists times four registries is twelve copies of the same block, and my
attempt at one rule that handled every registry ran into rules conflicting
with each other. A Helm chart that renders one `ClusterPolicy` per registry
keeps the policies simple and the duplication in a template:
[shmileee/helm-charts, `kyverno-patch-registries`](https://github.com/shmileee/helm-charts/tree/main/charts/kyverno-patch-registries).
Its values name the same four upstreams the cache was configured for:

```yaml title="values.yaml"
common:
  ecrRegistryFullname: "111111111111.dkr.ecr.eu-west-1.amazonaws.com"

registriesToOverwrite:
  docker.io:
    upstreamUrlRegexp: '^docker\\.io/(.*)$'
    ecrPrefixName: "docker-hub"
  public.ecr.aws:
    upstreamUrlRegexp: '^public\\.ecr\\.aws/(.*)$'
    ecrPrefixName: "public-ecr"
  quay.io:
    upstreamUrlRegexp: '^quay\\.io/(.*)$'
    ecrPrefixName: "quay"
  registry.k8s.io:
    upstreamUrlRegexp: '^registry\\.k8s\\.io/(.*)$'
    ecrPrefixName: "registry-k8s-io"
```

## Rolling out by namespace

A wrong regular expression, or a cluster whose nodes cannot pull from ECR
yet, stops every new pod in the cluster, so the policies apply only to
namespaces that carry a label. The chart adds the selector to every rule’s
`match`:

```yaml
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaceSelector:
                matchLabels:
                  pull-through-enabled: "true"
```

Enabling one namespace, then all of them, is two commands:

```bash
kubectl label namespace <namespace> pull-through-enabled=true --overwrite
kubectl label namespaces --all pull-through-enabled=true --overwrite
```

## Drift in Argo CD

A mutated pod no longer matches the manifest in Git, so Argo CD marks the
`Application` as out of sync. Either update the manifests, which is the plan
anyway and now has no deadline, or tell Argo CD to
[ignore differences](https://argo-cd.readthedocs.io/en/stable/user-guide/diffing/#application-level-configuration)
in `.spec.containers[].image` for the affected applications. The second
option also hides an image change someone made by hand, so it is a bridge,
not a destination. The `ApplicationSet` objects that generate those
applications are the subject of two earlier posts,
[part one](/blog/posts/demystifying-argocd-applicationsets-pt1/) and
[part two](/blog/posts/demystifying-argocd-applicationsets-pt2/).

## Limitations

`background: false` means the policy touches new pods only. Running pods keep
their upstream images until something recreates them, so a namespace is not
on the cache until its deployments have rolled once.

A mutating webhook on every pod puts Kyverno on the path of every pod start.
With `failurePolicy: Fail` a Kyverno outage stops scheduling; with `Ignore`,
pods created during the outage pull from upstream unrewritten, and nothing
reports it.

The regular expressions have to agree with the cache’s prefixes exactly. A
mismatch breaks image pulls for every new pod in a labelled namespace, which
is what the label is for, and the nodes still need the permissions from the
previous post or the first pull of each image fails.

Kyverno has since added CEL-based policy kinds alongside `ClusterPolicy`. The
syntax above still applies; a new policy written today would look different.
