import assert from "node:assert/strict";
import { test } from "node:test";
import { JiraClient, JiraError, readConfig } from "../src/jira.js";
import { inputSchemas } from "../src/schemas.js";

type FetchHandler = (url: URL, init: RequestInit) => Promise<Response>;

function replaceFetch(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(new URL(rawUrl), init);
  };
  return () => { globalThis.fetch = original; };
}

function jira(): JiraClient {
  return new JiraClient(readConfig({
    JIRA_URL: "https://jira.example.com/jira",
    JIRA_KEY: "unit-test-token",
  }));
}

const options = { signal: new AbortController().signal };
const projectsInput = inputSchemas.jira_list_projects.parse({});

test("readConfig rejects credentials in the Jira URL and invalid write flags", () => {
  assert.throws(() => readConfig({ JIRA_URL: "https://user:pass@jira.example.com", JIRA_KEY: "x" }), /cannot contain credentials/);
  assert.throws(() => readConfig({ JIRA_URL: "http://jira.example.com", JIRA_KEY: "x" }), /must use HTTPS/);
  assert.throws(() => readConfig({ JIRA_URL: "https://jira.example.com", JIRA_KEY: "x", JIRA_ENABLE_WRITES: "yes" }), /must be either true or false/);
  assert.equal(readConfig({ JIRA_URL: "https://jira.example.com/jira", JIRA_KEY: "token" }).jiraUrl.toString(), "https://jira.example.com/jira/");
});

test("searchIssues preserves the installation path and returns a recoverable page", async () => {
  const restore = replaceFetch(async (url, init) => {
    assert.equal(url.pathname, "/jira/rest/api/2/search");
    assert.equal(url.searchParams.get("jql"), "project = SIMPL");
    assert.equal(url.searchParams.get("fields"), "summary,description,updated,issuelinks");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer unit-test-token");
    return new Response(JSON.stringify({
      startAt: 0,
      maxResults: 1,
      total: 2,
      issues: [{
        id: "10042",
        key: "SIMPL-42",
        fields: {
          updated: "2026-10-02T09:14:00.000+0000",
          summary: "Example issue",
          description: "x".repeat(13_000),
        },
      }],
    }), { headers: { "content-type": "application/json" } });
  });
  try {
    const result = await jira().searchIssues(inputSchemas.jira_search_issues.parse({
      jql: "project = SIMPL",
      fields: ["summary", "description"],
      maxResults: 1,
    }), options);
    assert.deepEqual(result.data.items[0]?.fields, { summary: "Example issue" });
    assert.equal(result.data.nextStartAt, 1);
    assert.equal(result.data.upstream.source, "total");
    assert.equal(result.omissions[0]?.path, "data.items[0].fields.description");
    assert.deepEqual(result.omissions[0]?.recovery, {
      tool: "jira_read_issue_field",
      issueKey: "SIMPL-42",
      fieldId: "description",
      expectedUpdated: "2026-10-02T09:14:00.000+0000",
    });
  } finally {
    restore();
  }
});

test("result packing advances only by delivered issues and removes their stale omissions", async () => {
  const fieldIds = Array.from({ length: 20 }, (_value, index) => `customfield_${index + 1}`);
  const restore = replaceFetch(async () => new Response(JSON.stringify({
    startAt: 0,
    total: 2,
    issues: [0, 1].map(index => ({
      id: String(10042 + index),
      key: `SIMPL-${42 + index}`,
      fields: {
        updated: "2026-10-02T09:14:00.000+0000",
        description: "y".repeat(13_000),
        ...Object.fromEntries(fieldIds.map(fieldId => [fieldId, "x".repeat(10_000)])),
      },
    })),
  }), { headers: { "content-type": "application/json" } }));
  try {
    const result = await jira().searchIssues(inputSchemas.jira_search_issues.parse({
      jql: "project = SIMPL",
      fields: ["description", ...fieldIds],
      maxResults: 2,
    }), options);
    assert.equal(result.data.returnedCount, 1);
    assert.equal(result.data.nextStartAt, 1);
    assert.deepEqual(result.omissions.map(omission => omission.path), ["data.items[0].fields.description"]);
  } finally {
    restore();
  }
});

