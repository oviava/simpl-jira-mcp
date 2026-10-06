import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { JiraClient, readConfig } from "./jira.js";
import { createServer } from "./server.js";

export function startServer(env: Record<string, string | undefined> = process.env): StdioServerHandle {
  const config = readConfig(env);
  if (config.writesEnabled) {
    throw new Error("Write tools are not implemented in this release. Set JIRA_ENABLE_WRITES=false.");
  }
  const jira = new JiraClient(config);
  const handle = serveStdio(() => createServer(jira, false), {
    legacy: "serve",
    onerror: () => console.error("MCP transport error."),
  });
  const close = () => {
    void handle.close().catch(() => console.error("MCP transport shutdown failed."));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  return handle;
}

function main(): void {
  try {
    startServer();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "MCP server startup failed.");
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) main();
