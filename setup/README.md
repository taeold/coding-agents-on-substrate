# Setup

Every demo in this repo runs on a local kind cluster with Agent Substrate at
commit `551dd54e` (2026-10-27). You need Go, Docker and `kubectl` on the host.
Run the commands below from the root of this repo.

## Install Substrate

```bash
git clone https://github.com/agent-substrate/substrate.git ../substrate && cd ../substrate
git checkout 551dd54e
hack/create-kind-cluster.sh
hack/install-ate-kind.sh deploy ate-system \
  --credential-provider='{"name":"k8s.io"}' \
  --ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/default/sa/default
hack/install-ate-kind.sh publish worker-images   # prints the ateworker-gvisor ref
go install ./cmd/kubectl-ate
cd -
```

`publish worker-images` prints a ref like
`localhost:5001/ateworker-gvisor@sha256:...`. Each demo's `workerpool.yaml`
names the worker image as `ko://go.ate.dev/substrate/cmd/ateworker-gvisor`;
the demo READMEs substitute this ref with `sed`. Keep it in a variable:

```bash
WORKER=localhost:5001/ateworker-gvisor@sha256:...
```

A 2-core kind node fits one worker. To switch demos, scale the previous
demo's pool to zero first:

```bash
kubectl -n ate-demo-pi patch workerpool pi-durable --type merge -p '{"spec":{"replicas":0}}'
```

## Client pod

The router accepts only mutual TLS from pod identities on its ingress
allowlist. The install above allows the `default` service account in the
`default` namespace, and `client.yaml` is a pod with that identity. Requests
to actors go through it.

```bash
kubectl apply -f setup/client.yaml
```

`ate-curl` runs `curl` in the client pod against the router, with the target
actor as `<atespace>/<actor>`. Extra arguments go to `curl`.

```bash
setup/ate-curl ate-demo-pi/demo-agent /readyz
```

## Credential injection

The Pi and libfx demos keep a placeholder API key in the actor. The egress
gateway swaps in the real key from a Kubernetes Secret in the demo's
namespace. The bundled credential provider denies every atespace by default,
so grant each demo's atespace its own namespace and restart the provider,
which reads the policy only at startup:

```bash
kubectl -n ate-system patch configmap k8s-credential-provider-namespace-policy --type merge -p '
data:
  namespace-policy.yaml: |
    policies:
    - atespace: ate-demo-pi
      allowedNamespaces:
      - ate-demo-pi
    - atespace: ate-demo-fx
      allowedNamespaces:
      - ate-demo-fx
'
kubectl -n ate-system rollout restart deployment/k8s-credential-provider
```

The patch replaces the whole policy, so list every atespace that needs a
grant. The Cursor demo does not use injection; see
[../cursor-agent-sdk/README.md](../cursor-agent-sdk/README.md#egress).