test("a single oversized catalog item fails with an identifier and continuation offset", async () => {
  const restore = replaceFetch(async () => new Response(JSON.stringify([{
    id: "777",
    object: { title: "Large remote link", url: "https://example.com/" + "x".repeat(230_000) },
  }]), { headers: { "content-type": "application/json" } }));
  try {
    await assert.rejects(
      jira().listRemoteLinks(inputSchemas.jira_list_remote_links.parse({ issueKey: "SIMPL-42" }), options),
      error => error instanceof JiraError
        && error.failure.kind === "result_too_large"
        && error.failure.resource.kind === "catalog_item"
        && error.failure.resource.id === "777"
        && error.failure.resource.startAt === 0,
    );
  } finally {
    restore();
  }
});

test("issue-field windows count Unicode code points and reject a changed revision", async () => {
  const restore = replaceFetch(async () => new Response(JSON.stringify({
    key: "SIMPL-42",
    fields: { updated: "2026-10-02T09:14:00.000+0000", description: "A😀B" },
  }), { headers: { "content-type": "application/json" } }));
  try {
    const client = jira();
    const first = await client.readIssueField(inputSchemas.jira_read_issue_field.parse({
      issueKey: "SIMPL-42", fieldId: "description", length: 2,
    }), options);
    assert.equal(first.data.text, "A😀");
    assert.equal(first.data.returnedCount, 2);
    assert.equal(first.data.nextOffset, 2);
    assert.equal(first.data.complete, false);

    const second = await client.readIssueField(inputSchemas.jira_read_issue_field.parse({
      issueKey: "SIMPL-42", fieldId: "description", offset: 2,
      expectedUpdated: first.data.updated,
    }), options);
    assert.equal(second.data.text, "B");
    assert.equal(second.data.complete, true);

    await assert.rejects(
      client.readIssueField(inputSchemas.jira_read_issue_field.parse({
        issueKey: "SIMPL-42", fieldId: "description", offset: 1,
        expectedUpdated: "2026-10-01T09:14:00.000+0000",
      }), options),
      error => error instanceof JiraError && error.failure.kind === "source_changed",
    );
  } finally {
    restore();
  }
});

test("issue-field recovery serializes object values with canonical key order", async () => {
  const restore = replaceFetch(async () => new Response(JSON.stringify({
    key: "SIMPL-42",
    fields: { updated: "2026-10-02T09:14:00.000+0000", customfield_10001: { z: 1, a: { y: true, b: false } } },
  }), { headers: { "content-type": "application/json" } }));
  try {
    const result = await jira().readIssueField(inputSchemas.jira_read_issue_field.parse({
      issueKey: "SIMPL-42", fieldId: "customfield_10001",
    }), options);
    assert.equal(result.data.text, '{"a":{"b":false,"y":true},"z":1}');
    assert.equal(result.data.encoding, "json");
  } finally {
    restore();
  }
});

test("oversized comments identify bounded recovery and comment windows scan by ID", async () => {
  const updated = "2026-10-02T09:14:00.000+0000";
  const comments = Array.from({ length: 100 }, (_value, index) => ({
    id: String(index + 1), created: updated, updated, body: `comment-${index + 1}`,
  }));
  const target = { id: "900", created: updated, updated, body: "Second page comment 😀" };
  const requestedOffsets: number[] = [];
  const restore = replaceFetch(async url => {
    assert.equal(url.pathname, "/jira/rest/api/2/issue/SIMPL-42/comment");
    const startAt = Number(url.searchParams.get("startAt"));
    requestedOffsets.push(startAt);
    const page = startAt === 0 ? comments : [target];
    return new Response(JSON.stringify({ startAt, total: 101, comments: page }), {
      headers: { "content-type": "application/json" },
    });
  });
  try {
    const result = await jira().readComment(inputSchemas.jira_read_comment.parse({
      issueKey: "SIMPL-42", commentId: "900", length: 8,
    }), options);
    assert.deepEqual(requestedOffsets, [0, 100]);
    assert.equal(result.data.text, "Second p");
    assert.equal(result.data.returnedCount, 8);
    assert.equal(result.data.nextOffset, 8);
    assert.equal(result.data.encoding, "plain");
  } finally {
    restore();
  }

  const oversizedRestore = replaceFetch(async () => new Response(JSON.stringify({
    startAt: 0, total: 1,
    comments: [{ id: "900", created: updated, updated, body: "x".repeat(13_000) }],
  }), { headers: { "content-type": "application/json" } }));
  try {
    const listed = await jira().listComments(inputSchemas.jira_list_comments.parse({ issueKey: "SIMPL-42" }), options);
    assert.equal(listed.data.items[0]?.body, undefined);
    assert.deepEqual(listed.omissions[0]?.recovery, {
      tool: "jira_read_comment", issueKey: "SIMPL-42", commentId: "900", expectedUpdated: updated,
    });
  } finally {
    oversizedRestore();
  }
});

