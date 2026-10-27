import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export function createCodingTools(workspaceDir: string) {
  function resolveSafePath(relPath: string): string {
    const resolved = path.resolve(workspaceDir, relPath);
    if (!resolved.startsWith(path.resolve(workspaceDir))) {
      throw new Error(`Path ${relPath} escapes workspace directory`);
    }
    return resolved;
  }

  return [
    {
      name: "read",
      description: "Read the contents of a file at path relative to workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
        },
        required: ["path"],
      },
      idempotent: true,
      writes: false,
      async execute({ path: relPath }: { path: string }) {
        const fullPath = resolveSafePath(relPath);
        try {
          return await readFile(fullPath, "utf8");
        } catch (err: any) {
          return { error: `Failed to read ${relPath}: ${err.message}` };
        }
      },
    },
    {
      name: "write",
      description: "Write full contents to a file at path relative to workspace.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          content: { type: "string", description: "File content to write" },
        },
        required: ["path", "content"],
      },
      idempotent: true,
      writes: true,
      async execute({ path: relPath, content }: { path: string; content: string }) {
        const fullPath = resolveSafePath(relPath);
        try {
          await mkdir(path.dirname(fullPath), { recursive: true });
          await writeFile(fullPath, content, "utf8");
          return { success: true, path: relPath };
        } catch (err: any) {
          return { error: `Failed to write ${relPath}: ${err.message}` };
        }
      },
    },
    {
      name: "edit",
      description: "Replace a target block of text with replacement text in a file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path" },
          oldText: { type: "string", description: "Exact text to find and replace" },
          newText: { type: "string", description: "Replacement text" },
        },
        required: ["path", "oldText", "newText"],
      },
      idempotent: false,
      writes: true,
      async execute({ path: relPath, oldText, newText }: { path: string; oldText: string; newText: string }) {
        const fullPath = resolveSafePath(relPath);
        try {
          const content = await readFile(fullPath, "utf8");
          if (!content.includes(oldText)) {
            return { error: `Target text not found in ${relPath}` };
          }
          const updated = content.replace(oldText, newText);
          await writeFile(fullPath, updated, "utf8");
          return { success: true, path: relPath };
        } catch (err: any) {
          return { error: `Failed to edit ${relPath}: ${err.message}` };
        }
      },
    },
    {
      name: "bash",
      description: "Execute a shell command within the workspace directory.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command string" },
        },
        required: ["command"],
      },
      idempotent: false,
      writes: true,
      async execute({ command }: { command: string }, { signal }: { signal: AbortSignal }) {
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: workspaceDir,
            signal,
            timeout: 30000,
          });
          return { stdout, stderr };
        } catch (err: any) {
          return {
            error: err.message,
            stdout: err.stdout,
            stderr: err.stderr,
            exitCode: err.code,
          };
        }
      },
    },
  ];
}
