# coding-agents-on-substrate

Open-source coding harnesses and agent SDKs running as durable actors on
[Agent Substrate](https://github.com/agent-substrate/substrate). Each actor
keeps its working files and its session state on a durable `/workspace`
volume. Each demo covers waking an actor from suspend, tagging it and forking
a second actor from the tag, and what happens to a turn that is interrupted
midway.

| Harness | Where the loop runs | Where tools run | Where session state lives | Mid-turn interruption | Demo |
|---|---|---|---|---|---|
| Pi (`@earendil-works/pi-durable`) | In the actor | In the actor, through `NodeExecutionEnv` | SQLite at `/workspace/.pi/agent.sqlite` | `harness.resume()` continues the turn on the next wake. A tool call cut off midway returns `interrupted` to the model unless the tool is replay-safe. | [pi-durable](pi-durable) |
| libfx | In the actor, in libfx's Zig engine | In the server process (`tools.ts`) | Journal files under `/workspace/.fx/sessions` | The turn continues from its last stored step on the next wake, and the model is told it was interrupted. | [libfx](libfx) |
| Cursor Agent SDK | At Cursor, over a stream the actor opens for each turn | In the actor | Conversation blobs in `/workspace/state`, written when Cursor sends them | The turn is lost. The next turn sees the interrupted call in its history. | [cursor-agent-sdk](cursor-agent-sdk) |

The Pi and libfx interruption cells come from each library's README. Only the
Cursor demo has run an interrupted turn.

## Setup

All three demos share one local kind cluster and one client pod. See
[setup/README.md](setup/README.md).

This repo was named `pi-durable-substrate` until 2026-10-27. GitHub redirects
the old name.
