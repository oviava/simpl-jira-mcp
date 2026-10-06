import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { JiraClient, readConfig } from "../src/jira.js";
import { createServer } from "../src/server.js";

const expectedToolNames = [
  "jira_get_access",
  "jira_list_projects",
  "jira_get_project",
  "jira_list_fields",
  "jira_search_issues",
  "jira_get_issue",
  "jira_list_comments",
  "jira_list_remote_links",
  "jira_list_transitions",
  "jira_read_issue_field",
  "jira_read_comment",
  "jira_list_boards",
  "jira_get_board",
  "jira_list_board_issues",
  "jira_list_sprints",
  "jira_get_create_metadata",
  "jira_get_edit_metadata",
  "jira_find_assignable_users",
  "jira_list_worklogs",
  "jira_list_favourite_filters",
  "jira_list_dashboards",
  "jira_list_attachments",
];

function structured<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  assert.equal(result.isError, undefined);
  assert.ok(typeof result.structuredContent === "object" && result.structuredContent !== null);
  return result.structuredContent as T;
}

async function callThroughStdio(modern: boolean): Promise<void> {
  const root = process.cwd();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", resolve(root, "test/fixtures/mock-jira-fetch.mjs"), resolve(root, "dist/index.js")],
    cwd: root,
    env: {
      ...getDefaultEnvironment(),
      JIRA_URL: "https://jira.example.com/jira",
      JIRA_KEY: "test-token",
      JIRA_ENABLE_WRITES: "false",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "jira-mcp-contract-test", version: "1.0.0" }, modern
    ? { versionNegotiation: { mode: { pin: "2026-07-28" } } }
    : {});
  try {
    await client.connect(transport);
    if (modern) {
      assert.equal(client.getProtocolEra(), "modern");
      const discovery = client.getDiscoverResult();
      assert.ok(discovery?.supportedVersions.includes("2026-07-28"));
      const cacheHint = discovery as (typeof discovery & { ttlMs?: number; cacheScope?: string });
      assert.equal(cacheHint?.ttlMs, 0);
      assert.equal(cacheHint?.cacheScope, "private");
    } else {
      assert.equal(client.getProtocolEra(), "legacy");
    }

    const listing = await client.listTools();
    assert.deepEqual(listing.tools.map(tool => tool.name), expectedToolNames);
    const listCacheHint = listing as typeof listing & { ttlMs?: number; cacheScope?: string };
    if (modern) {
      assert.equal(listCacheHint.ttlMs, 0);
      assert.equal(listCacheHint.cacheScope, "private");
    } else {
      assert.equal(listCacheHint.ttlMs, undefined);
      assert.equal(listCacheHint.cacheScope, undefined);
    }

    const access = structured<{ data: { user: { displayName: string }; scope: { kind: string }; permissions: Record<string, string> } }>(
      await client.callTool({ name: "jira_get_access", arguments: { projectKey: "SIMPL" } }),
    );
    assert.deepEqual(access.data, {
      user: { displayName: "Test User", name: "test.user", active: true },
      serverVersion: "10.3.25",
      scope: { kind: "project", projectKey: "SIMPL" },
      permissions: {
        BROWSE_PROJECTS: "allowed",
        CREATE_ISSUES: "allowed",
        EDIT_ISSUES: "unknown",
        DELETE_ISSUES: "unknown",
        ASSIGN_ISSUES: "unknown",
        ASSIGNABLE_USER: "unknown",
        ADD_COMMENTS: "unknown",
        TRANSITION_ISSUES: "unknown",
        LINK_ISSUES: "unknown",
        PROJECT_VIEW_ALL_WORKLOGS: "denied",
        CREATE_ATTACHMENTS: "unknown",
      },
    });
    assert.equal(JSON.stringify(access).includes("private@example.com"), false);

    const projects = structured<{ data: { items: Array<{ key: string; name: string }> } }>(
      await client.callTool({ name: "jira_list_projects", arguments: { projectKey: "SIMPL" } }),
    );
    assert.deepEqual(projects.data.items, [{ id: "10000", key: "SIMPL", name: "Example project", type: "software" }]);
    const allProjects = structured<{ data: { items: Array<{ key: string }> } }>(
      await client.callTool({ name: "jira_list_projects", arguments: { maxResults: 3 } }),
    );
    assert.deepEqual(allProjects.data.items.map(project => project.key), ["ALPHA", "SIMPL", "ZETA"]);

    const project = structured<{ data: { collections: Record<string, { items: Array<{ id: string; name: string }> }> } }>(
      await client.callTool({ name: "jira_get_project", arguments: { projectKey: "SIMPL" } }),
    );
    assert.deepEqual(Object.fromEntries(Object.entries(project.data.collections).map(([name, page]) => [name, page.items])), {
      issueTypes: [{ id: "10001", name: "Task" }, { id: "20002", name: "Bug" }],
      components: [{ id: "12", name: "Example component" }, { id: "30", name: "Other component" }],
      versions: [{ id: "99", name: "1.0" }],
    });

    const fields = structured<{ data: { items: Array<{ id: string; name: string; custom: boolean }> } }>(
      await client.callTool({ name: "jira_list_fields", arguments: { customOnly: true } }),
    );
    assert.deepEqual(fields.data.items, [{ id: "customfield_10001", name: "Example custom field", custom: true, schema: { type: "string" } }]);
    const allFields = structured<{ data: { items: Array<{ id: string }> } }>(
      await client.callTool({ name: "jira_list_fields", arguments: {} }),
    );
    assert.deepEqual(allFields.data.items.map(field => field.id), ["customfield_10001", "summary"]);

    const result = await client.callTool({
      name: "jira_search_issues",
      arguments: {
        jql: "project = SIMPL ORDER BY updated DESC",
        fields: ["summary"],
        maxResults: 1,
      },
    });
    assert.deepEqual(result.content, [{ type: "text", text: "Returned 1 issues." }]);
    const search = structured<{
      data: {
        items: Array<{ id: string; key: string; browseUrl: string; fields: Record<string, unknown> }>;
        returnedCount: number;
        hasMore: boolean;
        nextStartAt?: number;
      };
      provenance: { jiraUrl: string };
    }>(result);
    assert.deepEqual(search.data.items, [{
      id: "10042",
      key: "SIMPL-42",
      browseUrl: "https://jira.example.com/jira/browse/SIMPL-42",
      updated: "2026-10-02T09:14:00.000+0000",
      fields: { summary: "Example issue summary" },
    }]);
    assert.equal(search.data.returnedCount, 1);
    assert.equal(search.data.hasMore, true);
    assert.equal(search.data.nextStartAt, 1);
    assert.equal(search.provenance.jiraUrl, "https://jira.example.com/jira/");

    const issue = structured<{ data: {
      key: string;
      fields: Record<string, unknown>;
      links: Array<{ direction: string; otherIssue: string }>;
      changelog: { completeness: string; returnedCount: number };
    } }>(await client.callTool({
      name: "jira_get_issue",
      arguments: { issueKey: "SIMPL-42", fields: ["summary"], includeChangelog: true },
    }));
    assert.equal(issue.data.key, "SIMPL-42");
    assert.deepEqual(issue.data.fields, { summary: "Example issue summary" });
    assert.deepEqual(issue.data.links, [{ id: "500", type: "Blocks", direction: "outward", otherIssue: "SIMPL-41" }]);
    assert.deepEqual(issue.data.changelog, {
      requested: true,
      entries: [{
        id: "800",
        created: "2026-10-02T09:10:00.000+0000",
        author: { displayName: "Test User", name: "test.user" },
        changes: [{ field: "summary", fieldId: "summary", from: "Old summary", to: "Example issue summary" }],
      }],
      returnedCount: 1,
      startAt: 0,
      total: 1,
      completeness: "complete",
      continuation: { supported: false, reason: "endpoint_unverified" },
    });

    const firstComments = structured<{ data: { items: Array<{ body?: string | null }>; nextStartAt?: number; hasMore: boolean } }>(
      await client.callTool({ name: "jira_list_comments", arguments: { issueKey: "SIMPL-42", maxResults: 1 } }),
    );
    assert.equal(firstComments.data.items[0]?.body, "First comment");
    assert.equal(firstComments.data.hasMore, true);
    assert.equal(firstComments.data.nextStartAt, 1);
    const nextComments = structured<{ data: { items: Array<{ body?: string | null }>; hasMore: boolean } }>(
      await client.callTool({ name: "jira_list_comments", arguments: { issueKey: "SIMPL-42", startAt: firstComments.data.nextStartAt, maxResults: 1 } }),
    );
    assert.equal(nextComments.data.items[0]?.body, "Second comment");
    assert.equal(nextComments.data.hasMore, false);

    const oversizedComments = structured<{ data: { items: Array<{ body?: string }>; returnedCount: number }; omissions: Array<{ recovery: { tool: string; commentId?: string; expectedUpdated?: string } }> }>(
      await client.callTool({ name: "jira_list_comments", arguments: { issueKey: "SIMPL-42", maxResults: 100 } }),
    );
    assert.equal(oversizedComments.data.items[0]?.body, undefined);
    assert.deepEqual(oversizedComments.omissions[0]?.recovery, {
      tool: "jira_read_comment",
      issueKey: "SIMPL-42",
      commentId: "700",
      expectedUpdated: "2026-10-02T09:00:00.000+0000",
    });
    const commentWindow = structured<{ data: { text: string; returnedCount: number; updated: string; complete: boolean; nextOffset?: number } }>(
      await client.callTool({ name: "jira_read_comment", arguments: { issueKey: "SIMPL-42", commentId: "700", length: 8000 } }),
    );
    assert.deepEqual({
      text: commentWindow.data.text,
      returnedCount: commentWindow.data.returnedCount,
      complete: commentWindow.data.complete,
      nextOffset: commentWindow.data.nextOffset,
    }, { text: "x".repeat(8000), returnedCount: 8000, complete: false, nextOffset: 8000 });
    const commentWindowEnd = structured<{ data: { text: string; returnedCount: number; complete: boolean } }>(
      await client.callTool({
        name: "jira_read_comment",
        arguments: { issueKey: "SIMPL-42", commentId: "700", offset: 8000, length: 8000, expectedUpdated: commentWindow.data.updated },
      }),
    );
    assert.deepEqual(commentWindowEnd.data, {
      text: "x".repeat(5000), encoding: "plain", offset: 8000, returnedCount: 5000,
      totalCodePoints: 13_000, updated: commentWindow.data.updated, complete: true,
    });

    const remoteLinks = structured<{ data: { items: Array<{ id: string; title: string }>; hasMore: boolean } }>(
      await client.callTool({ name: "jira_list_remote_links", arguments: { issueKey: "SIMPL-42" } }),
    );
    assert.deepEqual(remoteLinks.data.items.map(({ id, title }) => ({ id, title })), [
      { id: "11", title: "First link" }, { id: "22", title: "Second link" },
    ]);
    assert.equal(remoteLinks.data.hasMore, false);

    const transitions = structured<{ data: { items: Array<{ id: string; targetStatus: { name: string } }> } }>(
      await client.callTool({ name: "jira_list_transitions", arguments: { issueKey: "SIMPL-42" } }),
    );
    assert.deepEqual(transitions.data.items, [
      { id: "31", name: "Start progress", targetStatus: { id: "3", name: "In Progress" }, fields: [] },
      { id: "7", name: "Close", targetStatus: { id: "6", name: "Closed" }, fields: [] },
    ]);

    const fieldWindow = structured<{ data: { text: string; encoding: string; complete: boolean } }>(
      await client.callTool({ name: "jira_read_issue_field", arguments: { issueKey: "SIMPL-42", fieldId: "summary" } }),
    );
    assert.deepEqual(fieldWindow.data, {
      text: "Example issue summary",
      encoding: "plain",
      offset: 0,
      returnedCount: 21,
      totalCodePoints: 21,
      updated: "2026-10-02T09:14:00.000+0000",
      complete: true,
    });

    const boards = structured<{ data: { items: Array<{ id: number; type: string }>; upstream: { source: string; isLast: boolean }; hasMore: boolean } }>(
      await client.callTool({ name: "jira_list_boards", arguments: { maxResults: 1 } }),
    );
    assert.deepEqual(boards.data.items, [{ id: 172, name: "Kanban", type: "kanban" }]);
    assert.deepEqual(boards.data.upstream, { source: "isLast", isLast: false, total: 2 });
    assert.equal(boards.data.hasMore, true);

    const board = structured<{ data: { id: number; type: string; configuration: Record<string, unknown> } }>(
      await client.callTool({ name: "jira_get_board", arguments: { boardId: 183 } }),
    );
    assert.deepEqual(board.data, {
      id: 183, name: "Scrum", type: "scrum", configuration: { columnConfig: { columns: [{ name: "To Do" }] } },
    });

    const boardIssues = structured<{ data: { items: Array<{ key: string; fields: Record<string, unknown> }>; upstream: { source: string; isLast: boolean } } }>(
      await client.callTool({ name: "jira_list_board_issues", arguments: { boardId: 183, fields: ["summary"] } }),
    );
    assert.equal(boardIssues.data.items[0]?.key, "SIMPL-42");
    assert.deepEqual(boardIssues.data.items[0]?.fields, { summary: "Example issue summary" });
    assert.deepEqual(boardIssues.data.upstream, { source: "isLast", isLast: true, total: 1 });

    const sprints = structured<{ data: { items: Array<{ id: number; state: string }>; upstream: { source: string; isLast: boolean }; nextStartAt: number } }>(
      await client.callTool({ name: "jira_list_sprints", arguments: { boardId: 183, state: ["active", "future"], maxResults: 1 } }),
    );
    assert.deepEqual(sprints.data.items, [{
      id: 701, name: "Current sprint", state: "active", startDate: "2026-09-01", endDate: "2026-09-14", goal: "Deliver the release",
    }]);
    assert.deepEqual(sprints.data.upstream, { source: "isLast", isLast: false });
    assert.equal(sprints.data.nextStartAt, 1);

    const issueTypes = structured<{ data: { kind: string; page: { items: Array<{ id: string; name: string }> } } }>(
      await client.callTool({ name: "jira_get_create_metadata", arguments: { projectKey: "SIMPL", maxResults: 1 } }),
    );
    assert.deepEqual(issueTypes.data, {
      kind: "issueTypes", projectKey: "SIMPL", page: {
        items: [{ id: "10001", name: "Task" }], startAt: 0, returnedCount: 1, hasMore: true,
        nextStartAt: 1, upstream: { source: "total", total: 2 },
      },
    });

    const createFields = structured<{
      data: {
        kind: string;
        page: { items: Array<{
          id: string;
          required: boolean | "unknown";
          operations: string[] | "unknown";
          allowedValues: unknown[] | "unknown";
        }> };
      };
    }>(
      await client.callTool({ name: "jira_get_create_metadata", arguments: { projectKey: "SIMPL", issueTypeId: "10001" } }),
    );
    assert.equal(createFields.data.kind, "fields");
    assert.deepEqual(createFields.data.page.items.map(({ id, required, operations, allowedValues }) => ({ id, required, operations, allowedValues })), [
      { id: "summary", required: true, operations: ["set"], allowedValues: [] },
      { id: "customfield_10001", required: false, operations: ["set"], allowedValues: [] },
      { id: "customfield_10002", required: "unknown", operations: "unknown", allowedValues: "unknown" },
    ]);

    const editFields = structured<{ data: { page: { items: Array<{ id: string; required: boolean }> } } }>(
      await client.callTool({ name: "jira_get_edit_metadata", arguments: { issueKey: "SIMPL-42" } }),
    );
    assert.deepEqual(editFields.data.page.items.map(({ id, required }) => ({ id, required })), [
      { id: "customfield_10001", required: false }, { id: "summary", required: true },
    ]);

    const assignees = structured<{ data: { items: Array<{ name: string; displayName: string; active: boolean }> } }>(
      await client.callTool({ name: "jira_find_assignable_users", arguments: { projectKey: "SIMPL", issueKey: "SIMPL-42", query: "test" } }),
    );
    assert.deepEqual(assignees.data.items, [{ name: "test.user", displayName: "Test User", active: true }]);
    assert.equal(JSON.stringify(assignees).includes("private@example.com"), false);

    const worklogs = structured<{ data: { items: Array<{ id: string; timeSpentSeconds: number; comment: string | null }> } }>(
      await client.callTool({ name: "jira_list_worklogs", arguments: { issueKey: "SIMPL-42" } }),
    );
    assert.deepEqual(worklogs.data.items, [{
      id: "501", author: { displayName: "Test User", name: "test.user" }, started: "2026-10-02T09:00:00.000+0000",
      timeSpentSeconds: 3600, comment: "Research work",
    }]);

    const filters = structured<{ data: { items: Array<{ id: string; name: string; browseUrl: string }> } }>(
      await client.callTool({ name: "jira_list_favourite_filters", arguments: {} }),
    );
    assert.deepEqual(filters.data.items, [
      { id: "10", name: "My Issues", jql: "assignee = currentUser()", browseUrl: "https://jira.example.com/jira/secure/IssueNavigator.jspa?requestId=10" },
      { id: "11", name: "Recently Updated", jql: "updated >= -7d", browseUrl: "https://jira.example.com/jira/secure/IssueNavigator.jspa?requestId=11" },
    ]);

    const dashboards = structured<{ data: { items: Array<{ id: string; name: string; browseUrl: string }>; upstream: { source: string; total: number } } }>(
      await client.callTool({ name: "jira_list_dashboards", arguments: { maxResults: 1 } }),
    );
    assert.deepEqual(dashboards.data.items, [{
      id: "10020", name: "Team Dashboard", browseUrl: "https://jira.example.com/jira/secure/Dashboard.jspa?selectPageId=10020",
    }]);
    assert.deepEqual(dashboards.data.upstream, { source: "total", total: 2 });

    const attachments = structured<{ data: { items: Array<{ id: string; filename: string; mimeType: string; sizeBytes: number }> } }>(
      await client.callTool({ name: "jira_list_attachments", arguments: { issueKey: "SIMPL-42" } }),
    );
    assert.deepEqual(attachments.data.items.map(({ id, filename }) => ({ id, filename })), [
      { id: "90001", filename: "diagram.png" }, { id: "90002", filename: "notes.txt" },
    ]);
  } finally {
    await client.close();
  }
}

test("official client discovers and calls tools over modern stdio", async () => {
  await callThroughStdio(true);
});

test("official client uses the legacy compatibility path over stdio", async () => {
  await callThroughStdio(false);
});

test("write mode fails closed and Kanban sprint reads return a clear error", async () => {
  const config = readConfig({ JIRA_URL: "https://jira.example.com", JIRA_KEY: "test-token" });
  assert.throws(() => createServer(new JiraClient(config), true), /Write tools are not implemented/);

  const root = process.cwd();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", resolve(root, "test/fixtures/mock-jira-fetch.mjs"), resolve(root, "dist/index.js")],
    cwd: root,
    env: { ...getDefaultEnvironment(), JIRA_URL: "https://jira.example.com/jira", JIRA_KEY: "test-token" },
    stderr: "pipe",
  });
  const client = new Client({ name: "jira-mcp-kanban-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "jira_list_sprints", arguments: { boardId: 172 } });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /unsupported_value/);
  } finally {
    await client.close();
  }
});