test("comment recovery preserves null, detects revision changes, and refuses incomplete scans", async () => {
  const initialUpdated = "2026-10-02T09:14:00.000+0000";
  const restore = replaceFetch(async () => {
    return new Response(JSON.stringify({
      startAt: 0,
      total: 1,
      comments: [{ id: "901", created: initialUpdated, updated: "2026-10-02T09:15:00.000+0000", body: null }],
    }), { headers: { "content-type": "application/json" } });
  });
  try {
    const client = jira();
    await assert.rejects(
      client.readComment(inputSchemas.jira_read_comment.parse({
        issueKey: "SIMPL-42", commentId: "901", offset: 2, expectedUpdated: initialUpdated,
      }), options),
      error => error instanceof JiraError && error.failure.kind === "source_changed",
    );
  } finally {
    restore();
  }

  const nullRestore = replaceFetch(async () => new Response(JSON.stringify({
    startAt: 0, total: 1,
    comments: [{ id: "901", created: initialUpdated, updated: initialUpdated, body: null }],
  }), { headers: { "content-type": "application/json" } }));
  try {
    const result = await jira().readComment(inputSchemas.jira_read_comment.parse({ issueKey: "SIMPL-42", commentId: "901" }), options);
    assert.equal(result.data.text, "null");
    assert.equal(result.data.encoding, "json");
  } finally {
    nullRestore();
  }

  const noTotalRestore = replaceFetch(async () => new Response(JSON.stringify({
    startAt: 0, comments: [{ id: "902", created: initialUpdated, updated: initialUpdated, body: "other" }],
  }), { headers: { "content-type": "application/json" } }));
  try {
    await assert.rejects(
      jira().readComment(inputSchemas.jira_read_comment.parse({ issueKey: "SIMPL-42", commentId: "903" }), options),
      error => error instanceof JiraError && error.failure.kind === "unavailable",
    );
  } finally {
    noTotalRestore();
  }

  const foundWithoutTotalRestore = replaceFetch(async () => new Response(JSON.stringify({
    startAt: 0,
    comments: [{ id: "903", created: initialUpdated, updated: initialUpdated, body: "found without total" }],
  }), { headers: { "content-type": "application/json" } }));
  try {
    const result = await jira().readComment(inputSchemas.jira_read_comment.parse({
      issueKey: "SIMPL-42", commentId: "903",
    }), options);
    assert.equal(result.data.text, "found without total");
  } finally {
    foundWithoutTotalRestore();
  }

  let changingPages = 0;
  const changingRestore = replaceFetch(async url => {
    changingPages += 1;
    const startAt = Number(url.searchParams.get("startAt"));
    const comments = startAt === 0
      ? Array.from({ length: 100 }, (_value, index) => ({
        id: String(index + 1), created: initialUpdated, updated: initialUpdated, body: "other",
      }))
      : [{ id: "101", created: initialUpdated, updated: initialUpdated, body: "other" }];
    return new Response(JSON.stringify({ startAt, total: startAt === 0 ? 101 : 102, comments }), {
      headers: { "content-type": "application/json" },
    });
  });
  try {
    await assert.rejects(
      jira().readComment(inputSchemas.jira_read_comment.parse({ issueKey: "SIMPL-42", commentId: "903" }), options),
      error => error instanceof JiraError && error.failure.kind === "unavailable",
    );
    assert.equal(changingPages, 2);
  } finally {
    changingRestore();
  }

  let foundOnChangingTotalPage = 0;
  const foundAfterChangeRestore = replaceFetch(async url => {
    const startAt = Number(url.searchParams.get("startAt"));
    foundOnChangingTotalPage += 1;
    if (startAt === 0) {
      return new Response(JSON.stringify({
        startAt, total: 101,
        comments: Array.from({ length: 100 }, (_value, index) => ({
          id: String(index + 1), created: initialUpdated, updated: initialUpdated, body: "other",
        })),
      }), { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      startAt, total: 102,
      comments: [{ id: "903", created: initialUpdated, updated: initialUpdated, body: "found after page drift" }],
    }), { headers: { "content-type": "application/json" } });
  });
  try {
    const result = await jira().readComment(inputSchemas.jira_read_comment.parse({
      issueKey: "SIMPL-42", commentId: "903",
    }), options);
    assert.equal(result.data.text, "found after page drift");
    assert.equal(foundOnChangingTotalPage, 2);
  } finally {
    foundAfterChangeRestore();
  }

  let scannedPages = 0;
  const cappedRestore = replaceFetch(async url => {
    scannedPages += 1;
    const startAt = Number(url.searchParams.get("startAt"));
    const comments = Array.from({ length: 100 }, (_value, index) => ({
      id: String(startAt + index + 1), created: initialUpdated, updated: initialUpdated, body: "other",
    }));
    return new Response(JSON.stringify({ startAt, total: 2001, comments }), {
      headers: { "content-type": "application/json" },
    });
  });
  try {
    await assert.rejects(
      jira().readComment(inputSchemas.jira_read_comment.parse({ issueKey: "SIMPL-42", commentId: "999999" }), options),
      error => error instanceof JiraError && error.failure.kind === "unavailable",
    );
    assert.equal(scannedPages, 20);
  } finally {
    cappedRestore();
  }
});

