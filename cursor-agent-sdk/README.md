# cursor-agent-sdk

A [Cursor Agent SDK](https://cursor.com/docs/agent-sdk) agent running as an
[Agent Substrate](https://github.com/agent-substrate/substrate) actor, with the
same layout as [pi-durable](../pi-durable).

The agent is the smallest Agent SDK project that does anything: `bot/agent.ts`
picks the model, `bot/instructions.md` says "write the files you are asked for
and run them". The image runs `agent-sdk serve` with its state root on the
actor's durable `/workspace` volume, so sessions, conversation checkpoints and
the memory journal are all inside Substrate's snapshot.

## What runs where

The Agent SDK is not a harness you host. Per turn, the server you run opens a
stream to `api2.cursor.sh` (`agent.v1.AgentService/Run`). Cursor's server runs
the loop and the model and sends tool calls down the stream (`shell`, `read`,
`write`, `grep`, your MCP tools). Your process executes them and stores the
conversation blobs Cursor hands back (`kv get_blob`/`set_blob`). So:

| | Where |
|---|---|
| Loop and model | Cursor |
| Shell and file tools | The actor |
| Conversation state | The actor's `/workspace/state` |

The actor is the agent's hands and memory. The brain lives at Cursor for as
long as a turn's stream is open.

## Quickstart (local kind)

Run the commands from this directory.

### 1. Install Agent Substrate

You need Go, Docker and `kubectl`. This creates a local kind cluster with Agent Substrate at commit `551dd54e` (2026-10-27):

```bash
git clone https://github.com/agent-substrate/substrate.git ~/substrate
cd ~/substrate && git checkout 551dd54e
hack/create-kind-cluster.sh
hack/install-ate-kind.sh deploy ate-system \
  --credential-provider='{"name":"k8s.io"}' \
  --ingress-allowed-spiffe-ids=spiffe://cluster.local/ns/default/sa/default
hack/install-ate-kind.sh publish worker-images   # prints the ateworker-gvisor ref
go install ./cmd/kubectl-ate
cd -
```

`publish worker-images` prints a ref like `localhost:5001/ateworker-gvisor@sha256:...`. `workerpool.yaml` names the worker image as `ko://go.ate.dev/substrate/cmd/ateworker-gvisor`, and the commands below substitute the ref for it. Keep it in a variable:

```bash
WORKER=localhost:5001/ateworker-gvisor@sha256:...
```

A 2-core kind node fits one worker. If another worker pool is already running, scale it to zero first.

### 2. Start the router proxy

The Substrate router accepts only mutual TLS from pod identities on its allowlist. The install above allows the `default` service account in the `default` namespace. `router-proxy.yaml` is an nginx pod with that identity that takes plain HTTP and forwards it to the router with its own client certificate. Start it, and port-forward to it in a separate terminal:

```bash
kubectl apply -f router-proxy.yaml
kubectl wait --for=condition=Ready pod/router-proxy
kubectl port-forward pod/router-proxy 8000:80
```

Requests to `localhost:8000` reach the actor named in the `ate-target-actor` header.

### 3. Deploy the agent

Build the agent image and deploy the worker pool and template. The template
carries the Cursor key as a plain env var (see "Egress" below for why).

```bash
docker build -t localhost:5001/cursor-agent:latest ./agent
docker push localhost:5001/cursor-agent:latest
IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' localhost:5001/cursor-agent:latest)

sed "s|ko://go.ate.dev/substrate/cmd/ateworker-gvisor|$WORKER|" workerpool.yaml | kubectl apply -f -
kubectl ate create atespace ate-demo-cursor
sed "s|image: IMAGE|image: $IMAGE|; s|value: crsr_0*|value: $CURSOR_API_KEY|" template.yaml \
  | kubectl ate create actor-template -f -
kubectl ate get actor-template cursor-agent -a ate-demo-cursor   # wait for GOLDEN TAG

kubectl ate create actor demo-agent --template cursor-agent -a ate-demo-cursor
kubectl ate create egress-policy demo-agent -a ate-demo-cursor -f egress-policy.yaml
```

Check that the actor answers:

```bash
curl -sS -H "ate-target-actor: ate-demo-cursor/demo-agent" localhost:8000/v1/info
```

## Demo

Turn 1 creates a session. The actor wakes from `SUSPENDED` (the template's
golden snapshot) and answers in about 7 s; the turn itself took 10 s.

```bash
curl -sS -H "ate-target-actor: ate-demo-cursor/demo-agent" localhost:8000/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Create hello.js that prints hi, run it with node, and report the output."}'
# {"ok":true,"sessionId":"ses_d638…","continuationToken":"http:…"}
curl -sS -N -H "ate-target-actor: ate-demo-cursor/demo-agent" "localhost:8000/v1/session/ses_d638…/stream?startIndex=0"
```

```
16 actions.requested  Write {"path":"/workspace/project/hello.js","contents":"console.log('hi');\n"}
23 actions.requested  shell {"command":"node /workspace/project/hello.js"}
24 action.result      {"exitCode":0,"stdout":"hi\n"}
65 turn.completed     "Created `hello.js` with `console.log('hi')` and ran `node hello.js`; it exited 0 and printed: hi"
```

Suspend, then wake with a follow-up on the same session. The actor went
`SUSPENDED` to answering in 8 s. The event index continues (67), the
continuation token is accepted, and the agent reads the file it wrote before.

```bash
kubectl ate suspend actor demo-agent -a ate-demo-cursor
curl -sS -H "ate-target-actor: ate-demo-cursor/demo-agent" "localhost:8000/v1/session/ses_d638…" \
  -H 'content-type: application/json' \
  -d '{"continuationToken":"http:…","message":"Change hello.js so it also prints the current year, run it again, and tell me what it printed."}'
```

```
79  action.result   Read  "console.log('hi');"
88  action.result   shell {"stdout":"hi\n2026\n"}
136 turn.completed  "`hello.js` now logs `hi` and the current year…"
```

Tag and fork. Both branches start from the two turns above and diverge.

```bash
kubectl ate suspend actor demo-agent -a ate-demo-cursor
kubectl ate create tag checkpoint-v1 --actor demo-agent -a ate-demo-cursor
kubectl ate create actor demo-agent-fork --template cursor-agent --tag checkpoint-v1 -a ate-demo-cursor
kubectl ate create egress-policy demo-agent-fork -a ate-demo-cursor -f egress-policy.yaml
```

```
demo-agent-fork  "Add multiply(a, b), call it with 6 and 7"  ->  stdout "hi\n2026\n42\n"
demo-agent       "Add add(a, b), call it with 2 and 3"       ->  stdout "hi\n2026\n5\n"
```

Suspend in the middle of a turn. The agent was asked to run a script that
sleeps 25 s; the actor was suspended 2 s after the `shell` call started.

```
239 actions.requested  shell {"command":"node /workspace/project/wait.js","timeout":60000}
    (suspend; no further event for this turn)
```

What happened after the wake:

- The interrupted turn has no terminal event. The log just stops.
- A follow-up sent 3 s after the wake was accepted (HTTP 200, new token) but
  did not start a turn. It ran five minutes later, when the next message
  arrived. The Agent SDK keeps a per-session lock file under the state root
  with a 30 s staleness window; the snapshot restored it with a fresh mtime,
  so the new server treated the dead turn as live and queued the message.
- Each new message preempts the running turn (the SDK's default). Two of my
  own messages cancelled the recovery turns.
- Once a turn ran undisturbed, the agent found the interrupted call in its
  history ("both `node wait.js` runs were interrupted before the shell tool
  returned") and offered to rerun it. Told to go ahead, it ran the script and
  reported `done` after 25.3 s.

Seven turns on this session cost $0.094 of Cursor usage (`/v1/session/:id/cost`).

## Egress

The intent was Substrate's credential injection: a placeholder key in the
sandbox, the real key added by the egress gateway. It does not work for this
SDK. The SDK posts the raw key once to `api2.cursor.sh/auth/exchange_user_api_key`,
gets a JWT, and sends the JWT on every other `api2.cursor.sh` call. Substrate's
egress rules match hostname and port, not path, so a `replaceHeaders` effect on
`api2.cursor.sh` also overwrites the JWT and Cursor answers 401. The demo
therefore puts the key in the actor's environment and uses a plain allow
policy. A path-scoped rule would fix it.

## Notes

- The Plus plan serves `composer-2.5` only with `fast=false`. A plain
  `model: "composer-2.5"` fails with "Model unavailable on Plus".
- Substrate ignores the image's `WORKDIR`; the `CMD` uses absolute paths.
- One worker per node on a 2-core machine; the second replica never schedules.
