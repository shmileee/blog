---
title: Demystifying ArgoCD's ApplicationSet — Pt. 1
categories:
  - argocd
  - kubernetes
layout: post
date: 2024-12-11
---

`ApplicationSet` is a custom resource (CR) that describes how to create a set
of `Application` resources. This CR includes an `Application` template and an
area to define the source of truth. `ApplicationSet` supports several sources
of truth through a variety of
[generators](https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/Generators).

## Generators

Generators are a cornerstone of `ApplicationSet`, enabling the dynamic creation
of `Application` resources based on various inputs. A wide range of generators
is available, each designed to serve specific use cases, with the ArgoCD
maintainers continuously expanding the list. Each generator comes with its own
unique interface and supported options. Notably, the `matrix` generator allows
you to combine the parameters produced by two separate generators, adding even
greater flexibility.

We’ll cover the most straightforward yet widely used generators, suitable for
addressing a broad range of common use cases.

### Generator: `list`

Very simple -- generates parameters based on an arbitrary list of key/value
pairs (as long as the values are string values). These key/value pairs can be
referenced as variables in the `.spec.template`.

**Example:**

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: example
spec:
  generators:
    - list:
        elements:
          - appName: atlantis
            namespace: automation
          - appName: crossplane
            namespace: crossplane-system
  template:
    metadata:
      name: "example"
    spec:
      source:
        helm:
          valueFiles:
            - "{% raw %}{{ appName }}-values.yaml{% endraw %}"
      destination:
        namespace: "{% raw %}{{ namespace }}{% endraw %}"
```

### Generator: `cluster`

Allows you to target Kubernetes clusters configured and managed by ArgoCD.
Since the clusters are configured through native Kubernetes secrets (object of
`kind: Secrets`) with `argocd.argoproj.io/secret-type: cluster` annotation, the
`ApplicationSet` controller will parse these secrets to generate parameters for
each cluster.

This generator provides the following parameters:

- `name`: Cluster name in ArgoCD - the name field of the secret.
- `server`: Server URI - the server field of the secret.
- `metadata.labels.*`: Key/value pairs for each label of secret.
- `metadata.labels.*`: Key/value pairs for each annotation of the secret.

The `cluster` generator is a map that, by default, targets all Kubernetes
clusters configured and managed by ArgoCD, but it also allows you to target a
specific cluster using a selector, such as label. The `in-cluster` label in the
example below basically means "_the current cluster where ArgoCD is running_".

**Example:**

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: example
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            name: in-cluster
  template:
    metadata:
      name: "example"
    spec:
      source:
        helm:
          valueFiles:
            - "{% raw %}{{ metadata.labels.env }}-values.yaml{% endraw %}"
      destination:
        server: "{% raw %}{{ server }}{% endraw %}"
```

### Generator: `matrix`

Special type of generator that combines parameters from two other generators.

For example, you might want to deploy a list of applications (`list` generator)
across all your clusters (`cluster` generator).

**Example:**

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: example
spec:
  generators:
    - matrix:
        generators:
          - list:
              elements:
                - appName: example1
                - appName: example2
          - clusters:
              selector:
                matchLabels:
                  name: in-cluster
  template:
    metadata:
      name: "{% raw %}application-{{ appName }}{% endraw %}"
    spec:
      source:
        path: "{% raw %}path-within-repo/kustomize/overlays/{{ appName }}{% endraw %}"
      destination:
        server: "{% raw %}{{ server }}{% endraw %}"
```

## Real Life Examples

Once you’re familiar with these three commonly used generators, you can combine
them to create various input permutations, enabling efficient management of
multiple environments, applications, or clusters within a single file. Whether
this approach suits your needs depends on your specific use case. I find it
particularly effective in scenarios where a monorepo is well-organized with
clear ownership, such as using `CODEOWNERS` to assign specific teams to
maintain their respective `ApplicationSet`s. With a well-defined convention,
such setup can also facilitate automated updates of these files using tools
like [Renovate](https://mend.io/renovate).

The example configuration below demonstrates the true flexibility:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: elasticsearch-exporter
spec:
  generators:
    - matrix:
        generators:
          - list:
              elements:
                - clusterName: california
                  clusterNamespace: blue
                  revision: "main"
                  environment: "development"
                - clusterName: monaco
                  clusterNamespace: green
                  revision: "main"
                  environment: "development"
                - clusterName: california
                  clusterNamespace: blue
                  revision: "elasticsearch-exporter-v1.3.0"
                  environment: "staging"
                - clusterName: monaco
                  clusterNamespace: green
                  revision: "elasticsearch-exporter-v2.0.0"
                  environment: "staging"
          - clusters:
              selector:
                matchExpressions:
                  - key: environment
                    operator: In
                    values:
                      - "{% raw %}{{ environment }}{% endraw %}"
                  - key: name
                    operator: In
                    values:
                      - "in-cluster"
  template:
    metadata:
      name: "{% raw %}elasticsearch-exporter-{{ clusterName }}{% endraw %}"
    spec:
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: "{% raw %}{{ revision }}{% endraw %}"
        path: "{% raw %}clusters/elasticsearch-exporter/overlays/{{ clusterName }}{% endraw %}"
      destination:
        server: "{% raw %}{{ server }}{% endraw %}"
        namespace: "{% raw %}{{ clusterNamespace }}{% endraw %}"
```

---

### Conclusion

This post provides a concise overview of real-life use cases for the most
common generators in ArgoCD's `ApplicationSet`. For a deeper dive into
practical examples and detailed options on leveraging variables produced by
these generators, particularly when configuring the `.source` field for
manifests, check out [this]({% post_url
2024-12-12-demystifying-argocd-applicationsets-pt2 %}) post.
