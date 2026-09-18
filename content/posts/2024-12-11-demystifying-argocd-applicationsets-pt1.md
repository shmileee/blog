---
title: "Argo CD ApplicationSet generators: list, cluster and matrix"
description: One ApplicationSet produces many Applications; the three generators that supply its parameters, what each one yields, and the matrix trick that pins a revision per environment.
date: 2024-12-11 10:30:00
categories:
  - argocd
  - kubernetes
  - gitops
---

An `ApplicationSet` is one resource that produces many Argo CD `Application`s:
a template for the application, plus a *generator* that supplies one set of
parameters per application to produce. Ten services across four clusters is
forty `Application` manifests written by hand, or one `ApplicationSet` whose
generator yields forty parameter sets. This post is about the three
generators that cover nearly everything I deploy, `list`, `cluster` and
`matrix`, and what each one produces.

> [!NOTE] Series and versions
>
> First of two posts on `ApplicationSet`; the second,
> [Pointing an ApplicationSet at Helm and Kustomize: five options](/blog/posts/demystifying-argocd-applicationsets-pt2/),
> is about the `source` field the parameters end up in. Argo CD 2.x as of
> December 2024; cluster names, repositories and namespaces are placeholders.

## The list generator

The parameters are written out by hand, one map per application, and every
key becomes a variable in the template:

```yaml title="platform-tools.yaml"
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform-tools
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
      name: "{{ appName }}"
    spec:
      project: default
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: main
        path: "charts/{{ appName }}"
        helm:
          valueFiles: ["{{ appName }}-values.yaml"]
      destination:
        server: https://kubernetes.default.svc
        namespace: "{{ namespace }}"
```

The controller creates two `Application`s from it, and keeps them in step
with the list: an element removed is an application deleted.

| Application | `source.path` | `helm.valueFiles` | `destination.namespace` |
| --- | --- | --- | --- |
| `atlantis` | `charts/atlantis` | `atlantis-values.yaml` | `automation` |
| `crossplane` | `charts/crossplane` | `crossplane-values.yaml` | `crossplane-system` |

## The cluster generator

One parameter set per cluster Argo CD knows. Clusters are registered as
secrets labelled `argocd.argoproj.io/secret-type: cluster`, and the generator
reads them: `name` and `server` from the secret’s fields, plus every label and
annotation as `metadata.labels.*` and `metadata.annotations.*`. A selector
narrows the set; without one, every cluster is in. The cluster Argo CD itself
runs in is named `in-cluster`.

Here each cluster carries an `env` label, and the values file follows it:

```yaml title="metrics-server.yaml"
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: metrics-server
spec:
  generators:
    - clusters: {}
  template:
    metadata:
      name: "metrics-server-{{ name }}"
    spec:
      project: default
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: main
        path: charts/metrics-server
        helm:
          valueFiles: ["{{ metadata.labels.env }}-values.yaml"]
      destination:
        server: "{{ server }}"
        namespace: kube-system
```

With two registered clusters, `california` labelled `env: development` and
`monaco` labelled `env: production`:

| Application | `helm.valueFiles` | `destination.server` |
| --- | --- | --- |
| `metrics-server-california` | `development-values.yaml` | california’s API server |
| `metrics-server-monaco` | `production-values.yaml` | monaco’s API server |

## The matrix generator

The Cartesian product of two generators: every parameter set of the first
combined with every set of the second. A list of applications times the
clusters is the common case:

```yaml title="team-tools.yaml"
spec:
  generators:
    - matrix:
        generators:
          - list:
              elements:
                - appName: external-dns
                - appName: cert-manager
          - clusters: {}
  template:
    metadata:
      name: "{{ appName }}-{{ name }}"
    spec:
      project: default
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: main
        path: "kustomize/overlays/{{ appName }}"
      destination:
        server: "{{ server }}"
        namespace: "{{ appName }}"
```

Two applications times the same two clusters is four `Application`s:
`external-dns-california`, `external-dns-monaco`, `cert-manager-california`
and `cert-manager-monaco`.

## A revision per environment

The second generator in a matrix may use the first generator’s parameters,
which turns the product into a join. Here the list carries an environment
and the revision to deploy there, and the cluster selector reads the
environment from the list, so each element lands only on its own clusters
and staging can run a tagged release while development follows `main`:

```yaml title="elasticsearch-exporter.yaml"
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
                - environment: development
                  revision: main
                - environment: staging
                  revision: elasticsearch-exporter-v1.3.0
          - clusters:
              selector:
                matchLabels:
                  env: "{{ environment }}"
  template:
    metadata:
      name: "elasticsearch-exporter-{{ name }}"
    spec:
      project: default
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: "{{ revision }}"
        path: "kustomize/elasticsearch-exporter/overlays/{{ name }}"
      destination:
        server: "{{ server }}"
        namespace: monitoring
```

The `revision` values are the fields a tool such as
[Renovate](https://mend.io/renovate) can bump in a pull request, and in a
monorepo with `CODEOWNERS` routing each `ApplicationSet` to its team, that
pull request goes to the people who own the deployment.

## Limitations

Every generated parameter is a string unless the `ApplicationSet` sets
`goTemplate: true`; a list element with a number or a boolean in it has to
quote it, and nested maps flatten to dotted keys.

A generator that produces nothing produces a deletion. A cluster secret
removed by mistake, or a list emptied by a bad merge, deletes every
`Application` the set owned, and with the default sync policy their
resources with them. `preserveResourcesOnDeletion` and a sync policy of
`create-only` are the guard rails, and they are opt-in.

Template names must be unique across everything the set generates. Two
elements that render the same `metadata.name` yield one `Application` and an
error in the controller’s log about the other.

The cluster generator sees only clusters registered with Argo CD. A cluster
added to the fleet but not to Argo CD is not a target, and no application
tells you so.

## What’s next?

Everything above puts variables into `template.spec.source`, and that field
is where the real choices are: a chart from a Helm repository, a chart in
Git, a Kustomize overlay, or Kustomize inflating a chart.
[Pointing an ApplicationSet at Helm and Kustomize: five options](/blog/posts/demystifying-argocd-applicationsets-pt2/)
takes them one at a time.
