---
title: "Pointing an ApplicationSet at Helm and Kustomize: five options"
description: The source field renders manifests four different ways; the constraint that picks each option, the fields it needs, and the setting Argo CD needs before Kustomize may inflate a chart.
date: 2024-12-11 11:00:00
categories:
  - argocd
  - kubernetes
  - gitops
---

The generators from
[the first post](/blog/posts/demystifying-argocd-applicationsets-pt1/)
produce parameters; the template’s `spec.source` is where they are spent, and
it is the field newcomers find ambiguous, because Argo CD renders manifests
four different ways and each wants a different subset of it. Below are the
five ways I point an `ApplicationSet` at Helm and Kustomize, each with the
one constraint that decides for it.

> [!NOTE] Series and versions
>
> Second of two posts on `ApplicationSet`. Argo CD 2.x and kustomize 5 as of
> December 2024; repositories, chart versions and paths are placeholders. The
> [`Application` specification](https://argo-cd.readthedocs.io/en/latest/user-guide/application-specification)
> lists every field.

## What `source` needs, by kind

| Field | Helm repo | Chart in Git | Kustomize |
| --- | --- | --- | --- |
| `repoURL` | chart repository | Git repository | Git repository |
| `targetRevision` | chart version | branch or tag | branch or tag |
| `path` | — | chart directory | overlay directory |
| `chart` | chart name | — | — |
| `helm.values` | inline values | inline values | — |
| `helm.valueFiles` | — | files beside it | — |
| `kustomize.*` | — | — | images, patches |

Generator variables can appear in any of these; `{{ metadata.labels.env }}`
inside a `valueFiles` entry is how one set serves several environments.

## Option 1: a chart from a Helm repository

For a third-party chart with a handful of overrides. The chart repository is
not yours, so there is nowhere to put a values file: overrides are inline,
and the same for every application the set generates unless a generator
variable supplies them:

```yaml
spec:
  template:
    spec:
      source:
        repoURL: https://kubernetes-sigs.github.io/metrics-server
        chart: metrics-server
        targetRevision: 3.12.2
        helm:
          values: |
            fullnameOverride: metrics-server
```

## Option 2: a chart in Git

For a chart that needs a values file per environment. A directory in your
repository holds a `Chart.yaml` that declares the real chart as a dependency,
and the value files beside it:

```yaml
spec:
  generators:
    - clusters: {}
  template:
    spec:
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: main
        path: charts/vault
        helm:
          valueFiles:
            - common-values.yaml
            - "{{ metadata.labels.env }}-values.yaml"
```

```yaml title="charts/vault/Chart.yaml"
apiVersion: v2
name: vault
version: 1.0.0
dependencies:
  - name: vault
    version: 0.28.1
    repository: https://helm.releases.hashicorp.com
```

The dependency is a subchart, so every value in those files sits under the
dependency’s name, `vault:`, not at the top level.

## Option 3: a Kustomize directory

For manifests of your own. `path` names a directory with a
`kustomization.yaml`, and Argo CD runs `kustomize build` on it:

```yaml
spec:
  template:
    spec:
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: main
        path: kustomize/overlays/production
```

## Option 4: a chart inflated by Kustomize

For a third-party chart that needs patches after rendering. Kustomize’s
`helmCharts` field downloads and renders the chart, and the rest of the
kustomization applies to the result; the `ApplicationSet` points at the
directory exactly as in option 3:

```yaml title="kustomize/grafana/kustomization.yaml"
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
helmCharts:
  - name: grafana
    version: 8.5.1
    repo: https://grafana.github.io/helm-charts
    valuesFile: values.yaml
patches:
  - path: ingress-patch.yaml
```

Argo CD does not inflate charts by default. The repo server runs
`kustomize build` without `--enable-helm`, and a kustomization with
`helmCharts` fails with `must specify --enable-helm` until the option is
added to the build flags in `argocd-cm`:

```yaml title="argocd-cm.yaml"
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  kustomize.buildOptions: --enable-helm
```

One values file per chart was the field’s limit for a long time. Kustomize 5
added `additionalValuesFiles`, so common plus per-environment values no
longer need option 5, unless the chart definition itself is shared across
overlays.

## Option 5: `HelmChartInflationGenerator`

> [!WARNING] Deprecated generator
>
> `HelmChartInflationGenerator` is deprecated in favour of `helmCharts`,
> which now takes the same fields. What the generator still does that a
> `helmCharts` entry cannot is be shared: one definition in a base directory,
> referenced from every overlay, with each overlay’s own `values.yaml` merged
> over it.

For a third-party chart with several overlays that each add their own values
on top of shared ones. The generator lives in a base directory; each overlay
references it and contributes a `values.yaml` that merges over the base’s:

```yaml title="kustomize/argocd/base/helm-generator.yaml"
apiVersion: builtin
kind: HelmChartInflationGenerator
metadata:
  name: argocd-helm-chart
name: argo-cd
version: 7.7.7
repo: https://argoproj.github.io/argo-helm
releaseName: argo
namespace: argocd
includeCRDs: true
valuesFile: values.yaml
valuesMerge: override
```

```yaml title="kustomize/argocd/overlays/production/kustomization.yaml"
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: argocd
generators:
  - ../../base/helm-generator.yaml
resources:
  - ../../shared
```

Every overlay needs its own `values.yaml`, empty if it has nothing to add,
because `valuesFile` is resolved against the overlay that runs the
generator. The `ApplicationSet` points at the overlay, and `--enable-helm`
applies here too:

```yaml
spec:
  template:
    spec:
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: main
        path: kustomize/argocd/overlays/production
```

## Limitations

Four rendering paths in one field means four ways to be wrong, and the error
surfaces in the repo server’s logs rather than in the manifest. `helm
template`, `kustomize build --enable-helm` and `argocd app manifests <app>`
are the three commands that show what Argo CD will actually apply, and a
change to a `source` is not reviewed until one of them has run.

Options 4 and 5 download the chart on every render. A repo server that
renders many applications from the same chart fetches it many times, and an
unreachable chart repository fails every one of them at once.

`targetRevision` means different things by kind: a chart version for a Helm
repository, a Git ref otherwise. A generator that supplies it has to know
which kind of source it is filling.

Option 5 is on borrowed time. Kustomize keeps the generator for
compatibility and a future release may drop it; the overlays that share one
generator are the ones to migrate first, each getting a `helmCharts` entry of
its own.
