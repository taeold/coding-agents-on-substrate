import { defineAgent } from "@grok/agent-sdk";

// The Plus plan serves composer-2.5 only with its fixed settings.
export default defineAgent({
  model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
  local: { workspaceDir: "/workspace/project" },
});
