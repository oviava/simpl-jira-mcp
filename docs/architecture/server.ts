/** SDK boundary sketch. No startup occurs when this file is imported. */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type * as z from "zod/v4";
import { inputSchemas } from "./schemas.js";
import { JiraClient, JiraError, readConfig } from "./contracts.js";
import type { ToolOutput } from "./contracts.js";

/** Implement the domain output schema before advertising this tool. */
declare const searchOutputSchema: z.ZodType<ToolOutput<"jira_search_issues">>;

export function createServer(_jira: JiraClient, _writesEnabled: boolean): McpServer {
  // Register nine primary reads and two recovery reads in fixed order.
  // Add each later group only when it is implemented and its acceptance gate passed.
  // Register implemented mutation tools only when writesEnabled is true.
  // Apply private cache policy through the pinned SDK's documented mechanism.
  throw new Error("not implemented");
}

/** Representative registration. The adapter owns MCP encoding and error conversion. */
export function registerSearchSketch(server: McpServer, jira: JiraClient): void {
  server.registerTool("jira_search_issues", {
    description: "Search visible Jira issues using JQL and return a bounded page.",
    inputSchema: inputSchemas.jira_search_issues,
    outputSchema: searchOutputSchema,
    annotations: {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true,
    },
  }, async (input, ctx) => {
    try {
      const output = await jira.searchIssues(input, { signal: ctx.mcpReq.signal });
      // Verify the complete encoded result stays below 256 KiB before returning it.
      // The client has already bounded whole items and supplied domain recovery data.
      return {
        structuredContent: output,
        content: [{ type: "text", text: `Returned ${output.data.returnedCount} issues.` }],
      };
    } catch (error) {
      if (ctx.mcpReq.signal.aborted) throw error;
      if (error instanceof JiraError) {
        // JiraFailure messages are sanitized when the upstream failure is classified.
        return { isError: true, content: [{ type: "text", text: JSON.stringify(error.failure) }] };
      }
      // Do not echo arbitrary exception messages, upstream bodies, or credentials.
      return { isError: true, content: [{ type: "text", text: "Unexpected server error." }] };
    }
  });
}

/** Proposed entry point body; invoke only after replacing all contract declarations. */
export function startSketch(): void {
  const config = readConfig(process.env);
  const handle = serveStdio(() => createServer(new JiraClient(config), config.writesEnabled));
  // The SDK owns EOF teardown; close the handle on process termination signals.
  process.once("SIGINT", () => { void handle.close(); });
  process.once("SIGTERM", () => { void handle.close(); });
}
