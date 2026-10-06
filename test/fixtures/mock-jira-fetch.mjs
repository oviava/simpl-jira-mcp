const serverOrigin = "https://jira.example.com";
const apiRoot = "/jira/rest/api/2/";
const agileRoot = "/jira/rest/agile/1.0/";

globalThis.fetch = async (input, init = {}) => {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(rawUrl);
  const headers = new Headers(init.headers);
  if (url.origin !== serverOrigin || headers.get("authorization") !== "Bearer test-token") {
    return new Response(JSON.stringify({ errorMessages: ["not found"] }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  if (init.method !== "GET" || init.redirect !== "manual") {
    return new Response(JSON.stringify({ errorMessages: ["unexpected request"] }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  let body;
  if (url.pathname === `${agileRoot}board`) {
    body = {
      startAt: Number(url.searchParams.get("startAt")), maxResults: Number(url.searchParams.get("maxResults")),
      total: 2, isLast: false, values: [{ id: 172, name: "Kanban", type: "kanban" }],
    };
  } else if (url.pathname === `${agileRoot}board/172/configuration`) {
    body = { id: 172, name: "Kanban", type: "kanban", columnConfig: { columns: [{ name: "To Do" }] } };
  } else if (url.pathname === `${agileRoot}board/183/configuration`) {
    body = { id: 183, name: "Scrum", type: "scrum", columnConfig: { columns: [{ name: "To Do" }] } };
  } else if (url.pathname === `${agileRoot}board/183/issue`) {
    body = {
      startAt: 0, maxResults: 20, total: 1, isLast: true,
      issues: [{ id: "10042", key: "SIMPL-42", fields: { updated: "2026-10-02T09:14:00.000+0000", summary: "Example issue summary" } }],
    };
  } else if (url.pathname === `${agileRoot}board/183/sprint`) {
    body = {
      startAt: 0, maxResults: 1, isLast: false,
      values: [{ id: 701, name: "Current sprint", state: "active", startDate: "2026-09-01", endDate: "2026-09-14", goal: "Deliver the release" }],
    };
  } else if (url.pathname === `${apiRoot}myself`) {
    body = { name: "test.user", displayName: "Test User", emailAddress: "private@example.com", active: true };
  } else if (url.pathname === `${apiRoot}serverInfo`) {
    body = { version: "10.3.25" };
  } else if (url.pathname === `${apiRoot}mypermissions`) {
    body = { permissions: {
      BROWSE_PROJECTS: { havePermission: true },
      CREATE_ISSUES: { havePermission: true },
      PROJECT_VIEW_ALL_WORKLOGS: { havePermission: false },
    } };
  } else if (url.pathname === `${apiRoot}project`) {
    body = [
      { id: "10002", key: "ZETA", name: "Zeta project", projectTypeKey: "software" },
      { id: "10000", key: "SIMPL", name: "Example project", projectTypeKey: "software" },
      { id: "10001", key: "ALPHA", name: "Alpha project", projectTypeKey: "software" },
    ];
  } else if (url.pathname === `${apiRoot}project/SIMPL`) {
    body = {
      id: "10000", key: "SIMPL", name: "Example project", projectTypeKey: "software",
      description: "A synthetic project.",
      issueTypes: [{ id: "20002", name: "Bug" }, { id: "10001", name: "Task" }],
    };
  } else if (url.pathname === `${apiRoot}project/SIMPL/components`) {
    body = [{ id: "30", name: "Other component" }, { id: "12", name: "Example component" }];
  } else if (url.pathname === `${apiRoot}project/SIMPL/versions`) {
    body = [{ id: "99", name: "1.0" }];
  } else if (url.pathname === `${apiRoot}field`) {
    body = [
      { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
      { id: "customfield_10001", name: "Example custom field", custom: true, schema: { type: "string" } },
    ];
  } else if (url.pathname === `${apiRoot}issue/createmeta/SIMPL/issuetypes`) {
    body = {
      startAt: Number(url.searchParams.get("startAt")), maxResults: Number(url.searchParams.get("maxResults")),
      total: 2, isLast: false, values: [{ id: "10001", name: "Task" }],
    };
  } else if (url.pathname === `${apiRoot}issue/createmeta/SIMPL/issuetypes/10001`) {
    body = {
      startAt: 0, maxResults: 20, total: 3, isLast: true,
      values: [
        { fieldId: "summary", name: "Summary", required: true, schema: { type: "string" }, operations: ["set"], allowedValues: [] },
        { fieldId: "customfield_10001", name: "Example custom field", required: false, schema: { type: "string" }, operations: ["set"], allowedValues: [] },
        { fieldId: "customfield_10002", name: "Incomplete metadata", schema: { type: "string" } },
      ],
    };
  } else if (url.pathname === `${apiRoot}issue/SIMPL-42/editmeta`) {
    body = { fields: {
      summary: { name: "Summary", required: true, schema: { type: "string" }, operations: ["set"], allowedValues: [] },
      customfield_10001: { name: "Example custom field", required: false, schema: { type: "string" }, operations: ["set"], allowedValues: [] },
    } };
  } else if (url.pathname === `${apiRoot}user/assignable/search`) {
    body = [{ name: "test.user", key: "test.user", displayName: "Test User", active: true, emailAddress: "private@example.com" }];
  } else if (url.pathname === `${apiRoot}issue/SIMPL-42/worklog`) {
    body = {
      startAt: Number(url.searchParams.get("startAt")), maxResults: Number(url.searchParams.get("maxResults")), total: 1,
      worklogs: [{
        id: "501", author: { name: "test.user", displayName: "Test User" }, started: "2026-10-02T09:00:00.000+0000",
        timeSpentSeconds: 3600, comment: "Research work",
      }],
    };
  } else if (url.pathname === `${apiRoot}filter/favourite`) {
    body = [
      { id: "11", name: "Recently Updated", jql: "updated >= -7d" },
      { id: "10", name: "My Issues", jql: "assignee = currentUser()" },
    ];
  } else if (url.pathname === `${apiRoot}dashboard`) {
    body = {
      startAt: Number(url.searchParams.get("startAt")), maxResults: Number(url.searchParams.get("maxResults")), total: 2,
      dashboards: [{ id: "10020", name: "Team Dashboard" }],
    };
  } else if (url.pathname === `${apiRoot}search`) {
    if (url.searchParams.get("fields") === "attachment") {
      if (url.searchParams.get("jql") !== "key = SIMPL-42" || url.searchParams.get("maxResults") !== "1") {
        return new Response(JSON.stringify({ errorMessages: ["unexpected attachment search"] }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      body = {
        startAt: 0, maxResults: 1, total: 1,
        issues: [{
          id: "10042", key: "SIMPL-42",
          fields: { attachment: [
            { id: "90002", filename: "notes.txt", mimeType: "text/plain", size: 512, created: "2026-10-02T09:01:00.000+0000" },
            { id: "90001", filename: "diagram.png", mimeType: "image/png", size: 2048, created: "2026-10-02T09:00:00.000+0000" },
          ] },
        }],
      };
    } else {
      body = {
        startAt: Number(url.searchParams.get("startAt")),
        maxResults: Number(url.searchParams.get("maxResults")),
        total: 2,
        issues: [{
          id: "10042", key: "SIMPL-42",
          fields: { updated: "2026-10-02T09:14:00.000+0000", summary: "Example issue summary" },
        }],
      };
    }
  } else if (url.pathname === `${apiRoot}issue/SIMPL-42` && url.searchParams.has("fields")) {
    body = {
      id: "10042", key: "SIMPL-42",
      fields: {
        updated: "2026-10-02T09:14:00.000+0000",
        summary: "Example issue summary",
        issuelinks: [{
          id: "500", type: { name: "Blocks" }, outwardIssue: { key: "SIMPL-41" },
        }],
      },
      names: { summary: "Summary" },
      schema: { summary: { type: "string" } },
      ...(url.searchParams.get("expand")?.includes("changelog") ? {
        changelog: {
          startAt: 0, total: 1,
          histories: [{
            id: "800", created: "2026-10-02T09:10:00.000+0000",
            author: { name: "test.user", displayName: "Test User" },
            items: [{ field: "summary", fieldId: "summary", from: "Old summary", to: "Example issue summary" }],
          }],
        },
      } : {}),
    };
  } else if (url.pathname === `${apiRoot}issue/SIMPL-42/comment`) {
    const startAt = Number(url.searchParams.get("startAt"));
    const maxResults = Number(url.searchParams.get("maxResults"));
    const comments = [
      {
        id: "700", author: { name: "test.user", displayName: "Test User" },
        body: maxResults === 100 ? "x".repeat(13_000) : "First comment",
        created: "2026-10-02T09:00:00.000+0000", updated: "2026-10-02T09:00:00.000+0000",
      },
      {
        id: "701", author: { name: "test.user", displayName: "Test User" },
        body: "Second comment",
        created: "2026-10-02T09:00:00.000+0000", updated: "2026-10-02T09:00:00.000+0000",
      },
    ];
    body = {
      startAt, maxResults, total: comments.length,
      comments: comments.slice(startAt, startAt + maxResults),
    };
  } else if (url.pathname === `${apiRoot}issue/SIMPL-42/remotelink`) {
    body = [
      { id: 22, object: { title: "Second link", url: "https://example.com/second" } },
      { id: 11, object: { title: "First link", url: "https://example.com/first" } },
    ];
  } else if (url.pathname === `${apiRoot}issue/SIMPL-42/transitions`) {
    body = { transitions: [
      { id: "7", name: "Close", to: { id: "6", name: "Closed" }, fields: {} },
      { id: "31", name: "Start progress", to: { id: "3", name: "In Progress" }, fields: {} },
    ] };
  } else {
    return new Response(JSON.stringify({ errorMessages: ["not found"] }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
};
