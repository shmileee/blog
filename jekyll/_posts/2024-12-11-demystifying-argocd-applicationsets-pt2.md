---
title: Demystifying ArgoCD's ApplicationSet — Pt. 2
categories:
  - argocd
  - kubernetes
layout: post
date: 2024-12-11 11:00
---

In the [previous]({% post_url
2024-12-11-demystifying-argocd-applicationsets-pt1 %}) post, I covered the most
common generators for `ApplicationSet`. These generators primarily produce
variables used in the `.spec.template.spec.source` configuration, which defines
how ArgoCD retrieves and processes Kubernetes manifests.

However, the `.source` field can be ambiguous for newcomers, so let’s break it
down briefly -- below is a simplified decluttered summary of its supported
directives and attributes. For the full list, refer to the [official
`Application` specification
reference](https://argo-cd.readthedocs.io/en/latest/user-guide/application-specification):

1. **Common**:
   - **`repoURL`**: Points to a Git repository or a Helm chart repository.
   - **`targetRevision`**: Specifies the Git branch, tag, or Helm chart version.
   - **`path`**: Defines the directory within the repository (irrelevant for Helm repositories).
2. **Helm**:
   - **`chart`**: Specifies the chart name for Helm repositories.
   - **`helm`**:
     - `parameters`: Key-value overrides for chart values.
     - `valueFiles`: YAML files for overriding chart values.
     - `values`: Inline chart values (variables coming from generators can be used here).
     - Miscellaneous options like `skipCrds`, `namespace`, etc.
3. **Kustomize**:
   - Options for transformers (`namePrefix`, `commonLabels`, etc.).
   - `images`: Overrides container images.
   - `components`: Includes external components.
   - `patches`: Applies custom patches to resources.
4. **Directory (Jsonnet)**:
   - `recurse`: Recursively processes subdirectories.
   - `jsonnet`: Configures Jsonnet-based processing with `extVars`, `tlas`, etc.
   - `exclude` and **`include`**: Filters files by glob patterns.

---

### Deployment Options for Helm and Kustomize

#### **Option 1: `helm` Directive With a Helm Repository**

This is the simplest approach for deploying services primarily provided as
community Helm charts. Specify the chart, repository, and values directly in
the `ApplicationSet`. In this scenario there's no way how one can supply
multiple Helm value files (e.g. to distinguish between the environments) since
the `values.yaml` file must reside in the Helm repository, to which you do not
have access to.

**Example**:

```yaml
spec:
  template:
    spec:
      source:
        chart: metrics-server
        repoURL: "https://kubernetes-sigs.github.io/metrics-server"
        targetRevision: v3.8.2
        helm:
          values: |
            fullnameOverride: metrics-server
```

#### **Option 2: `helm` Directive with a Git Repository**

Suitable approach for services requiring multiple Helm value files. Point to a
Git directory containing the `Chart.yaml` and value files.

**Example**:

```yaml
spec:
  generators:
    - clusters:
        selector:
          matchLabels:
            name: in-cluster
  template:
    spec:
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: main
        path: path-to/vault-helm-chart
        helm:
          valueFiles:
            - common-values.yaml
            - "{% raw %}{{ metadata.labels.env }}-values.yaml{% endraw %}"
```

**`Chart.yaml` example**:

```yaml
apiVersion: v2
name: vault
version: 1.0.0
dependencies:
  - name: vault
    version: 0.22.0
    repository: https://helm.releases.hashicorp.com
```

The `Chart.yaml` can reference local and remote charts under the `dependencies`
key. You also need to remember to put the values under the respective chart's
name as they're subcharts now.

#### **Option 3: Plain `kustomization.yaml`**

For resources stored directly in Git without Helm dependencies, point to a path
within repository that contains a `kustomization.yaml` file.

**Example**:

```yaml
spec:
  template:
    spec:
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: main
        path: path-within-repo/example
```

Then in `path-within-repo/example`, you'll have a simple `kustomization.yaml`
that points to specific manifests.

#### **Option 4: `helmCharts` Directive in a `kustomization.yaml`**

`kustomize` has a native support for downloading Helm chart with `helmCharts`
directive. Read more about it
[here](https://cloud.google.com/kubernetes-engine/enterprise/config-sync/docs/tutorials/config-sync-helm).

This approach is best suited for a deployment that is shared as a Helm chart,
where you do **NOT** have a requirement for having multiple Helm value files,
but instead have a bunch of `kustomization`s you want to apply after the chart
is rendered.

An example `ApplicationSet` that uses such approach is pretty straightforward,
you just point to the directory within repository like in the previous example.

**Example**:

```yaml
spec:
  template:
    spec:
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: main
        path: path-to/resources
```

... and example `kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
helmCharts:
  - name: grafana
    version: 8.5.1
    repo: https://grafana.github.io/helm-charts
    valuesFile: values.yaml
```

#### **Option 5: `kustomization.yaml` with `HelmChartInflationGenerator`**

> ⚠️ The `HelmChartInflationGenerator` has been deprecated. It is recommended to
> use `helmCharts`, which was intended to serve as a drop-in replacement.
> However, as of today, it still lacks the full flexibility of its predecessor.

This approach is currently the most flexible way to deploy a third-party Helm
chart that requires multiple Helm values files while also applying extensive
`kustomization`s on top of the rendered manifests. Typically, this setup
involves multiple `kustomize` overlays.

The definition of a `HelmChartInflationGenerator` object can be stored in a
`helm-generator.yaml` file within the `base` overlay, e.g.:

```yaml
apiVersion: builtin
kind: HelmChartInflationGenerator
metadata:
  name: argocd-helm-chart
name: argo-cd
version: 5.4.3
repo: https://argoproj.github.io/argo-helm
releaseName: argo
namespace: argocd
includeCRDs: true
valuesFile: values.yaml
valuesMerge: override
valuesInline: ...
```

In each overlay (e.g. `production`), you reference this file under the
`generators` section:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: argocd
generators:
  - ../base/helm-generator.yaml
resources:
  - ../shared
```

Each overlay must include a `values.yaml` file (which can be empty). The file
can merge with, override, or replace the common values specified in
`helm-generator.yaml`, depending on the `valuesMerge` setting in the
`HelmChartInflationGenerator` definition.

And finally, similar to the previous examples, the `ApplicationSet` points to a
specific path within a repository that contains `kustomization.yaml`:

```yaml
spec:
  template:
    spec:
      source:
        repoURL: git@github.com:org/repo.git
        targetRevision: main
        path: path-to/yet-another-example/overlays/production
```

It’s important to consider the
[ordering](https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/#ordering)
of files and how `kustomize` processes them to ensure the desired outcome.

---

### Conclusion

Each deployment approach comes with its own strengths and limitations, making
the choice highly dependent on the complexity of the service and its
customization needs. Combining `ApplicationSet` with Helm and Kustomize offers
a powerful and scalable solution for managing deployments across multiple
clusters and environments.

However, this level of abstraction can be overwhelming for newcomers. The added
complexity and multiple layers of abstraction also make local testing more
challenging, increasing the risk of unintended changes during the development
process.