test("attachment retrieval returns bounded verified text and image content", async () => {
  const textBytes = new TextEncoder().encode("safe note\n");
  const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  let requestedMime = "";
  let requestedUrl = "";
  const restore = replaceFetch(async (url, init) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer unit-test-token");
    assert.equal(init.redirect, "manual");
    if (url.pathname === "/jira/rest/api/2/search") {
      assert.equal(url.searchParams.get("jql"), "key = SIMPL-42");
      assert.equal(url.searchParams.get("fields"), "attachment");
      return new Response(JSON.stringify({
        issues: [{ key: "SIMPL-42", fields: { attachment: [
          { id: "90002", filename: "notes.txt", mimeType: "text/plain", size: textBytes.byteLength, created: "2026-10-02", content: "/jira/secure/attachment/90002" },
          { id: "90001", filename: "diagram.png", mimeType: "image/png", size: imageBytes.byteLength, created: "2026-10-02", content: "/jira/secure/attachment/90001" },
        ] } }],
      }), { headers: { "content-type": "application/json" } });
    }
    requestedMime = headers.get("accept") ?? "";
    requestedUrl = url.href;
    const bytes = url.pathname.endsWith("90002") ? textBytes : imageBytes;
    const mimeType = url.pathname.endsWith("90002") ? "text/plain" : "image/png";
    return new Response(bytes, {
      headers: { "content-type": mimeType, "content-length": String(bytes.byteLength) },
    });
  });
  try {
    const client = jira();
    const text = await client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90002" }), options);
    assert.deepEqual(text.data, { kind: "text", mimeType: "text/plain", text: "safe note\n" });
    assert.equal(requestedMime, "text/plain");
    assert.equal(new URL(requestedUrl).origin, "https://jira.example.com");

    const image = await client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90001" }), options);
    assert.deepEqual(image.data, { kind: "image", mimeType: "image/png", base64: Buffer.from(imageBytes).toString("base64") });
  } finally {
    restore();
  }
});

