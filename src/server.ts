import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import {
  JiraClient,
  JiraError,
  type CallOptions,
} from "./jira.js";
import { inputSchemas, outputSchemas, type ToolInput, type ToolName } from "./schemas.js";

const MAX_ENCODED_RESULT_BYTES = 256 * 1024;
const MAX_TOOL_OPERATION_MS = 60_000;
const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

type HandlerContext = { mcpReq: { signal: AbortSignal } };
function textResult(text: string, structuredContent?: Record<string, unknown>): CallToolResult {
  const content = [{ type: "text" as const, text }];
  const result: CallToolResult = structuredContent === undefined
    ? { content }
    : { content, structuredContent };
  const encoded = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (encoded > MAX_ENCODED_RESULT_BYTES) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          kind: "response_too_large",
          message: "The encoded MCP result exceeds the 256 KiB limit. Select fewer fields or a smaller page.",
        }),
      }],
    };
  }
  return result;
}

function errorResult(error: unknown): CallToolResult {
  if (error instanceof JiraError) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify(error.failure) }] };
  }
  return { isError: true, content: [{ type: "text", text: "Unexpected server error." }] };
}

function toolHandler<I, O extends object>(
  invoke: (input: I, options: CallOptions) => Promise<O>,
  summary: (output: O) => string,
): (input: I, context: HandlerContext) => Promise<CallToolResult> {
  return async (input, context) => {
    const deadline = AbortSignal.timeout(MAX_TOOL_OPERATION_MS);
    const signal = AbortSignal.any([context.mcpReq.signal, deadline]);
    try {
      const output = await invoke(input, { signal });
      return textResult(summary(output), output as Record<string, unknown>);
    } catch (error) {
      if (context.mcpReq.signal.aborted) throw error;
      if (deadline.aborted) {
        return errorResult(new JiraError({ kind: "timeout", message: "The Jira operation exceeded its 60-second deadline." }));
      }
      return errorResult(error);
    }
  };
}

function toolConfig<K extends ToolName>(name: K, description: string) {
  return {
    description,
    inputSchema: inputSchemas[name],
    outputSchema: outputSchemas[name],
    annotations: readAnnotations,
  };
}

