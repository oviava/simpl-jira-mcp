/** Caller-first examples. These functions are sketches and are not executed. */
import type { Client } from "@modelcontextprotocol/client";
import type { ToolArguments, ToolName } from "./schemas.js";
import type { ToolOutput } from "./contracts.js";

/** Use the corresponding output schema; never cast structuredContent to a result. */
declare function decodeOutput<K extends ToolName>(name: K, result: unknown): ToolOutput<K>;

export async function researchIssue(mcp: Client): Promise<void> {
  const query: ToolArguments<"jira_search_issues"> = {
    jql: "project = EXAMPLE ORDER BY updated DESC",
    fields: ["summary", "status", "assignee", "updated"], maxResults: 20,
  };
  const found = decodeOutput("jira_search_issues", await mcp.callTool({
    name: "jira_search_issues", arguments: query,
  }));
  const first = found.data.items[0];
  if (first === undefined) return;

  const detail = decodeOutput("jira_get_issue", await mcp.callTool({
    name: "jira_get_issue", arguments: { issueKey: first.key, includeChangelog: true },
  }));
  // Inspect detail.data.changelog.completeness before claiming a full history.
  const comments = decodeOutput("jira_list_comments", await mcp.callTool({
    name: "jira_list_comments", arguments: { issueKey: detail.data.key, maxResults: 20 },
  }));
  if (comments.data.hasMore === true) {
    await mcp.callTool({ name: "jira_list_comments", arguments: {
      issueKey: first.key, startAt: comments.data.nextStartAt, maxResults: 20,
    } });
  }
}

export async function recoverLargeDescription(mcp: Client): Promise<string> {
  const first = decodeOutput("jira_read_issue_field", await mcp.callTool({
    name: "jira_read_issue_field", arguments: { issueKey: "EXAMPLE-42", fieldId: "description" },
  }));
  let text = first.data.text;
  let window = first.data;
  while (window.complete === false) {
    const next = decodeOutput("jira_read_issue_field", await mcp.callTool({
      name: "jira_read_issue_field", arguments: {
        issueKey: "EXAMPLE-42", fieldId: "description",
        offset: window.nextOffset, expectedUpdated: first.data.updated,
      },
    }));
    window = next.data;
    text += window.text;
  }
  // A changed issue produces source_changed; restart from offset zero.
  return text;
}

export async function updateSummary(mcp: Client): Promise<void> {
  // The host supplies any human approval it requires; this server adds no confirm flag.
  const receipt = decodeOutput("jira_update_issue", await mcp.callTool({
    name: "jira_update_issue", arguments: {
      issueKey: "EXAMPLE-42", fields: { summary: "Revised summary" },
      expectedUpdated: "2026-10-02T09:14:00.000+0000",
    },
  }));
  // acknowledged means Jira accepted the request; verification says whether a read proved it.
  if (receipt.verification === "not_verified") {
    await mcp.callTool({ name: "jira_get_issue", arguments: {
      issueKey: "EXAMPLE-42", fields: ["summary", "updated"],
    } });
  }
  // write_outcome_unknown is an error result. Reconcile with a read; never replay automatically.
}