test("attachment retrieval rejects untrusted URLs, MIME mismatches, redirects, and oversized bodies", async () => {
  const metadata = (content: string, mimeType = "text/plain", size = 1) => ({
    id: "90002", filename: "notes.txt", mimeType, size, created: "2026-10-02", content,
  });
  let contentRequests = 0;
  let selected = metadata("/jira/secure/attachment/90002");
  let responseFactory: () => Response = () => new Response("x", {
    headers: { "content-type": "text/plain", "content-length": "1" },
  });
  const restore = replaceFetch(async (url, init) => {
    if (url.pathname === "/jira/rest/api/2/search") {
      return new Response(JSON.stringify({ issues: [{ key: "SIMPL-42", fields: { attachment: [selected] } }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    contentRequests += 1;
    assert.equal(init.redirect, "manual");
    return responseFactory();
  });
  try {
    const client = jira();
    selected = metadata("https://attacker.example/steal");
    await assert.rejects(
      client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90002" }), options),
      error => error instanceof JiraError && error.failure.kind === "unsupported_value",
    );
    assert.equal(contentRequests, 0);

    selected = metadata("https://jira.example.com/outside/attachment/90002");
    await assert.rejects(
      client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90002" }), options),
      error => error instanceof JiraError && error.failure.kind === "unsupported_value",
    );
    for (const unsafePath of [
      "/jira/%2F..%2Foutside/attachment/90002",
      "/jira/%5C..%5Coutside/attachment/90002",
      "/jira/%2e%2e/outside/attachment/90002",
      "/jira/%252e%252e/outside/attachment/90002",
      "/jira/%252f..%252foutside/attachment/90002",
      "/jira/%255c..%255coutside/attachment/90002",
    ]) {
      selected = metadata(`https://jira.example.com${unsafePath}`);
      await assert.rejects(
        client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90002" }), options),
        error => error instanceof JiraError && error.failure.kind === "unsupported_value",
      );
    }
    assert.equal(contentRequests, 0);

    selected = metadata("/jira/secure/attachment/90002");
    responseFactory = () => new Response("x", { headers: { "content-type": "application/json", "content-length": "1" } });
    await assert.rejects(
      client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90002" }), options),
      error => error instanceof JiraError && error.failure.kind === "unexpected_response",
    );

    responseFactory = () => new Response(null, { status: 302, headers: { location: "https://attacker.example/" } });
    await assert.rejects(
      client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90002" }), options),
      error => error instanceof JiraError && error.failure.kind === "unexpected_response",
    );

    selected = metadata("/jira/secure/attachment/90002", "text/plain", 128 * 1024 + 1);
    responseFactory = () => new Response("x", { headers: { "content-type": "text/plain", "content-length": "1" } });
    const requestsBeforeSizeCheck = contentRequests;
    await assert.rejects(
      client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90002" }), options),
      error => error instanceof JiraError && error.failure.kind === "response_too_large",
    );
    assert.equal(contentRequests, requestsBeforeSizeCheck);

    selected = metadata("/jira/secure/attachment/90002", "application/pdf", 1);
    const requestsBeforeMimeCheck = contentRequests;
    await assert.rejects(
      client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90002" }), options),
      error => error instanceof JiraError && error.failure.kind === "unsupported_value",
    );
    assert.equal(contentRequests, requestsBeforeMimeCheck);

    selected = metadata("/jira/secure/attachment/90002");
    responseFactory = () => new Response("xy", { headers: { "content-type": "text/plain", "content-length": "2" } });
    await assert.rejects(
      client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90002" }), options),
      error => error instanceof JiraError && error.failure.kind === "unexpected_response",
    );

    responseFactory = () => new Response(Uint8Array.from([0xff]), {
      headers: { "content-type": "text/plain", "content-length": "1" },
    });
    await assert.rejects(
      client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90002" }), options),
      error => error instanceof JiraError && error.failure.kind === "unexpected_response",
    );

    selected = { ...metadata("/jira/secure/attachment/90002", "image/png", 3), filename: "bad.png" };
    responseFactory = () => new Response(Uint8Array.from([1, 2, 3]), {
      headers: { "content-type": "image/png", "content-length": "3" },
    });
    await assert.rejects(
      client.readAttachment(inputSchemas.jira_read_attachment.parse({ issueKey: "SIMPL-42", attachmentId: "90002" }), options),
      error => error instanceof JiraError && error.failure.kind === "unexpected_response",
    );
  } finally {
    restore();
  }
});

test("HTTP errors stay distinct and never expose upstream bodies", async () => {
  const expected: Array<[number, string]> = [
    [400, "invalid_input"],
    [401, "unauthenticated"],
    [403, "forbidden"],
    [404, "not_found_or_hidden"],
    [429, "throttled"],
    [503, "unavailable"],
  ];
  for (const [status, kind] of expected) {
    let attempts = 0;
    const restore = replaceFetch(async () => {
      attempts += 1;
      return new Response(JSON.stringify({ errorMessages: ["private upstream detail"] }), {
        status,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    });
    try {
      await assert.rejects(
        jira().listProjects(projectsInput, options),
        error => error instanceof JiraError && error.failure.kind === kind && !error.message.includes("private upstream detail"),
      );
      assert.equal(attempts, status === 429 || status === 503 ? 3 : 1);
    } finally {
      restore();
    }
  }
});

test("a Retry-After longer than the aggregate budget is reported without an early retry", async () => {
  let attempts = 0;
  const restore = replaceFetch(async () => {
    attempts += 1;
    return new Response("", { status: 503, headers: { "retry-after": "6" } });
  });
  try {
    await assert.rejects(jira().listProjects(projectsInput, options), error =>
      error instanceof JiraError
      && error.failure.kind === "throttled"
      && error.failure.retryAfterMs === 6_000);
    assert.equal(attempts, 1);
  } finally {
    restore();
  }
});

test("the final transient response preserves a Retry-After that exceeds remaining budget", async () => {
  let attempts = 0;
  const restore = replaceFetch(async () => {
    attempts += 1;
    return new Response("", { status: 503, headers: { "retry-after": attempts < 3 ? "0" : "6" } });
  });
  try {
    await assert.rejects(jira().listProjects(projectsInput, options), error =>
      error instanceof JiraError
      && error.failure.kind === "throttled"
      && error.failure.retryAfterMs === 6_000);
    assert.equal(attempts, 3);
  } finally {
    restore();
  }
});

test("an empty page marked incomplete fails instead of returning a non-progressing offset", async () => {
  const restore = replaceFetch(async () => new Response(JSON.stringify({ startAt: 0, isLast: false, values: [] }), {
    headers: { "content-type": "application/json" },
  }));
  try {
    await assert.rejects(
      jira().listBoards(inputSchemas.jira_list_boards.parse({}), options),
      error => error instanceof JiraError && error.failure.kind === "unexpected_response",
    );
  } finally {
    restore();
  }
});

test("an empty total-count page fails instead of returning the same continuation offset", async () => {
  const restore = replaceFetch(async () => new Response(JSON.stringify({ startAt: 0, total: 1, issues: [] }), {
    headers: { "content-type": "application/json" },
  }));
  try {
    await assert.rejects(
      jira().searchIssues(inputSchemas.jira_search_issues.parse({ jql: "project = SIMPL" }), options),
      error => error instanceof JiraError && error.failure.kind === "unexpected_response",
    );
  } finally {
    restore();
  }
});

test("a request releases its concurrency slot during retry backoff", async () => {
  let calls = 0;
  let releaseGate!: () => void;
  let notifyFifthCall!: () => void;
  const gate = new Promise<void>(resolve => { releaseGate = resolve; });
  const fifthCall = new Promise<void>(resolve => { notifyFifthCall = resolve; });
  const client = jira();
  const restore = replaceFetch(async () => {
    calls += 1;
    if (calls === 1) return new Response("", { status: 503 });
    if (calls === 5) notifyFifthCall();
    await gate;
    return new Response("[]", { headers: { "content-type": "application/json" } });
  });
  const requests = Array.from({ length: 5 }, () => client.listProjects(projectsInput, options));
  try {
    const fifthStarted = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 120);
      void fifthCall.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.equal(fifthStarted, true);
  } finally {
    releaseGate();
    await Promise.allSettled(requests);
    restore();
  }
});

test("redirects, malformed JSON, and oversized Jira responses fail safely", async () => {
  const cases: Array<{ response: () => Response; expected: JiraFailureKind }> = [
    { response: () => new Response("", { status: 302, headers: { location: "https://other.example.com/" } }), expected: "unexpected_response" },
    { response: () => new Response("{", { headers: { "content-type": "application/json" } }), expected: "unexpected_response" },
    { response: () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "8388609" } }), expected: "response_too_large" },
  ];
  for (const entry of cases) {
    const restore = replaceFetch(async (_url, init) => {
      assert.equal(init.redirect, "manual");
      return entry.response();
    });
    try {
      await assert.rejects(jira().listProjects(projectsInput, options), error =>
        error instanceof JiraError && error.failure.kind === entry.expected);
    } finally {
      restore();
    }
  }
});

test("caller cancellation aborts the active Jira request", async () => {
  const restore = replaceFetch(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init.signal;
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const controller = new AbortController();
  try {
    const request = jira().listProjects(projectsInput, { signal: controller.signal });
    controller.abort();
    await assert.rejects(request, error => error instanceof DOMException && error.name === "AbortError");
  } finally {
    restore();
  }
});

type JiraFailureKind = JiraError["failure"]["kind"];