export function createServer(jira: JiraClient, writesEnabled: boolean): McpServer {
  if (writesEnabled) throw new Error("Write tools are not implemented in this release. Set JIRA_ENABLE_WRITES=false.");

  const server = new McpServer({ name: "jira-mcp", version: "1.0.0" }, {
    capabilities: { tools: {} },
    cacheHints: {
      "tools/list": { ttlMs: 0, cacheScope: "private" },
      "server/discover": { ttlMs: 0, cacheScope: "private" },
    },
  });

  server.registerTool("jira_get_access", toolConfig("jira_get_access", "Report the current Jira user, server version, and permissions for one scope."), toolHandler(
    (input: ToolInput<"jira_get_access">, options) => jira.getAccess(input, options),
    output => `Read ${Object.keys(output.data.permissions).length} permissions for ${output.data.scope.kind} scope.`));
  server.registerTool("jira_list_projects", toolConfig("jira_list_projects", "List visible Jira projects in a bounded page."), toolHandler(
    (input: ToolInput<"jira_list_projects">, options) => jira.listProjects(input, options),
    output => `Returned ${output.data.returnedCount} projects.`));
  server.registerTool("jira_get_project", toolConfig("jira_get_project", "Read project details and selected issue types, components, and versions."), toolHandler(
    (input: ToolInput<"jira_get_project">, options) => jira.getProject(input, options),
    output => `Read project ${output.data.key} and ${Object.keys(output.data.collections).length} collections.`));
  server.registerTool("jira_list_fields", toolConfig("jira_list_fields", "List Jira field definitions, including custom fields, in a bounded page."), toolHandler(
    (input: ToolInput<"jira_list_fields">, options) => jira.listFields(input, options),
    output => `Returned ${output.data.returnedCount} fields.`));
  server.registerTool("jira_search_issues", toolConfig("jira_search_issues", "Search visible Jira issues with JQL and return a bounded page."), toolHandler(
    (input: ToolInput<"jira_search_issues">, options) => jira.searchIssues(input, options),
    output => `Returned ${output.data.returnedCount} issues.`));
  server.registerTool("jira_get_issue", toolConfig("jira_get_issue", "Read a Jira issue, selected fields, links, and optional changelog data."), toolHandler(
    (input: ToolInput<"jira_get_issue">, options) => jira.getIssue(input, options),
    output => `Read issue ${output.data.key}.`));
  server.registerTool("jira_list_comments", toolConfig("jira_list_comments", "List issue comments with Jira page metadata."), toolHandler(
    (input: ToolInput<"jira_list_comments">, options) => jira.listComments(input, options),
    output => `Returned ${output.data.returnedCount} comments.`));
  server.registerTool("jira_list_remote_links", toolConfig("jira_list_remote_links", "List remote links attached to an issue. The server does not fetch link targets."), toolHandler(
    (input: ToolInput<"jira_list_remote_links">, options) => jira.listRemoteLinks(input, options),
    output => `Returned ${output.data.returnedCount} remote links.`));
  server.registerTool("jira_list_transitions", toolConfig("jira_list_transitions", "List available issue transitions and their field metadata."), toolHandler(
    (input: ToolInput<"jira_list_transitions">, options) => jira.listTransitions(input, options),
    output => `Returned ${output.data.returnedCount} transitions.`));
  server.registerTool("jira_read_issue_field", toolConfig("jira_read_issue_field", "Read a bounded text window from one issue field. Later windows require the first window's updated value."), toolHandler(
    (input: ToolInput<"jira_read_issue_field">, options) => jira.readIssueField(input, options),
    output => `Returned ${output.data.returnedCount} code points at offset ${output.data.offset}.`));
  server.registerTool("jira_read_comment", toolConfig("jira_read_comment", "Read a bounded text window from one issue comment. Later windows require the first window's updated value."), toolHandler(
    (input: ToolInput<"jira_read_comment">, options) => jira.readComment(input, options),
    output => `Returned ${output.data.returnedCount} code points at offset ${output.data.offset}.`));
  server.registerTool("jira_list_boards", toolConfig("jira_list_boards", "List Agile boards by name or type with Jira continuation metadata."), toolHandler(
    (input: ToolInput<"jira_list_boards">, options) => jira.listBoards(input, options),
    output => `Returned ${output.data.returnedCount} boards.`));
  server.registerTool("jira_get_board", toolConfig("jira_get_board", "Read an Agile board and its configuration."), toolHandler(
    (input: ToolInput<"jira_get_board">, options) => jira.getBoard(input, options),
    output => `Read ${output.data.type} board ${output.data.name}.`));
  server.registerTool("jira_list_board_issues", toolConfig("jira_list_board_issues", "List issues visible through an Agile board."), toolHandler(
    (input: ToolInput<"jira_list_board_issues">, options) => jira.listBoardIssues(input, options),
    output => `Returned ${output.data.returnedCount} board issues.`));
  server.registerTool("jira_list_sprints", toolConfig("jira_list_sprints", "List Scrum board sprints and preserve Jira's isLast continuation marker."), toolHandler(
    (input: ToolInput<"jira_list_sprints">, options) => jira.listSprints(input, options),
    output => `Returned ${output.data.returnedCount} sprints.`));
  server.registerTool("jira_get_create_metadata", toolConfig("jira_get_create_metadata", "Read paged issue types or create-field metadata for a project."), toolHandler(
    (input: ToolInput<"jira_get_create_metadata">, options) => jira.getCreateMetadata(input, options),
    output => `Read ${output.data.page.returnedCount} ${output.data.kind} metadata items.`));
  server.registerTool("jira_get_edit_metadata", toolConfig("jira_get_edit_metadata", "Read editable field requirements and allowed values for an issue."), toolHandler(
    (input: ToolInput<"jira_get_edit_metadata">, options) => jira.getEditMetadata(input, options),
    output => `Returned ${output.data.page.returnedCount} editable fields.`));
  server.registerTool("jira_find_assignable_users", toolConfig("jira_find_assignable_users", "Find assignable users by query within a project, optionally for one issue."), toolHandler(
    (input: ToolInput<"jira_find_assignable_users">, options) => jira.findAssignableUsers(input, options),
    output => `Returned ${output.data.returnedCount} assignable users.`));
  server.registerTool("jira_list_worklogs", toolConfig("jira_list_worklogs", "List an issue's worklogs with Jira page metadata."), toolHandler(
    (input: ToolInput<"jira_list_worklogs">, options) => jira.listWorklogs(input, options),
    output => `Returned ${output.data.returnedCount} worklogs.`));
  server.registerTool("jira_list_favourite_filters", toolConfig("jira_list_favourite_filters", "List the current Jira user's favourite filters."), toolHandler(
    (input: ToolInput<"jira_list_favourite_filters">, options) => jira.listFavouriteFilters(input, options),
    output => `Returned ${output.data.returnedCount} favourite filters.`));
  server.registerTool("jira_list_dashboards", toolConfig("jira_list_dashboards", "List dashboards visible to the current Jira user."), toolHandler(
    (input: ToolInput<"jira_list_dashboards">, options) => jira.listDashboards(input, options),
    output => `Returned ${output.data.returnedCount} dashboards.`));
  server.registerTool("jira_list_attachments", toolConfig("jira_list_attachments", "List attachment metadata for an issue. The server does not download attachment bytes."), toolHandler(
    (input: ToolInput<"jira_list_attachments">, options) => jira.listAttachments(input, options),
    output => `Returned ${output.data.returnedCount} attachments.`));

  return server;
}
