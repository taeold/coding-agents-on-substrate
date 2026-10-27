import { defineAgent } from "@grok/agent-sdk";

export default defineAgent({
  model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
  local: { workspaceDir: "/workspace/project" },
});
