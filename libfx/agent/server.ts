import http from "node:http";
import { readdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { json } from "node:stream/consumers";
import { createFxAgent } from "libfx";
import { local } from "libfx/durable-local";
import { createCodingTools } from "./tools.ts";

const agent = createFxAgent({
  model: "google/gemini-3.8-flash",
  durability: local({ dir: "/workspace/.fx/sessions" }),
  tools: createCodingTools("/workspace"),
});

// Open the existing session from disk if one exists, or start a new one.
const [existingRun] = await readdir("/workspace/.fx/sessions/runs").catch(() => []);
const sessionId = existingRun ? existingRun.replace(/\.json$/, "") : undefined;
const session = agent.session(sessionId);
await session.resume().result;

const server = http.createServer(async (req, res) => {
  if (req.url === "/readyz") return res.end("ok\n");
  if (req.method === "GET" && req.url?.startsWith("/events")) {
    const cursor = Number(new URL(req.url, "http://localhost").searchParams.get("cursor") ?? 0);
    res.writeHead(200, { "Content-Type": "application/x-ndjson" });
    const stream = Readable.fromWeb(session.stream(cursor));
    req.on("close", () => stream.destroy());
    return stream.pipe(res);
  }
  const { prompt } = (await json(req)) as { prompt: string };
  res.writeHead(200, { "Content-Type": "application/x-ndjson" });
  Readable.fromWeb(session.prompt(prompt).readable).pipe(res);
});

process.on("SIGTERM", async () => {
  await agent.close();
  server.close(() => process.exit(0));
});
server.listen(80, "0.0.0.0");
