# coding-agents-on-substrate

Durable AI coding agents running on [Agent Substrate](https://github.com/agent-substrate/substrate).

Each demo runs one agent as a Substrate actor. The agent's working files and its conversation history both live in `/workspace`, which Agent Substrate mounts as a persistent directory, so a snapshot captures both at the same point in time. Each demo walks through suspending and waking an actor, tagging it and forking a second actor from the tag, and what happens to a turn that is interrupted midway.

## Demos

**[pi-durable](pi-durable).** A coding agent built with [@earendil-works/pi-durable](https://github.com/earendil-works/pi/tree/main/packages/durable). The agent loop and its tools run inside the actor, and the conversation is stored in SQLite at `/workspace/.pi/agent.sqlite`. If a turn is interrupted, `harness.resume()` continues it on the next wake. A tool call that was cut off midway returns `interrupted` to the model unless the tool is replay-safe.

**[libfx](libfx).** A coding agent built with [libfx](https://fx.sh/docs/lib). The loop runs inside the actor in libfx's Zig engine, and the tools run in the server process (`tools.ts`). Sessions are journal files under `/workspace/.fx/sessions`. An interrupted turn continues from its last stored step on the next wake, and the model is told it was interrupted.

**[cursor-agent-sdk](cursor-agent-sdk).** An agent built with the [Cursor Agent SDK](https://cursor.com/docs/agent-sdk). Unlike the other two, the loop and the model run at Cursor, over a stream the actor opens for each turn. Cursor sends tool calls down the stream, the actor runs them, and the actor stores the conversation blobs Cursor sends back in `/workspace/state`. An interrupted turn is lost, and the next turn sees the interrupted call in its history.

The interruption behavior described for Pi and libfx comes from each library's README. Only the Cursor demo has been run through an interrupted turn.

## Setup

Each demo is standalone. Its README installs Agent Substrate on a local kind cluster, starts a small proxy for sending requests to actors, and runs the demo from there. The demos can share one cluster.
