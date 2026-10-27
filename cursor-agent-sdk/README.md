# cursor-agent-sdk

A simple durable AI coding agent built with the [Cursor Agent SDK](https://cursor.com/docs/agent-sdk) running on [Agent Substrate](https://github.com/agent-substrate/substrate).

The output below is from 2026-10-27, against Substrate `551dd54e`.

## agent/bot/agent.ts

```ts
import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
  local: { workspaceDir: "/workspace/project" },
});
```

`agent/bot/instructions.md` tells the agent to write the files it is asked for, run them to check they work, and end with one sentence on what it did. There is no server code: the image runs the SDK's own server, with its state root on `/workspace`:

```dockerfile
CMD ["/app/node_modules/.bin/agent-sdk", "serve", "--dir", "/app", "--mode", "single", \
     "--host", "0.0.0.0", "--port", "80", "--state-root", "/workspace/state", \
     "--allow-anonymous", "--no-playground", "--no-docs"]
```

Substrate ignores the image's `WORKDIR`, so the `CMD` uses absolute paths.

## How it works

Unlike a harness you host, the Agent SDK runs the agent loop and the model at Cursor. For each turn, `agent-sdk serve` opens a stream to `api2.cursor.sh`. Cursor sends tool calls down the stream (`shell`, `read`, `write`, `grep`), the server runs them in the actor, and it stores the conversation blobs Cursor sends back under `/workspace/state`. The actor holds the agent's files and its memory; the loop lives at Cursor for as long as a turn's stream is open.

Agent Substrate runs each agent as an isolated actor with `/workspace` mounted as a durable directory (`durableDir` in `template.yaml`). The SDK's sessions, conversation checkpoints and memory journal all live in `/workspace/state`, and the agent's project files in `/workspace/project`.

1. **Suspend and auto-resume**: When you suspend an actor (`kubectl ate suspend actor`), Agent Substrate snapshots `/workspace` to object storage and stops the container. When the next HTTP request arrives for that actor, the router restores `/workspace` onto a worker pod and wakes the server before forwarding the request. The session, its event index and its continuation token all carry over.
2. **Checkpoint and fork**: Because the conversation state and the working files live in `/workspace`, you can tag a suspended actor (`kubectl ate create tag`) and create a new actor from that tag (`kubectl ate create actor --tag`). Both actors continue the same session from the same files, then diverge on subsequent requests.
3. **No credential injection**: The Pi and libfx demos keep a placeholder key in the sandbox and let the egress proxy swap in the real one. That does not work for this SDK. It posts the raw key once to `api2.cursor.sh/auth/exchange_user_api_key`, gets a JWT, and sends the JWT on every other `api2.cursor.sh` call. Substrate's egress rules match hostname and port, not path, so a header replacement on `api2.cursor.sh` would overwrite the JWT too, and Cursor answers 401. The template therefore carries the real `CURSOR_API_KEY`, and `egress-policy.yaml` only allows the Cursor hosts. A path-scoped rule would fix this.

## Mid-turn interruption

Exercised in this demo. The agent was asked to run a script that sleeps 25 s, and the actor was suspended 2 s after the `shell` call started:

```
239 actions.requested  shell {"command":"node /workspace/project/wait.js","timeout":60000}
    (suspend; no further event for this turn)
```

After the wake:

- The interrupted turn has no terminal event. The event log just stops.
- A follow-up sent 3 s after the wake was accepted (HTTP 200, new token) but did not start a turn until the next message arrived five minutes later. The SDK keeps a per-session lock file under the state root with a 30 s staleness window. The snapshot restored it with a fresh mtime, so the new server treated the dead turn as live and queued the message.
- Each new message preempts the running turn (the SDK's default), so two follow-ups cancelled the recovery turns.
- Once a turn ran undisturbed, the agent found the interrupted call in its history ("both `node wait.js` runs were interrupted before the shell tool returned") and offered to rerun it. Told to go ahead, it ran the script and reported `done` after 25.3 s.

So the turn in flight is lost, and the next turn sees the interrupted call in its history.

## Quickstart (local Kubernetes with kind)

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

### 3. Build and deploy the agent template

Build the agent image, deploy the worker pool and actor template. The template carries your `CURSOR_API_KEY` as a plain env var (see "No credential injection" above):

```bash
docker build -t localhost:5001/cursor-agent:latest ./agent
docker push localhost:5001/cursor-agent:latest
IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' localhost:5001/cursor-agent:latest)

sed "s|ko://go.ate.dev/substrate/cmd/ateworker-gvisor|$WORKER|" workerpool.yaml | kubectl apply -f -
kubectl ate create atespace ate-demo-cursor
sed "s|image: IMAGE|image: $IMAGE|; s|value: crsr_0*|value: $CURSOR_API_KEY|" template.yaml \
  | kubectl ate create actor-template -f -
kubectl ate get actor-template cursor-agent -a ate-demo-cursor   # wait for GOLDEN TAG
```

### 4. Create an actor and run Turn 1

Creating a session starts the first turn. Its events stream from `/stream`:

```bash
kubectl ate create actor demo-agent --template cursor-agent -a ate-demo-cursor
kubectl ate create egress-policy demo-agent -a ate-demo-cursor -f egress-policy.yaml

curl -sS -H "ate-target-actor: ate-demo-cursor/demo-agent" localhost:8000/v1/session \
  -H "Content-Type: application/json" \
  -d '{"message": "Create hello.js that prints hi, run it with node, and report the output."}'
# {"ok":true,"sessionId":"ses_d638…","continuationToken":"http:…"}

curl -sS -N -H "ate-target-actor: ate-demo-cursor/demo-agent" "localhost:8000/v1/session/ses_d638…/stream?startIndex=0"
```

Event snippet (index, type, payload). The actor woke from the template's golden snapshot and answered in about 7 s; the turn took 10 s:

```
16 actions.requested  Write {"path":"/workspace/project/hello.js","contents":"console.log('hi');\n"}
23 actions.requested  shell {"command":"node /workspace/project/hello.js"}
24 action.result      {"exitCode":0,"stdout":"hi\n"}
65 turn.completed     "Created `hello.js` with `console.log('hi')` and ran `node hello.js`; it exited 0 and printed: hi"
```

### 5. Suspend and wake with Turn 2

Posting to the session with its continuation token wakes the actor and continues the same session:

```bash
kubectl ate suspend actor demo-agent -a ate-demo-cursor

curl -sS -H "ate-target-actor: ate-demo-cursor/demo-agent" "localhost:8000/v1/session/ses_d638…" \
  -H "Content-Type: application/json" \
  -d '{"continuationToken": "http:…", "message": "Change hello.js so it also prints the current year, run it again, and tell me what it printed."}'
```

The actor went from `SUSPENDED` to answering in 8 s. The event index continues from 67, and the agent reads the file it wrote before:

```
79  action.result   Read  "console.log('hi');"
88  action.result   shell {"stdout":"hi\n2026\n"}
136 turn.completed  "`hello.js` now logs `hi` and the current year…"
```

### 6. Suspend, tag a checkpoint, and fork

```bash
kubectl ate suspend actor demo-agent -a ate-demo-cursor

kubectl ate create tag checkpoint-v1 --actor demo-agent -a ate-demo-cursor
kubectl ate create actor demo-agent-fork --template cursor-agent --tag checkpoint-v1 -a ate-demo-cursor
kubectl ate create egress-policy demo-agent-fork -a ate-demo-cursor -f egress-policy.yaml
```

### 7. Send divergent prompts to both branches

Both actors continue the same session from the two turns above, using the continuation token from Turn 2, and diverge:

```bash
# Original actor continues on Branch A
curl -sS -H "ate-target-actor: ate-demo-cursor/demo-agent" "localhost:8000/v1/session/ses_d638…" \
  -H "Content-Type: application/json" \
  -d '{"continuationToken": "http:…", "message": "Add add(a, b), call it with 2 and 3"}'

# Forked actor continues on Branch B
curl -sS -H "ate-target-actor: ate-demo-cursor/demo-agent-fork" "localhost:8000/v1/session/ses_d638…" \
  -H "Content-Type: application/json" \
  -d '{"continuationToken": "http:…", "message": "Add multiply(a, b), call it with 6 and 7"}'
```

What each branch's `node hello.js` printed:

```
demo-agent       hi\n2026\n5\n
demo-agent-fork  hi\n2026\n42\n
```

Seven turns on this session, including the interruption test, cost $0.094 of Cursor usage (`/v1/session/:id/cost`).
