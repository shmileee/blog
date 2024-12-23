---
title: "Rewriting Docker Image Registries with Kyverno"
layout: post
date: 2024-12-23 12:28:00
categories:
  - kubernetes
  - aws
  - argocd
---

As a continuation of [Setting Up Pull Through Cache Repositories in AWS
ECR](./2024-12-12-setting-up-pull-through-cache-repositories-in-aws-ecr.md),
you might want to roll them out gradually to a live Kubernetes cluster without
causing disruption or excessive effort. While you will eventually need to
update your manifests to point to the correct ECR registry, scaling this across
multiple clusters and namespaces is a complex task. Fortunately, tools like
Kyverno can simplify this process.

---

### What is Kyverno?

[Kyverno](https://kyverno.io) is a Kubernetes-native policy engine that allows you to define rules
(policies) to validate, mutate, or generate Kubernetes configurations. It helps
ensure your clusters adhere to best practices and security standards
automatically. In this scenario, Kyverno's mutating capabilities are
particularly useful. By creating a policy, you can dynamically rewrite image
registries to the desired ones (like those set up in the previous post) without
modifying the actual manifests. This gives you valuable time to update
manifests while already benefiting from ECR's features.

A few key highlights about Kyverno's functionality:

- [Install](https://kyverno.io/docs/installation) Kyverno in your cluster.
- Define policies using native YAML syntax by creating a `ClusterPolicy` object
  and applying it.
- From now on, Kyverno's controller intercepts incoming requests to the
  cluster, modifying them before they are persisted.

To illustrate, here’s a simple example of a `ClusterPolicy` that uses the
mutate feature to add a label to all newly created pods:

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-label
spec:
  rules:
    - name: add-label
      match:
        resources:
          kinds:
            - Pod
      mutate:
        patchesJson6902: |
          - op: add
            path: "/metadata/labels/environment"
            value: "default"
```

See more examples and explanation [here](https://kyverno.io/docs/introduction).

---

### How Kyverno Simplifies Image Registry Rewrites

In a similar way, you can create a policy to modify the image registry
dynamically. Although the official Kyverno documentation provides [_some
examples_](https://kyverno.io/policies/other/replace-image-registry-with-harbor/replace-image-registry-with-harbor)
of such policies, they are often overly simplistic (e.g., rewriting static
registry `A` to static registry `B`). With slightly more complex but flexible
methods, you can achieve dynamic behavior suited to a wider range of scenarios.

Let’s break this process into a step-by-step tutorial for building a scalable
`ClusterPolicy`.

### Step 1: Define the Bare Bones

Let’s start with a simple use case: redirecting all images pulled from the
public DockerHub registry to a configured pull through cache repository in ECR,
specifically for DockerHub.

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: patch-docker-io-image-registry
  annotations:
    policies.kyverno.io/title: "Patch Image Registry 'docker.io'"
spec:
  # Only apply this policy to newly created resources.
  background: false
  rules:
    - name: patch-image-registry-pod
      match:
        resources:
          kinds:
            - Pod
      mutate:
        foreach:
          # Iterate over every container defined in a Pod. Defaults to an empty list
          # if `.spec.containers` is absent, such as when only `initContainers` or
          # `ephemeralContainers` are defined.
          - list: "request.object.spec.containers || []"
            preconditions:
              all:
                # Check if the image registry is `docker.io`. Kyverno normalizes images
                # without explicitly set registries, so `python:3.12` defaults to `docker.io`.
                - key: '{% raw %}{{ images.containers."{{ element.name }}".registry }}{% endraw %}'
                  operator: Equals
                  value: docker.io
            context:
              # A helper variable for the full ECR registry URL.
              - name: ecrRegistryFullname
                variable:
                  # Replace the account ID and region to match your setup.
                  value: "111111111111.dkr.ecr.eu-west-1.amazonaws.com"
              # Regular expression to match `docker.io` images. Note: a capture group `(.*)` is required.
              - name: upstreamUrlRegexp
                variable:
                  value: "^docker\\.io/(.*)$"
              # Prefix for the ECR namespace configured as a pull through cache. See the previous blog post for details.
              - name: ecrPrefixName
                variable:
                  value: "docker-hub"
              # Prepend `library/` if no repository is specified (e.g., `python:3.12`).
              - name: withDefaultRepository
                variable:
                  value: "{% raw %}{{ regex_replace_all('^([^/]+)$', '{{ element.image }}', 'library/$1') }}{% endraw %}"
              # Normalize:
              # - Add `docker.io` as the default registry if unspecified.
              # - Add `:latest` as the default tag if unspecified.
              - name: imageNormalized
                variable:
                  value: "{% raw %}{{ image_normalize(withDefaultRepository) }}{% endraw %}"
              # Replace the upstream URL pattern with the ECR registry prefix.
              - name: finalImage
                variable:
                  value: "{% raw %}{{ regex_replace_all('{{ upstreamUrlRegexp }}', imageNormalized, '{{ ecrRegistryFullname }}/{{ ecrPrefixName }}/$1') }}{% endraw %}"
            patchStrategicMerge:
              spec:
                containers:
                  - name: "{% raw %}{{ element.name }}{% endraw %}"
                    image: "{% raw %}{{ finalImage }}{% endraw %}"
```

This example is self-explanatory, with every step commented. Notably, Kyverno
simplifies certain tasks, such as exposing information about the default
registry (`docker.io`) when none is specified. Handling images from DockerHub
can be tricky, as images without a specified repository (e.g., `python:3.12`)
default to the `library` prefix when pulled. While it’s a good habit to
explicitly include the `library` prefix manifests, Kyverno’s mutating
capabilities allow you to handle these cases dynamically.

Additionally, Kyverno’s built-in
[`image_normalize()`](https://kyverno.io/docs/writing-policies/jmespath/#image_normalize)
function ensures consistency by appending the default registry and tag when
missing. While not strictly required, this practice improves clarity by
explicitly defining the image source and tag, which is helpful for debugging
and maintenance.

### Step 2: Test Your Policy in Kyverno's Playground

Before applying the policy to your cluster, use the [Kyverno
playground](https://playground.kyverno.io) to test it against a sample manifest
and visualize the mutation results.

1. Add your policy to the left pane of the playground interface.
2. Add the following manifest to the right pane:

   ```yaml
   apiVersion: v1
   kind: Pod
   metadata:
     name: multi-registry-example
     namespace: default
   spec:
     containers:
       - image: nginx
         name: nginx

       - image: library/nginx
         name: library-nginx

       - image: docker.io/library/nginx
         name: docker-io-library-nginx

       - image: docker.io/example-custom/example-custom
         name: example-custom-example-custom

       - image: public.ecr.aws/ubuntu/ubuntu:edge
         name: public-ecr-aws-ubuntu-ubuntu-edge
   ```

3. Click **Start** in the bottom-right corner. A popup will indicate whether
   the policy was successfully applied. If successful, the status will show as
   `pass`, and you'll see a "details" hyperlink.

4. Click the **Details** hyperlink to open a diff view, showing the manifest
   before and after the policy was applied. In this case, only images
   originating from DockerHub will show updates to their
   `.spec.containers[].image` fields.

If you encounter any issues, get stuck, or simply want to explore a
pre-configured example, you can use
[this](https://tinyurl.com/kyverno-playground) link to see the final result
in the Playground.

### Step 3: Take Other Containers Into Consideration

Per the [Kubernetes Pod
specification](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/),
in addition to application containers, a Pod can also include `initContainers`
that execute during startup and `ephemeralContainers` that can be injected for
debugging purposes. To fully proxy your containers to another registry, such as
ECR, you must account for these container types as well.

To include `initContainers` and `ephemeralContainers` in your policy, simply
duplicate the elements under the `foreach` list. Replace `containers` with
either `initContainers` or `ephemeralContainers` in the copied sections, and
you're all set.

If you want to test this updated policy in the playground, remember to
include relevant test data. For example:

```yaml
... omitted for brevity ...
spec:
  initContainers:
    - name: init-public-latest-tag
      image: docker.io/library/busybox:latest

    - name: init-public-ecr-versioned
      image: public.ecr.aws/ubuntu/ubuntu:20.04
```

### Step 4: Don't Repeat Yourself

Duplicating the same logic for `containers`, `initContainers`, and
`ephemeralContainers` quickly becomes tedious and error-prone. Now, imagine
scaling this policy to support additional registries like `quay.io` or
`ghcr.io`. While I initially aimed to make the policy as generic as possible to
handle multiple registries within a single rule, I ran into a maze of caveats
and unexpected behavior from Kyverno, where rules started conflicting with each
other.

To streamline the creation of consistent policies across multiple registries, a
better approach is to use a Helm chart. A Helm chart can dynamically generate
`ClusterPolicy` resources for each registry, reducing duplication and manual
effort. I’ve published such a chart under
[shmileee/helm-charts@main:charts/kyverno-patch-registries](https://github.com/shmileee/helm-charts/tree/main/charts/kyverno-patch-registries).

You can use it with a simple `values.yaml` file like this:

```yaml
common:
  ecrRegistryFullname: "111111111111.dkr.ecr.eu-west-1.amazonaws.com"

registriesToOverwrite:
  docker.io:
    upstreamUrlRegexp: '^docker\\.io/(.*)$'
    ecrPrefixName: "docker-hub"
  public.ecr.aws:
    upstreamUrlRegexp: '^public\\.ecr\\.aws/(.*)$'
    ecrPrefixName: "public-ecr"
  ghcr.io:
    upstreamUrlRegexp: '^ghcr\\.io/(.*)$'
    ecrPrefixName: "ghcr"
  quay.io:
    upstreamUrlRegexp: '^quay\\.io/(.*)$'
    ecrPrefixName: "quay"
  registry.k8s.io:
    upstreamUrlRegexp: '^registry\\.k8s\\.io/(.*)$'
    ecrPrefixName: "registry-k8s-io"
```

This approach allows you to easily scale and maintain policies for multiple
registries while avoiding repetitive and error-prone configurations.

### Step 5: Gradually Roll It Out

Applying cluster-wide policies, like the one we’ve created, requires caution.
If the regular expression is incorrect or the cluster lacks access to pull
images from ECR, pods will fail to start. To ensure a smooth rollout, it’s a
good practice to use a namespace selector to apply the policy only to specific
namespaces that meet defined criteria.

The Helm chart from the previous step includes a built-in namespace selector
based on a label. Kyverno checks for this label on namespaces and applies the
policy only if the label is present. By default, the label used is
`pull-through-enabled: true`, but you can customize it by setting the
`namespaceSelectorLabel` field in the `values.yaml`
([reference](https://github.com/shmileee/helm-charts/blob/main/charts/kyverno-patch-registries/values.yaml)).

When you’re ready to test the policy, label your target namespace:

```bash
kubectl label namespace <ns-name> pull-through-enabled=true --overwrite
```

If you’re confident and want to apply the policy across all namespaces, use:

```bash
kubectl label namespaces --all pull-through-enabled=true --overwrite
```

This method ensures a controlled rollout, allowing you to verify the policy’s
behavior before extending it cluster-wide.

### Step 6: Conclusion — Drift in GitOps

If you're using GitOps with a tool like ArgoCD, applying these policies to
redirect container image registries will inevitably cause a drift. ArgoCD will
flag your `Application` objects as out of sync because the live state no longer
matches the raw manifests in your Git repository.

To resolve this, you have two options:

1. Update the manifests to reflect the new registry.
2. Configure ArgoCD to ignore changes to the `.spec.containers[].images` field.
   Refer to [ArgoCD – Diffing – Diffing Customization – Application Level
   Configuration](https://argo-cd.readthedocs.io/en/stable/user-guide/diffing/#application-level-configuration)
   for guidance.

However, be cautious with the second approach, as ignoring updates to fields
like images is generally discouraged.

> 💡 If you're interested in learning more about `ApplicationSet` (a superset
> controller designed for managing `Application` objects at scale), check out my
> previous blog posts:
>
> - [Demystifying ArgoCD's ApplicationSet — Pt. 1]({% post_url 2024-12-11-demystifying-argocd-applicationsets-pt1 %})
> - [Demystifying ArgoCD's ApplicationSet — Pt. 2]({% post_url 2024-12-11-demystifying-argocd-applicationsets-pt2 %})
