import * as z from "zod/v4";
import {
  commentIdSchema,
  attachmentIdSchema,
  boardIdSchema,
  fieldIdSchema,
  inputSchemas,
  issueIdSchema,
  issueKeySchema,
  issueTypeIdSchema,
  outputSchemas,
  projectIdSchema,
  projectKeySchema,
  transitionIdSchema,
  updatedSchema,
  userNameSchema,
  type FieldId,
  type CommentId,
  type IssueKey,
  type JsonValue,
  type ProjectKey,
  type ToolInput,
  type ToolName,
  type ToolOutput,
  type Updated,
} from "./schemas.js";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_BYTES = 220 * 1024;
const MAX_FIELD_BYTES = 12 * 1024;
const MAX_ATTACHMENT_BYTES = 128 * 1024;
const COMMENT_SCAN_PAGE_SIZE = 100;
const MAX_COMMENT_SCAN_PAGES = 20;
const allowedAttachmentMimeTypes = new Set([
  "text/plain", "text/markdown", "application/json",
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_READ_RETRIES = 2;
const MAX_TOTAL_RETRY_DELAY_MS = 5_000;

const defaultIssueFields = [
  "summary", "project", "issuetype", "status", "assignee", "reporter", "priority", "labels", "created", "updated", "description",
] as const;
const accessPermissions = [
  "BROWSE_PROJECTS", "CREATE_ISSUES", "EDIT_ISSUES", "DELETE_ISSUES",
  "ASSIGN_ISSUES", "ASSIGNABLE_USER", "ADD_COMMENTS", "TRANSITION_ISSUES", "LINK_ISSUES",
  "PROJECT_VIEW_ALL_WORKLOGS", "CREATE_ATTACHMENTS",
] as const;

export type Config = {
  jiraUrl: URL;
  token: string;
  writesEnabled: boolean;
};
export type CallOptions = { signal: AbortSignal };
export type Permission = "allowed" | "denied" | "unknown";
export type PermissionScope =
  | { kind: "global" }
  | { kind: "project"; projectKey: ProjectKey }
  | { kind: "issue"; issueKey: IssueKey };
export type Provenance = { jiraUrl: string; observedAt: string };
export type PageEvidence =
  | { source: "total"; total: number }
  | { source: "isLast"; isLast: boolean; total?: number }
  | { source: "catalog"; total: number }
  | { source: "unknown" };
export type Page<T> = {
  items: T[];
  startAt: number;
  returnedCount: number;
  hasMore: true | false | "unknown";
  nextStartAt?: number;
  upstream: PageEvidence;
};
export type TextRead =
  | { tool: "jira_read_issue_field"; issueKey: IssueKey; fieldId: FieldId; expectedUpdated: Updated }
  | { tool: "jira_read_comment"; issueKey: IssueKey; commentId: CommentId; expectedUpdated: Updated };
export type ValueOmission = {
  path: string;
  reason: "result_limit";
  recovery: TextRead | { action: "select_fewer_fields" } | { action: "unavailable"; explanation: string };
};
export type ReadResult<T> = {
  data: T;
  provenance: Provenance;
  omissions: ValueOmission[];
};
export type JiraFailure =
  | { kind: "invalid_input"; message: string; fields?: FieldId[] }
  | { kind: "unauthenticated" | "forbidden" | "not_found_or_hidden"; message: string }
  | { kind: "throttled"; message: string; retryAfterMs?: number }
  | { kind: "timeout" | "unavailable" | "unexpected_response" | "response_too_large"; message: string }
  | {
    kind: "result_too_large";
    message: string;
    resource: { kind: "issue"; issueKey: IssueKey } | { kind: "catalog_item"; tool: ToolName; id: string; startAt: number };
    recovery?: { action: "select_fewer_fields" } | { action: "unavailable"; explanation: string };
  }
  | { kind: "source_changed" | "unsupported_value"; message: string };

export class JiraError extends Error {
  readonly failure: JiraFailure;

  constructor(failure: JiraFailure) {
    super(failure.message);
    this.name = "JiraError";
    this.failure = failure;
  }
}

type Waiter = {
  signal: AbortSignal;
  resolve: () => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
};

class Semaphore {
  readonly #limit: number;
  #active = 0;
  readonly #queue: Waiter[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    await this.#acquire(signal);
    try {
      return await action();
    } finally {
      this.#release();
    }
  }

  #acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        onAbort: () => {
          const index = this.#queue.indexOf(waiter);
          if (index !== -1) this.#queue.splice(index, 1);
          signal.removeEventListener("abort", waiter.onAbort);
          reject(abortReason(signal));
        },
      };
      this.#queue.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
    });
  }

  #release(): void {
    this.#active -= 1;
    while (this.#queue.length > 0) {
      const waiter = this.#queue.shift();
      if (waiter === undefined) return;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal.aborted) {
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      this.#active += 1;
      waiter.resolve();
      return;
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The MCP request was cancelled.", "AbortError");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw unexpected(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw unexpected(`${label} was not an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw unexpected(`${label} was missing`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw unexpected(`${label} was missing`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw unexpected(`${label} was missing`);
  return value;
}

function requiredId<T extends z.ZodType>(schema: T, value: unknown, label: string): z.output<T> {
  const direct = schema.safeParse(value);
  if (direct.success) return direct.data;
  const parsed = schema.safeParse(typeof value === "number" ? String(value) : value ?? "");
  if (!parsed.success) throw unexpected(`${label} was invalid`);
  return parsed.data;
}

function unexpected(detail: string): JiraError {
  return new JiraError({ kind: "unexpected_response", message: `Jira returned an unexpected response. (${detail})` });
}

function fromUpstream<T extends z.ZodType>(schema: T, value: unknown, label: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw unexpected(`${label} did not match the expected shape`);
  return result.data;
}

function jsonRecord(value: unknown, label: string): Record<string, JsonValue> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) throw unexpected(`${label} was not an object`);
  for (const item of Object.values(parsed.data)) {
    if (!isJsonValue(item)) throw unexpected(`${label} contained a non-JSON value`);
  }
  return parsed.data as Record<string, JsonValue>;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, item]) => [key, canonicalJsonValue(item)]));
}

function makeTextWindow(
  rawValue: unknown,
  updated: Updated,
  offset: number,
  length: number,
): { text: string; encoding: "plain" | "json"; offset: number; returnedCount: number; totalCodePoints: number; updated: Updated; complete: boolean; nextOffset?: number } {
  const isString = typeof rawValue === "string";
  const encoding = isString ? "plain" as const : "json" as const;
  const text = isString ? rawValue : JSON.stringify(canonicalJsonValue(rawValue));
  if (text === undefined) throw unexpected("recovery value was not JSON encodable");
  const codePoints = Array.from(text);
  const part = codePoints.slice(offset, offset + length).join("");
  const nextOffset = offset + Array.from(part).length;
  const complete = nextOffset >= codePoints.length;
  return {
    text: part,
    encoding,
    offset,
    returnedCount: Array.from(part).length,
    totalCodePoints: codePoints.length,
    updated,
    complete,
    ...(complete ? {} : { nextOffset }),
  };
}

function mappedUser(value: unknown): { displayName: string; name?: string; active?: boolean } | null {
  if (value === null || value === undefined) return null;
  const user = record(value, "user");
  const displayName = optionalString(user.displayName) ?? optionalString(user.name) ?? "Unknown user";
  const name = optionalString(user.name);
  const active = typeof user.active === "boolean" ? user.active : undefined;
  return {
    displayName,
    ...(name === undefined || !userNameSchema.safeParse(name).success ? {} : { name }),
    ...(active === undefined ? {} : { active }),
  };
}

function byteLength(value: unknown): number {
  const encoded = JSON.stringify(value);
  return Buffer.byteLength(encoded ?? "null", "utf8");
}

function pageFromArray<T>(items: T[], startAt: number, maxResults: number): Page<T> {
  const pageItems = items.slice(startAt, startAt + maxResults);
  const total = items.length;
  const hasMore = startAt + pageItems.length < total;
  return {
    items: pageItems,
    startAt,
    returnedCount: pageItems.length,
    hasMore,
    ...(hasMore ? { nextStartAt: startAt + pageItems.length } : {}),
    upstream: { source: "catalog", total },
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortByIdAndName<T extends { id: string; name: string }>(items: T[]): T[] {
  return items.sort((left, right) => compareText(left.id, right.id) || compareText(left.name, right.name));
}

function pageFromUpstream<T>(
  items: T[], startAt: number, total: number | undefined, isLast: boolean | undefined,
): Page<T> {
  const returnedCount = items.length;
  const evidence: PageEvidence = total !== undefined
    ? { source: "total", total }
    : isLast !== undefined
      ? { source: "isLast", isLast }
      : { source: "unknown" };
  const hasMore = total !== undefined
    ? startAt + returnedCount < total
    : isLast !== undefined
      ? !isLast
      : "unknown";
  if (hasMore === true && returnedCount === 0) {
    throw unexpected("Jira marked an empty page as incomplete");
  }
  return {
    items,
    startAt,
    returnedCount,
    hasMore,
    ...(hasMore === true ? { nextStartAt: startAt + returnedCount } : {}),
    upstream: evidence,
  };
}

function pageFromAgile<T>(
  items: T[], response: Record<string, unknown>, fallbackStartAt: number,
): Page<T> {
  const startAt = typeof response.startAt === "number" && Number.isInteger(response.startAt) && response.startAt >= 0
    ? response.startAt
    : fallbackStartAt;
  const total = typeof response.total === "number" && Number.isInteger(response.total) && response.total >= 0
    ? response.total
    : undefined;
  const isLast = typeof response.isLast === "boolean" ? response.isLast : undefined;
  if (isLast === undefined) return pageFromUpstream(items, startAt, total, undefined);
  if (!isLast && items.length === 0) throw unexpected("Jira marked an empty Agile page as incomplete");
  const hasMore = !isLast;
  return {
    items,
    startAt,
    returnedCount: items.length,
    hasMore,
    ...(hasMore ? { nextStartAt: startAt + items.length } : {}),
    upstream: { source: "isLast", isLast, ...(total === undefined ? {} : { total }) },
  };
}

function resizedPage<T>(page: Page<T>, count: number): Page<T> {
  const { nextStartAt: _previousNext, ...position } = page;
  const items = page.items.slice(0, count);
  const returnedCount = items.length;
  const trimmed = returnedCount < page.items.length;
  let hasMore: true | false | "unknown";
  if (page.upstream.source === "total" || page.upstream.source === "catalog") {
    hasMore = page.startAt + returnedCount < page.upstream.total;
  } else if (page.upstream.source === "isLast") {
    hasMore = trimmed || !page.upstream.isLast;
  } else {
    hasMore = trimmed ? true : page.hasMore;
  }
  return {
    ...position,
    items,
    returnedCount,
    hasMore,
    ...(hasMore === true ? { nextStartAt: page.startAt + returnedCount } : {}),
  };
}

function createReadResult<T>(data: T, jiraUrl: string, omissions: ValueOmission[] = []): ReadResult<T> {
  return {
    data,
    provenance: { jiraUrl, observedAt: new Date().toISOString() },
    omissions,
  };
}

function catalogItemId(value: unknown): string {
  const item = record(value, "catalog item");
  for (const key of ["id", "key", "name"]) {
    const candidate = item[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  throw new JiraError({ kind: "unexpected_response", message: "A large Jira item did not include a usable identifier." });
}

function fitPageResult<T>(result: ReadResult<Page<T>>, tool: ToolName): ReadResult<Page<T>> {
  let page = result.data;
  while (byteLength({ ...result, data: page }) > MAX_TOOL_BYTES) {
    if (page.items.length === 0) {
      throw new JiraError({
        kind: "response_too_large",
        message: "The Jira result exceeds the MCP response limit. Select fewer fields or a smaller page.",
      });
    }
    if (page.items.length === 1) {
      throw new JiraError({
        kind: "result_too_large",
        message: "A Jira catalog item cannot fit within the MCP response limit. Request a smaller item or inspect it with a dedicated read tool.",
        resource: { kind: "catalog_item", tool, id: catalogItemId(page.items[0]), startAt: page.startAt },
      });
    }
    const keptCount = page.items.length - 1;
    page = resizedPage(page, page.items.length - 1);
    result = {
      ...result,
      omissions: result.omissions.filter(omission => {
        const index = /^data\.items\[(\d+)\]/.exec(omission.path)?.[1];
        return index === undefined || Number(index) < keptCount;
      }),
    };
  }
  return { ...result, data: page };
}

function fitNestedPageResult<TItem, T extends { page: Page<TItem> }>(result: ReadResult<T>, tool: ToolName): ReadResult<T> {
  let current = result;
  while (byteLength(current) > MAX_TOOL_BYTES) {
    const page = current.data.page;
    if (page.items.length === 0) {
      throw new JiraError({ kind: "response_too_large", message: "The Jira metadata exceeds the MCP response limit. Request a smaller page." });
    }
    if (page.items.length === 1) {
      throw new JiraError({
        kind: "result_too_large",
        message: "A Jira metadata item cannot fit within the MCP response limit. Request a smaller page or a narrower metadata selection.",
        resource: { kind: "catalog_item", tool, id: catalogItemId(page.items[0]), startAt: page.startAt },
      });
    }
    current = { ...current, data: { ...current.data, page: resizedPage(page, page.items.length - 1) } };
  }
  return current;
}

function asNamedValue(value: unknown, label: string): { id: string; name: string } {
  const item = record(value, label);
  return { id: requiredString(String(item.id ?? ""), `${label}.id`), name: requiredString(item.name, `${label}.name`) };
}

function fieldSelection(requested: FieldId[] | undefined): { jiraFields: string[]; visibleFields: Set<string> } {
  const visible: string[] = requested === undefined ? [...defaultIssueFields] : [...requested];
  const jiraFields = [...new Set([...visible, "updated", "issuelinks"])];
  return { jiraFields, visibleFields: new Set(visible) };
}

function readIssueFields(
  rawFields: Record<string, unknown>,
  visible: Set<string>,
  issueKey: IssueKey,
  updated: Updated,
  pathPrefix: string,
  omissions: ValueOmission[],
): Record<FieldId, unknown> {
  const fields: Record<FieldId, unknown> = {};
  for (const [rawId, value] of Object.entries(rawFields)) {
    if (!visible.has(rawId)) continue;
    const parsedId = fieldIdSchema.safeParse(rawId);
    if (!parsedId.success) continue;
    if (byteLength(value) > MAX_FIELD_BYTES) {
      omissions.push({
        path: `${pathPrefix}.fields.${rawId}`,
        reason: "result_limit",
        recovery: { tool: "jira_read_issue_field", issueKey, fieldId: parsedId.data, expectedUpdated: updated },
      });
      continue;
    }
    fields[parsedId.data] = value;
  }
  return fields;
}

function issueSummary(
  raw: unknown,
  baseUrl: URL,
  visible: Set<string>,
  path: string,
  omissions: ValueOmission[],
): ToolOutput<"jira_search_issues">["data"]["items"][number] {
  const issue = record(raw, "issue");
  const fields = record(issue.fields, "issue.fields");
  const key = requiredId(issueKeySchema, issue.key, "issue.key");
  const updated = requiredId(updatedSchema, fields.updated, "issue.fields.updated");
  const id = requiredId(issueIdSchema, issue.id, "issue.id");
  const browseUrl = new URL(`browse/${key}`, baseUrl).toString();
  return {
    id,
    key,
    browseUrl,
    updated,
    fields: readIssueFields(fields, visible, key, updated, path, omissions),
  };
}

function fitIssueResult<T extends { fields: Record<string, unknown>; key: IssueKey; updated: Updated }>(
  result: ReadResult<T>,
): ReadResult<T> {
  let data = result.data;
  while (byteLength({ ...result, data }) > MAX_TOOL_BYTES) {
    const candidates = Object.entries(data.fields)
      .map(([fieldId, value]) => ({ fieldId, size: byteLength(value) }))
      .sort((left, right) => right.size - left.size);
    const candidate = candidates[0];
    if (candidate === undefined) {
      throw new JiraError({
        kind: "response_too_large",
        message: "The Jira issue exceeds the MCP response limit. Select fewer fields.",
      });
    }
    const fields = { ...data.fields };
    delete fields[candidate.fieldId];
    const parsedId = fieldIdSchema.safeParse(candidate.fieldId);
    const omission: ValueOmission = {
      path: `data.fields.${candidate.fieldId}`,
      reason: "result_limit",
      recovery: parsedId.success
        ? { tool: "jira_read_issue_field", issueKey: data.key, fieldId: parsedId.data, expectedUpdated: data.updated }
        : { action: "select_fewer_fields" },
    };
    data = { ...data, fields };
    result = { ...result, omissions: [...result.omissions, omission] };
  }
  return { ...result, data };
}

function mapFieldMetadata(value: unknown): {
  id: FieldId; name: string; required: boolean | "unknown"; schema: Record<string, JsonValue> | null;
  operations: string[] | "unknown"; allowedValues: unknown[] | "unknown"; defaultValue?: unknown;
} {
  const field = record(value, "field metadata");
  const id = requiredId(fieldIdSchema, field.fieldId ?? field.id, "field metadata.id");
  const schema = field.schema === null || field.schema === undefined ? null : jsonRecord(field.schema, "field metadata.schema");
  const required = field.required === undefined || field.required === null
    ? "unknown"
    : requiredBoolean(field.required, "field metadata.required");
  const operations = field.operations === undefined || field.operations === null
    ? "unknown"
    : array(field.operations, "field metadata.operations").map(item => requiredString(item, "field operation"));
  const allowedValues = field.allowedValues === undefined || field.allowedValues === null
    ? "unknown"
    : array(field.allowedValues, "field metadata.allowedValues");
  return {
    id,
    name: optionalString(field.name) ?? id,
    required,
    schema,
    operations,
    allowedValues,
    ...(Object.hasOwn(field, "defaultValue") ? { defaultValue: field.defaultValue } : {}),
  };
}

function mapBoard(value: unknown): { id: z.output<typeof boardIdSchema>; name: string; type: "scrum" | "kanban" } {
  const board = record(value, "board");
  const type = optionalString(board.type)?.toLocaleLowerCase();
  if (type !== "scrum" && type !== "kanban") throw unexpected("board.type was not scrum or kanban");
  return {
    id: requiredId(boardIdSchema, board.id, "board.id"),
    name: requiredString(board.name, "board.name"),
    type,
  };
}

export class JiraClient {
  readonly #baseUrl: URL;
  readonly #apiRoot: URL;
  readonly #agileRoot: URL;
  readonly #token: string;
  readonly #semaphore = new Semaphore(MAX_CONCURRENT_REQUESTS);

  constructor(config: Config) {
    this.#baseUrl = new URL(config.jiraUrl);
    if (!this.#baseUrl.pathname.endsWith("/")) this.#baseUrl.pathname += "/";
    this.#apiRoot = new URL(`${this.#baseUrl.pathname.replace(/\/+$/, "")}/rest/api/2/`, this.#baseUrl.origin);
    this.#agileRoot = new URL(`${this.#baseUrl.pathname.replace(/\/+$/, "")}/rest/agile/1.0/`, this.#baseUrl.origin);
    this.#token = config.token;
  }

  async getAccess(input: ToolInput<"jira_get_access">, options: CallOptions): Promise<ToolOutput<"jira_get_access">> {
    const scope: PermissionScope = input.issueKey !== undefined
      ? { kind: "issue", issueKey: input.issueKey }
      : input.projectKey !== undefined
        ? { kind: "project", projectKey: input.projectKey }
        : { kind: "global" };
    const permissionsParams = new URLSearchParams({ permissions: accessPermissions.join(",") });
    if (input.issueKey !== undefined) permissionsParams.set("issueKey", input.issueKey);
    if (input.projectKey !== undefined) permissionsParams.set("projectKey", input.projectKey);
    const [myselfRaw, serverRaw, permissionsRaw] = await Promise.all([
      this.#getJson("myself", options.signal),
      this.#getJson("serverInfo", options.signal),
      this.#getJson(`mypermissions?${permissionsParams}`, options.signal),
    ]);
    const myself = record(myselfRaw, "myself");
    const serverInfo = record(serverRaw, "serverInfo");
    const userName = optionalString(myself.name);
    const active = typeof myself.active === "boolean" ? myself.active : undefined;
    const user = {
      displayName: optionalString(myself.displayName) ?? userName ?? "Unknown user",
      ...(userName === undefined || !userNameSchema.safeParse(userName).success ? {} : { name: userName }),
      ...(active === undefined ? {} : { active }),
    };
    const permissionResponse = record(permissionsRaw, "permissions");
    const rawPermissions = record(permissionResponse.permissions, "permissions.permissions");
    const permissions: Record<string, Permission> = {};
    for (const permissionName of accessPermissions) {
      const permission = rawPermissions[permissionName];
      if (permission === undefined) {
        permissions[permissionName] = "unknown";
      } else {
        const havePermission = record(permission, "permission").havePermission;
        permissions[permissionName] = typeof havePermission === "boolean"
          ? havePermission ? "allowed" : "denied"
          : "unknown";
      }
    }
    const result = createReadResult({
      user,
      serverVersion: requiredString(serverInfo.version, "serverInfo.version"),
      scope,
      permissions,
    }, this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_get_access, result, "access result");
  }

  async listProjects(input: ToolInput<"jira_list_projects">, options: CallOptions): Promise<ToolOutput<"jira_list_projects">> {
    const raw = array(await this.#getJson("project", options.signal), "project catalog");
    let projects = raw.map((value, index) => {
      const item = record(value, `project[${index}]`);
      return {
        id: requiredId(projectIdSchema, item.id, "project.id"),
        key: requiredId(projectKeySchema, item.key, "project.key"),
        name: requiredString(item.name, "project.name"),
        type: optionalString(item.projectTypeKey) ?? "unknown",
      };
    });
    if (input.projectKey !== undefined) projects = projects.filter(project => project.key === input.projectKey);
    projects.sort((left, right) => compareText(left.key, right.key) || compareText(left.name, right.name));
    const result = createReadResult(pageFromArray(projects, input.startAt, input.maxResults), this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_list_projects, fitPageResult(result, "jira_list_projects"), "project page");
  }

  async getProject(input: ToolInput<"jira_get_project">, options: CallOptions): Promise<ToolOutput<"jira_get_project">> {
    const [projectRaw, componentsRaw, versionsRaw] = await Promise.all([
      this.#getJson(`project/${encodeURIComponent(input.projectKey)}`, options.signal),
      input.collections.includes("components")
        ? this.#getJson(`project/${encodeURIComponent(input.projectKey)}/components`, options.signal)
        : Promise.resolve(undefined),
      input.collections.includes("versions")
        ? this.#getJson(`project/${encodeURIComponent(input.projectKey)}/versions`, options.signal)
        : Promise.resolve(undefined),
    ]);
    const project = record(projectRaw, "project");
    const collections: Record<string, Page<{ id: string; name: string }>> = {};
    const issueTypesRaw = input.collections.includes("issueTypes") ? array(project.issueTypes, "project.issueTypes") : undefined;
    const components = componentsRaw === undefined ? undefined : array(componentsRaw, "project components");
    const versions = versionsRaw === undefined ? undefined : array(versionsRaw, "project versions");
    const values: Partial<Record<"issueTypes" | "components" | "versions", unknown[]>> = {
      ...(issueTypesRaw === undefined ? {} : { issueTypes: issueTypesRaw }),
      ...(components === undefined ? {} : { components }),
      ...(versions === undefined ? {} : { versions }),
    };
    for (const [name, items] of Object.entries(values)) {
      if (items === undefined) continue;
      const mapped = sortByIdAndName(items.map(value => asNamedValue(value, `project ${name} item`)));
      collections[name] = pageFromArray(mapped, input.startAt, input.maxResults);
    }
    const output = {
      id: requiredId(projectIdSchema, project.id, "project.id"),
      key: requiredId(projectKeySchema, project.key, "project.key"),
      name: requiredString(project.name, "project.name"),
      type: optionalString(project.projectTypeKey) ?? "unknown",
      description: optionalString(project.description) ?? null,
      collections,
    };
    const result = createReadResult(output, this.#baseUrl.toString());
    if (byteLength(result) > MAX_TOOL_BYTES) {
      throw new JiraError({ kind: "response_too_large", message: "The project metadata exceeds the MCP response limit. Request fewer collections or a smaller page." });
    }
    return fromUpstream(outputSchemas.jira_get_project, result, "project result");
  }

  async listFields(input: ToolInput<"jira_list_fields">, options: CallOptions): Promise<ToolOutput<"jira_list_fields">> {
    const raw = array(await this.#getJson("field", options.signal), "field catalog");
    const filter = input.filter?.toLocaleLowerCase();
    let fields = raw.map(value => {
      const field = record(value, "field");
      const schema = field.schema === undefined || field.schema === null ? null : jsonRecord(field.schema, "field.schema");
      return {
        id: requiredId(fieldIdSchema, field.id, "field.id"),
        name: requiredString(field.name, "field.name"),
        custom: requiredBoolean(field.custom, "field.custom"),
        schema,
      };
    });
    if (input.customOnly) fields = fields.filter(field => field.custom);
    if (filter !== undefined) fields = fields.filter(field =>
      field.id.toLocaleLowerCase().includes(filter) || field.name.toLocaleLowerCase().includes(filter));
    fields.sort((left, right) => compareText(left.id, right.id) || compareText(left.name, right.name));
    const result = createReadResult(pageFromArray(fields, input.startAt, input.maxResults), this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_list_fields, fitPageResult(result, "jira_list_fields"), "field page");
  }

  async searchIssues(input: ToolInput<"jira_search_issues">, options: CallOptions): Promise<ToolOutput<"jira_search_issues">> {
    const selection = fieldSelection(input.fields);
    const params = new URLSearchParams({
      jql: input.jql,
      startAt: String(input.startAt),
      maxResults: String(input.maxResults),
      fields: selection.jiraFields.join(","),
    });
    const response = record(await this.#getJson(`search?${params}`, options.signal), "search response");
    const rawIssues = array(response.issues, "search.issues");
    const omissions: ValueOmission[] = [];
    const issues = rawIssues.map((value, index) => issueSummary(
      value, this.#baseUrl, selection.visibleFields, `data.items[${index}]`, omissions,
    ));
    const total = typeof response.total === "number" ? response.total : undefined;
    const result = createReadResult(
      pageFromUpstream(issues, input.startAt, total, undefined),
      this.#baseUrl.toString(),
      omissions,
    );
    return fromUpstream(outputSchemas.jira_search_issues, fitPageResult(result, "jira_search_issues"), "issue search page");
  }

  async getIssue(input: ToolInput<"jira_get_issue">, options: CallOptions): Promise<ToolOutput<"jira_get_issue">> {
    const selection = fieldSelection(input.fields);
    const params = new URLSearchParams({
      fields: selection.jiraFields.join(","),
      expand: input.includeChangelog ? "names,schema,changelog" : "names,schema",
    });
    const raw = record(await this.#getJson(`issue/${encodeURIComponent(input.issueKey)}?${params}`, options.signal), "issue response");
    const rawFields = record(raw.fields, "issue.fields");
    const issueKey = requiredId(issueKeySchema, raw.key, "issue.key");
    const updated = requiredId(updatedSchema, rawFields.updated, "issue.fields.updated");
    const omissions: ValueOmission[] = [];
    const summary = issueSummary(raw, this.#baseUrl, selection.visibleFields, "data", omissions);
    const links = mapIssueLinks(rawFields.issuelinks);
    const names = mapFieldMap(raw.names, value => requiredString(value, "field name"));
    const schemas = mapFieldMap(raw.schema, value => jsonRecord(value, "field schema"));
    const changelog = input.includeChangelog
      ? mapChangelog(raw.changelog)
      : { requested: false as const };
    let result = createReadResult({ ...summary, names, schemas, links, changelog }, this.#baseUrl.toString(), omissions);
    result = fitIssueResult(result);
    return fromUpstream(outputSchemas.jira_get_issue, result, "issue detail");
  }

  async listComments(input: ToolInput<"jira_list_comments">, options: CallOptions): Promise<ToolOutput<"jira_list_comments">> {
    const params = new URLSearchParams({ startAt: String(input.startAt), maxResults: String(input.maxResults) });
    const response = record(await this.#getJson(`issue/${encodeURIComponent(input.issueKey)}/comment?${params}`, options.signal), "comment page");
    const rawComments = array(response.comments, "comments");
    const omissions: ValueOmission[] = [];
    const comments = rawComments.map((value, index) => {
      const comment = record(value, "comment");
      const commentId = requiredId(commentIdSchema, comment.id, "comment.id");
      const updated = requiredId(updatedSchema, comment.updated ?? comment.created, "comment.updated");
      const body = comment.body === null ? null : optionalString(comment.body);
      let returnedBody: string | null | undefined = body;
      if (body !== undefined && byteLength(body) > MAX_FIELD_BYTES) {
        returnedBody = undefined;
        omissions.push({
          path: `data.items[${index}].body`,
          reason: "result_limit",
          recovery: { tool: "jira_read_comment", issueKey: input.issueKey, commentId, expectedUpdated: updated },
        });
      }
      return {
        id: commentId,
        issueKey: input.issueKey,
        ...(returnedBody === undefined ? {} : { body: returnedBody }),
        author: mappedUser(comment.author),
        created: requiredString(comment.created, "comment.created"),
        updated,
      };
    });
    const total = typeof response.total === "number" ? response.total : undefined;
    const upstreamStartAt = typeof response.startAt === "number" ? response.startAt : input.startAt;
    const result = createReadResult(
      pageFromUpstream(comments, upstreamStartAt, total, undefined),
      this.#baseUrl.toString(),
      omissions,
    );
    return fromUpstream(outputSchemas.jira_list_comments, fitPageResult(result, "jira_list_comments"), "comment page");
  }

  async readComment(input: ToolInput<"jira_read_comment">, options: CallOptions): Promise<ToolOutput<"jira_read_comment">> {
    let startAt = 0;
    let expectedTotal: number | undefined;

    for (let pageIndex = 0; pageIndex < MAX_COMMENT_SCAN_PAGES; pageIndex += 1) {
      const params = new URLSearchParams({ startAt: String(startAt), maxResults: String(COMMENT_SCAN_PAGE_SIZE) });
      const response = record(
        await this.#getJson(`issue/${encodeURIComponent(input.issueKey)}/comment?${params}`, options.signal),
        "comment recovery page",
      );
      const rawComments = array(response.comments, "comment recovery comments");
      const responseStartAt = typeof response.startAt === "number" && Number.isSafeInteger(response.startAt) && response.startAt >= 0
        ? response.startAt
        : startAt;
      const total = typeof response.total === "number" && Number.isSafeInteger(response.total) && response.total >= 0
        ? response.total
        : undefined;
      if (responseStartAt !== startAt) throw unexpected("comment recovery page did not match its requested offset");

      for (const value of rawComments) {
        const comment = record(value, "comment recovery item");
        if (requiredId(commentIdSchema, comment.id, "comment.id") !== input.commentId) continue;
        const updated = requiredId(updatedSchema, comment.updated ?? comment.created, "comment.updated");
        if (input.expectedUpdated !== undefined && updated !== input.expectedUpdated) {
          throw new JiraError({ kind: "source_changed", message: "The comment changed between text windows. Restart the read at offset zero." });
        }
        if (!Object.hasOwn(comment, "body")) throw unexpected("Jira did not return the requested comment body");
        const rawBody = comment.body === null ? null : optionalString(comment.body);
        if (rawBody === undefined) throw unexpected("Jira returned a comment body in an unsupported format");
        const result = createReadResult(
          makeTextWindow(rawBody, updated, input.offset, input.length),
          this.#baseUrl.toString(),
        );
        if (byteLength(result) > MAX_TOOL_BYTES) {
          throw new JiraError({ kind: "response_too_large", message: "The requested comment window exceeds the MCP response limit. Request a shorter window." });
        }
        return fromUpstream(outputSchemas.jira_read_comment, result, "comment window");
      }

      if (total === undefined) {
        throw new JiraError({ kind: "unavailable", message: "Jira did not provide a total, so comment recovery cannot prove the scan is complete." });
      }
      if (expectedTotal !== undefined && expectedTotal !== total) {
        throw new JiraError({ kind: "unavailable", message: "The comment list changed during recovery, so the bounded scan could not prove completeness." });
      }
      expectedTotal = total;

      if (startAt + rawComments.length >= total) {
        throw new JiraError({ kind: "not_found_or_hidden", message: "The comment was not found on this issue or is hidden from this user." });
      }
      if (rawComments.length === 0) throw unexpected("Jira returned an empty comment page before the reported total");
      startAt += rawComments.length;
    }

    throw new JiraError({ kind: "unavailable", message: `Comment recovery stopped after ${COMMENT_SCAN_PAGE_SIZE * MAX_COMMENT_SCAN_PAGES} comments without proving the requested comment was absent.` });
  }

  async listRemoteLinks(input: ToolInput<"jira_list_remote_links">, options: CallOptions): Promise<ToolOutput<"jira_list_remote_links">> {
    const raw = array(await this.#getJson(`issue/${encodeURIComponent(input.issueKey)}/remotelink`, options.signal), "remote links");
    const links = raw.map(value => {
      const link = record(value, "remote link");
      const object = record(link.object, "remote link object");
      const url = requiredString(object.url, "remote link URL");
      if (!isHttpUrl(url)) throw unexpected("remote link URL was invalid");
      return {
        id: requiredString(String(link.id ?? ""), "remote link id"),
        title: optionalString(object.title) ?? url,
        url,
      };
    }).sort((left, right) => compareText(left.id, right.id) || compareText(left.title, right.title));
    const result = createReadResult(pageFromArray(links, input.startAt, input.maxResults), this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_list_remote_links, fitPageResult(result, "jira_list_remote_links"), "remote link page");
  }

  async listTransitions(input: ToolInput<"jira_list_transitions">, options: CallOptions): Promise<ToolOutput<"jira_list_transitions">> {
    const params = new URLSearchParams({ expand: "transitions.fields" });
    const response = record(await this.#getJson(`issue/${encodeURIComponent(input.issueKey)}/transitions?${params}`, options.signal), "transitions response");
    const rawTransitions = array(response.transitions, "transitions");
    const transitions = rawTransitions.map(value => {
      const transition = record(value, "transition");
      const target = asNamedValue(transition.to, "transition target");
      const fields = transition.fields === undefined || transition.fields === null
        ? []
        : Object.entries(record(transition.fields, "transition fields")).map(([id, field]) => {
          const mapped = mapFieldMetadata({ ...record(field, "transition field"), fieldId: id });
          return mapped;
        }).sort((left, right) => compareText(left.id, right.id));
      return {
        id: requiredId(transitionIdSchema, transition.id, "transition.id"),
        name: requiredString(transition.name, "transition.name"),
        targetStatus: target,
        fields,
      };
    }).sort((left, right) => compareText(left.id, right.id) || compareText(left.name, right.name));
    const result = createReadResult(pageFromArray(transitions, input.startAt, input.maxResults), this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_list_transitions, fitPageResult(result, "jira_list_transitions"), "transition page");
  }

  async readIssueField(input: ToolInput<"jira_read_issue_field">, options: CallOptions): Promise<ToolOutput<"jira_read_issue_field">> {
    const params = new URLSearchParams({ fields: `updated,${input.fieldId}` });
    const response = record(await this.#getJson(`issue/${encodeURIComponent(input.issueKey)}?${params}`, options.signal), "issue field response");
    const fields = record(response.fields, "issue field data");
    const updated = requiredId(updatedSchema, fields.updated, "issue updated");
    if (input.expectedUpdated !== undefined && updated !== input.expectedUpdated) {
      throw new JiraError({ kind: "source_changed", message: "The issue changed between text windows. Restart the read at offset zero." });
    }
    if (!Object.hasOwn(fields, input.fieldId)) {
      throw new JiraError({ kind: "invalid_input", message: "Jira did not return the requested field for this issue." });
    }
    const rawValue = fields[input.fieldId];
    const result = createReadResult(makeTextWindow(rawValue, updated, input.offset, input.length), this.#baseUrl.toString());
    if (byteLength(result) > MAX_TOOL_BYTES) throw new JiraError({ kind: "response_too_large", message: "The requested text window exceeds the MCP response limit. Request a shorter window." });
    return fromUpstream(outputSchemas.jira_read_issue_field, result, "issue field window");
  }

  async listBoards(input: ToolInput<"jira_list_boards">, options: CallOptions): Promise<ToolOutput<"jira_list_boards">> {
    const params = new URLSearchParams({ startAt: String(input.startAt), maxResults: String(input.maxResults) });
    if (input.name !== undefined) params.set("name", input.name);
    if (input.type !== undefined) params.set("type", input.type);
    const response = record(await this.#getJson(`board?${params}`, options.signal, this.#agileRoot), "board page");
    const boards = array(response.values, "boards").map(mapBoard);
    const result = createReadResult(pageFromAgile(boards, response, input.startAt), this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_list_boards, fitPageResult(result, "jira_list_boards"), "board page");
  }

  async getBoard(input: ToolInput<"jira_get_board">, options: CallOptions): Promise<ToolOutput<"jira_get_board">> {
    const raw = record(await this.#getJson(`board/${input.boardId}/configuration`, options.signal, this.#agileRoot), "board configuration");
    const { id: _id, name: _name, type: _type, ...configurationRaw } = raw;
    const data = { ...mapBoard(raw), configuration: jsonRecord(configurationRaw, "board configuration") };
    const result = createReadResult(data, this.#baseUrl.toString());
    if (byteLength(result) > MAX_TOOL_BYTES) {
      throw new JiraError({ kind: "response_too_large", message: "The board configuration exceeds the MCP response limit." });
    }
    return fromUpstream(outputSchemas.jira_get_board, result, "board detail");
  }

  async listBoardIssues(input: ToolInput<"jira_list_board_issues">, options: CallOptions): Promise<ToolOutput<"jira_list_board_issues">> {
    const selection = fieldSelection(input.fields);
    const params = new URLSearchParams({
      startAt: String(input.startAt),
      maxResults: String(input.maxResults),
      fields: selection.jiraFields.join(","),
    });
    const response = record(await this.#getJson(`board/${input.boardId}/issue?${params}`, options.signal, this.#agileRoot), "board issue page");
    const omissions: ValueOmission[] = [];
    const issues = array(response.issues, "board issues").map((value, index) =>
      issueSummary(value, this.#baseUrl, selection.visibleFields, `data.items[${index}]`, omissions));
    const result = createReadResult(pageFromAgile(issues, response, input.startAt), this.#baseUrl.toString(), omissions);
    return fromUpstream(outputSchemas.jira_list_board_issues, fitPageResult(result, "jira_list_board_issues"), "board issue page");
  }

  async listSprints(input: ToolInput<"jira_list_sprints">, options: CallOptions): Promise<ToolOutput<"jira_list_sprints">> {
    const boardRaw = record(await this.#getJson(`board/${input.boardId}/configuration`, options.signal, this.#agileRoot), "board configuration");
    if (mapBoard(boardRaw).type !== "scrum") {
      throw new JiraError({ kind: "unsupported_value", message: "This Kanban board does not support sprint reads." });
    }
    const params = new URLSearchParams({ startAt: String(input.startAt), maxResults: String(input.maxResults) });
    if (input.state !== undefined) params.set("state", input.state.join(","));
    const response = record(await this.#getJson(`board/${input.boardId}/sprint?${params}`, options.signal, this.#agileRoot), "sprint page");
    const sprints = array(response.values, "sprints").map(value => {
      const sprint = record(value, "sprint");
      const rawState = optionalString(sprint.state)?.toLocaleLowerCase();
      if (rawState !== "active" && rawState !== "future" && rawState !== "closed") throw unexpected("sprint.state was invalid");
      const id = requiredNumber(sprint.id, "sprint.id");
      if (!Number.isInteger(id) || id <= 0) throw unexpected("sprint.id was invalid");
      const startDate = optionalString(sprint.startDate);
      const endDate = optionalString(sprint.endDate);
      const completeDate = optionalString(sprint.completeDate);
      const goal = optionalString(sprint.goal);
      return {
        id,
        name: requiredString(sprint.name, "sprint.name"),
        state: rawState,
        ...(startDate === undefined ? {} : { startDate }),
        ...(endDate === undefined ? {} : { endDate }),
        ...(completeDate === undefined ? {} : { completeDate }),
        ...(goal === undefined ? {} : { goal }),
      };
    });
    const result = createReadResult(pageFromAgile(sprints, response, input.startAt), this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_list_sprints, fitPageResult(result, "jira_list_sprints"), "sprint page");
  }

  async getCreateMetadata(input: ToolInput<"jira_get_create_metadata">, options: CallOptions): Promise<ToolOutput<"jira_get_create_metadata">> {
    const params = new URLSearchParams({ startAt: String(input.startAt), maxResults: String(input.maxResults) });
    const projectKey = encodeURIComponent(input.projectKey);
    const path = input.issueTypeId === undefined
      ? `issue/createmeta/${projectKey}/issuetypes?${params}`
      : `issue/createmeta/${projectKey}/issuetypes/${encodeURIComponent(input.issueTypeId)}?${params}`;
    const response = record(await this.#getJson(path, options.signal), "create metadata page");
    const rawValues = array(response.values, "create metadata values");
    const startAt = typeof response.startAt === "number" ? response.startAt : input.startAt;
    const total = typeof response.total === "number" ? response.total : undefined;
    const data = input.issueTypeId === undefined
      ? {
        kind: "issueTypes" as const,
        projectKey: input.projectKey,
        page: pageFromUpstream(rawValues.map(value => {
          const issueType = record(value, "creatable issue type");
          return {
            id: requiredId(issueTypeIdSchema, issueType.id, "issue type id"),
            name: requiredString(issueType.name, "issue type name"),
          };
        }), startAt, total, undefined),
      }
      : {
        kind: "fields" as const,
        projectKey: input.projectKey,
        issueTypeId: input.issueTypeId,
        page: pageFromUpstream(rawValues.map(mapFieldMetadata), startAt, total, undefined),
      };
    const result = createReadResult(data, this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_get_create_metadata, fitNestedPageResult(result, "jira_get_create_metadata"), "create metadata");
  }

  async getEditMetadata(input: ToolInput<"jira_get_edit_metadata">, options: CallOptions): Promise<ToolOutput<"jira_get_edit_metadata">> {
    const response = record(await this.#getJson(`issue/${encodeURIComponent(input.issueKey)}/editmeta`, options.signal), "edit metadata");
    const fields = Object.entries(record(response.fields, "editable fields"))
      .map(([id, value]) => mapFieldMetadata({ ...record(value, "editable field"), fieldId: id }))
      .sort((left, right) => compareText(left.id, right.id));
    const result = createReadResult({ issueKey: input.issueKey, page: pageFromArray(fields, input.startAt, input.maxResults) }, this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_get_edit_metadata, fitNestedPageResult(result, "jira_get_edit_metadata"), "edit metadata");
  }

  async findAssignableUsers(input: ToolInput<"jira_find_assignable_users">, options: CallOptions): Promise<ToolOutput<"jira_find_assignable_users">> {
    const params = new URLSearchParams({
      project: input.projectKey,
      username: input.query,
      startAt: String(input.startAt),
      maxResults: String(input.maxResults),
    });
    if (input.issueKey !== undefined) params.set("issueKey", input.issueKey);
    const response = array(await this.#getJson(`user/assignable/search?${params}`, options.signal), "assignable users");
    const users = response.map(value => {
      const user = record(value, "assignable user");
      const name = requiredId(userNameSchema, user.name ?? user.key, "assignable user name");
      return {
        name,
        displayName: optionalString(user.displayName) ?? name,
        active: requiredBoolean(user.active, "assignable user active"),
      };
    });
    const result = createReadResult(pageFromUpstream(users, input.startAt, undefined, undefined), this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_find_assignable_users, fitPageResult(result, "jira_find_assignable_users"), "assignable user page");
  }

  async listWorklogs(input: ToolInput<"jira_list_worklogs">, options: CallOptions): Promise<ToolOutput<"jira_list_worklogs">> {
    const params = new URLSearchParams({ startAt: String(input.startAt), maxResults: String(input.maxResults) });
    const response = record(await this.#getJson(`issue/${encodeURIComponent(input.issueKey)}/worklog?${params}`, options.signal), "worklog page");
    const worklogs = array(response.worklogs, "worklogs").map(value => {
      const worklog = record(value, "worklog");
      const comment = worklog.comment;
      return {
        id: requiredString(String(worklog.id ?? ""), "worklog id"),
        author: mappedUser(worklog.author),
        started: requiredString(worklog.started, "worklog started"),
        timeSpentSeconds: requiredNumber(worklog.timeSpentSeconds, "worklog time spent"),
        comment: comment === null || comment === undefined ? null : requiredString(comment, "worklog comment"),
      };
    });
    const total = typeof response.total === "number" ? response.total : undefined;
    const actualStartAt = typeof response.startAt === "number" ? response.startAt : input.startAt;
    const result = createReadResult(pageFromUpstream(worklogs, actualStartAt, total, undefined), this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_list_worklogs, fitPageResult(result, "jira_list_worklogs"), "worklog page");
  }

  async listFavouriteFilters(input: ToolInput<"jira_list_favourite_filters">, options: CallOptions): Promise<ToolOutput<"jira_list_favourite_filters">> {
    const raw = array(await this.#getJson("filter/favourite", options.signal), "favourite filters");
    const filters = raw.map(value => {
      const filter = record(value, "favourite filter");
      const id = requiredString(String(filter.id ?? ""), "filter id");
      const browseUrl = new URL("secure/IssueNavigator.jspa", this.#baseUrl);
      browseUrl.searchParams.set("requestId", id);
      return {
        id,
        name: requiredString(filter.name, "filter name"),
        jql: requiredString(filter.jql, "filter JQL"),
        browseUrl: browseUrl.toString(),
      };
    }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    const result = createReadResult(pageFromArray(filters, input.startAt, input.maxResults), this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_list_favourite_filters, fitPageResult(result, "jira_list_favourite_filters"), "favourite filter page");
  }

  async listDashboards(input: ToolInput<"jira_list_dashboards">, options: CallOptions): Promise<ToolOutput<"jira_list_dashboards">> {
    const params = new URLSearchParams({ startAt: String(input.startAt), maxResults: String(input.maxResults) });
    const response = record(await this.#getJson(`dashboard?${params}`, options.signal), "dashboard page");
    const dashboards = array(response.dashboards, "dashboards").map(value => {
      const dashboard = record(value, "dashboard");
      const id = requiredString(String(dashboard.id ?? ""), "dashboard id");
      const browseUrl = new URL("secure/Dashboard.jspa", this.#baseUrl);
      browseUrl.searchParams.set("selectPageId", id);
      return { id, name: requiredString(dashboard.name, "dashboard name"), browseUrl: browseUrl.toString() };
    });
    const total = typeof response.total === "number" ? response.total : undefined;
    const actualStartAt = typeof response.startAt === "number" ? response.startAt : input.startAt;
    const result = createReadResult(pageFromUpstream(dashboards, actualStartAt, total, undefined), this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_list_dashboards, fitPageResult(result, "jira_list_dashboards"), "dashboard page");
  }

  async listAttachments(input: ToolInput<"jira_list_attachments">, options: CallOptions): Promise<ToolOutput<"jira_list_attachments">> {
    const params = new URLSearchParams({
      jql: `key = ${input.issueKey}`,
      startAt: "0",
      maxResults: "1",
      fields: "attachment",
    });
    const response = record(await this.#getJson(`search?${params}`, options.signal), "attachment search response");
    const issues = array(response.issues, "attachment search issues");
    const matchingIssue = issues.map(value => record(value, "attachment search issue"))
      .find(issue => issue.key === input.issueKey);
    if (matchingIssue === undefined) {
      throw new JiraError({ kind: "not_found_or_hidden", message: "Jira did not return the requested issue; it may not exist or may be hidden from this user." });
    }
    const fields = record(matchingIssue.fields, "issue attachment fields");
    if (!Object.hasOwn(fields, "attachment")) throw unexpected("Jira did not return the requested attachment field");
    const attachments = (fields.attachment === null
      ? []
      : array(fields.attachment, "attachments")).map(value => {
      const attachment = record(value, "attachment");
      return {
        id: requiredId(attachmentIdSchema, attachment.id, "attachment id"),
        filename: requiredString(attachment.filename, "attachment filename"),
        mimeType: optionalString(attachment.mimeType) ?? "application/octet-stream",
        sizeBytes: requiredNumber(attachment.size, "attachment size"),
        created: requiredString(attachment.created, "attachment created"),
      };
    }).sort((left, right) => compareText(left.id, right.id) || compareText(left.filename, right.filename));
    const result = createReadResult(pageFromArray(attachments, input.startAt, input.maxResults), this.#baseUrl.toString());
    return fromUpstream(outputSchemas.jira_list_attachments, fitPageResult(result, "jira_list_attachments"), "attachment page");
  }

  async readAttachment(input: ToolInput<"jira_read_attachment">, options: CallOptions): Promise<ToolOutput<"jira_read_attachment">> {
    const params = new URLSearchParams({ jql: `key = ${input.issueKey}`, startAt: "0", maxResults: "1", fields: "attachment" });
    const response = record(await this.#getJson(`search?${params}`, options.signal), "attachment search response");
    const issues = array(response.issues, "attachment search issues");
    const issue = issues.map(value => record(value, "attachment search issue")).find(value => value.key === input.issueKey);
    if (issue === undefined) {
      throw new JiraError({ kind: "not_found_or_hidden", message: "Jira did not return the requested issue; it may not exist or may be hidden from this user." });
    }
    const fields = record(issue.fields, "issue attachment fields");
    if (!Object.hasOwn(fields, "attachment")) throw unexpected("Jira did not return the requested attachment field");
    const attachmentValues = fields.attachment === null ? [] : array(fields.attachment, "attachments");
    const attachment = attachmentValues.map(value => record(value, "attachment"))
      .find(value => requiredId(attachmentIdSchema, value.id, "attachment id") === input.attachmentId);
    if (attachment === undefined) {
      throw new JiraError({ kind: "not_found_or_hidden", message: "The attachment was not found on this issue or is hidden from this user." });
    }

    const mimeType = normalizeMimeType(requiredString(attachment.mimeType, "attachment MIME type"));
    if (!allowedAttachmentMimeTypes.has(mimeType)) {
      throw new JiraError({ kind: "unsupported_value", message: "This attachment MIME type is not supported for safe content retrieval." });
    }
    const sizeBytes = requiredNumber(attachment.size, "attachment size");
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw unexpected("attachment size was invalid");
    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new JiraError({ kind: "response_too_large", message: "The attachment exceeds the 128 KiB content retrieval limit." });
    }
    const contentValue = requiredString(attachment.content, "attachment content URL");
    let contentUrl: URL;
    try {
      contentUrl = new URL(contentValue, this.#baseUrl);
    } catch {
      throw unexpected("attachment content URL was invalid");
    }
    if (contentUrl.protocol !== "https:" || contentUrl.origin !== this.#baseUrl.origin
      || !contentUrl.pathname.startsWith(this.#baseUrl.pathname) || /%(?:25|2e|2f|5c)/i.test(contentUrl.pathname)
      || contentUrl.username !== "" || contentUrl.password !== "" || contentUrl.hash !== "") {
      throw new JiraError({ kind: "unsupported_value", message: "Jira returned an attachment URL outside the configured secure installation path." });
    }

    const bytes = await this.#getBytes(contentUrl, options.signal, mimeType, sizeBytes);
    let content: { kind: "text"; mimeType: string; text: string } | { kind: "image"; mimeType: string; base64: string };
    if (mimeType.startsWith("text/") || mimeType === "application/json") {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw unexpected("text attachment was not valid UTF-8");
      }
      if (mimeType === "application/json") {
        try {
          JSON.parse(text);
        } catch {
          throw unexpected("JSON attachment was malformed");
        }
      }
      content = { kind: "text", mimeType, text };
    } else {
      validateImageSignature(bytes, mimeType);
      content = { kind: "image", mimeType, base64: Buffer.from(bytes).toString("base64") };
    }
    const result = createReadResult(content, this.#baseUrl.toString());
    if (byteLength(result) > MAX_TOOL_BYTES) {
      throw new JiraError({ kind: "response_too_large", message: "The attachment content exceeds the MCP response limit." });
    }
    return fromUpstream(outputSchemas.jira_read_attachment, result, "attachment content");
  }

  async #getJson(path: string, callerSignal: AbortSignal, root: URL = this.#apiRoot): Promise<unknown> {
    return this.#getResource(new URL(path, root), callerSignal, "application/json", readJsonBody);
  }

  async #getBytes(url: URL, callerSignal: AbortSignal, mimeType: string, expectedBytes: number): Promise<Uint8Array> {
    return this.#getResource(url, callerSignal, mimeType, response => readAttachmentBody(response, mimeType, expectedBytes));
  }

  async #getResource<T>(url: URL, callerSignal: AbortSignal, accept: string, readResponse: (response: Response) => Promise<T>): Promise<T> {
    const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = AbortSignal.any([callerSignal, timeoutSignal]);
    let totalRetryWaitMs = 0;

    for (let attempt = 0; attempt <= MAX_READ_RETRIES; attempt += 1) {
      let outcome: HttpAttempt<T>;
      try {
        outcome = await this.#semaphore.run(signal, async () => {
          const response = await fetch(url, {
            method: "GET",
            headers: {
              accept,
              authorization: `Bearer ${this.#token}`,
            },
            redirect: "manual",
            signal,
          });

          const retryAfter = response.headers.get("retry-after");
          if (isRetryable(response.status) && attempt < MAX_READ_RETRIES) {
            await response.body?.cancel().catch(() => undefined);
            return { kind: "retry", status: response.status, retryAfter };
          }
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            return { kind: "failure", status: response.status, retryAfter };
          }
          return { kind: "success", value: await readResponse(response) };
        });
      } catch (error) {
        if (callerSignal.aborted) throw abortReason(callerSignal);
        if (timeoutSignal.aborted) throw new JiraError({ kind: "timeout", message: "The Jira request timed out." });
        if (error instanceof JiraError) throw error;
        throw new JiraError({ kind: "unavailable", message: "Jira could not be reached." });
      }

      if (outcome.kind === "success") return outcome.value;
      if (outcome.kind === "failure") {
        const requestedWaitMs = parseRetryAfter(outcome.retryAfter);
        if (isRetryable(outcome.status) && requestedWaitMs !== undefined
          && requestedWaitMs > MAX_TOTAL_RETRY_DELAY_MS - totalRetryWaitMs) {
          if (outcome.status === 429) throw mapHttpFailure(outcome.status, outcome.retryAfter);
          throw new JiraError({
            kind: "throttled",
            message: "Jira requested a retry outside the five-second retry budget.",
            retryAfterMs: requestedWaitMs,
          });
        }
        throw mapHttpFailure(outcome.status, outcome.retryAfter);
      }

      // Honor Retry-After exactly. If Jira asks for more than the remaining
      // aggregate retry budget, return the wait guidance instead of retrying early.
      const waitMs = retryDelay(outcome.retryAfter, attempt);
      const remainingBudgetMs = MAX_TOTAL_RETRY_DELAY_MS - totalRetryWaitMs;
      if (waitMs > remainingBudgetMs) {
        if (outcome.status === 429) throw mapHttpFailure(outcome.status, outcome.retryAfter);
        throw new JiraError({
          kind: "throttled",
          message: "Jira requested a retry outside the five-second retry budget.",
          retryAfterMs: waitMs,
        });
      }

      await delay(waitMs, signal).catch(error => {
        if (callerSignal.aborted) throw abortReason(callerSignal);
        if (timeoutSignal.aborted) throw new JiraError({ kind: "timeout", message: "The Jira request timed out." });
        throw error;
      });
      totalRetryWaitMs += waitMs;
    }
    throw new JiraError({ kind: "unavailable", message: "Jira did not return a response after the allowed retries." });
  }
}

type HttpAttempt<T = unknown> =
  | { kind: "success"; value: T }
  | { kind: "failure"; status: number; retryAfter: string | null }
  | { kind: "retry"; status: number; retryAfter: string | null };

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function mapIssueLinks(value: unknown): Array<{ id: string; type: string; direction: "inward" | "outward"; otherIssue: IssueKey }> {
  if (value === undefined || value === null) return [];
  return array(value, "issue links").map(item => {
    const link = record(item, "issue link");
    const type = record(link.type, "issue link type");
    const inward = link.inwardIssue;
    const outward = link.outwardIssue;
    const direction = inward !== undefined ? "inward" as const : "outward" as const;
    const other = record(inward ?? outward, "linked issue");
    return {
      id: requiredString(String(link.id ?? ""), "issue link id"),
      type: optionalString(type.name) ?? optionalString(type.inward) ?? "unknown",
      direction,
      otherIssue: requiredId(issueKeySchema, other.key, "linked issue key"),
    };
  });
}

function mapFieldMap<T>(value: unknown, convert: (value: unknown) => T): Record<FieldId, T> {
  if (value === undefined || value === null) return {};
  const result: Record<FieldId, T> = {};
  for (const [rawId, item] of Object.entries(record(value, "field metadata"))) {
    const id = fieldIdSchema.safeParse(rawId);
    if (id.success) result[id.data] = convert(item);
  }
  return result;
}

function mapChangelog(value: unknown): {
  requested: true;
  entries: Array<{
    id: string; created: string; author: { displayName: string; name?: string; active?: boolean } | null;
    changes: Array<{ field: string; fieldId?: FieldId; from: string | null; to: string | null }>;
  }>;
  returnedCount: number;
  startAt?: number;
  total?: number;
  completeness: "complete" | "partial" | "unknown";
  continuation: { supported: false; reason: "endpoint_unverified" };
} {
  const changelog = record(value ?? {}, "changelog");
  const histories = Array.isArray(changelog.histories) ? changelog.histories : [];
  const entries = histories.map(item => {
    const history = record(item, "history entry");
    const rawItems = Array.isArray(history.items) ? history.items : [];
    return {
      id: requiredString(String(history.id ?? ""), "history id"),
      created: requiredString(history.created, "history created"),
      author: mappedUser(history.author),
      changes: rawItems.map(changeValue => {
        const change = record(changeValue, "history change");
        const field = requiredString(change.field, "history field");
        const fieldId = optionalString(change.fieldId);
        return {
          field,
          ...(fieldId === undefined || !fieldIdSchema.safeParse(fieldId).success ? {} : { fieldId: fieldIdSchema.parse(fieldId) }),
          from: optionalString(change.from) ?? null,
          to: optionalString(change.to) ?? null,
        };
      }),
    };
  });
  const startAt = typeof changelog.startAt === "number" ? changelog.startAt : undefined;
  const total = typeof changelog.total === "number" ? changelog.total : undefined;
  const completeness = total === undefined
    ? "unknown"
    : (startAt ?? 0) + entries.length >= total ? "complete" : "partial";
  return {
    requested: true,
    entries,
    returnedCount: entries.length,
    ...(startAt === undefined ? {} : { startAt }),
    ...(total === undefined ? {} : { total }),
    completeness,
    continuation: { supported: false, reason: "endpoint_unverified" },
  };
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1000;
    return Number.isFinite(milliseconds) ? Math.min(Number.MAX_SAFE_INTEGER, milliseconds) : Number.MAX_SAFE_INTEGER;
  }
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function retryDelay(header: string | null, attempt: number): number {
  return parseRetryAfter(header) ?? 250 * 2 ** attempt;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function mapHttpFailure(status: number, retryAfter: string | null): JiraError {
  if (status === 400) return new JiraError({ kind: "invalid_input", message: "Jira rejected the request. Check the JQL, field names, and values." });
  if (status === 401) return new JiraError({ kind: "unauthenticated", message: "Jira rejected the configured personal access token." });
  if (status === 403) return new JiraError({ kind: "forbidden", message: "The Jira user does not have access to this operation." });
  if (status === 404) return new JiraError({ kind: "not_found_or_hidden", message: "The Jira issue or resource was not found or is hidden from this user." });
  if (status === 429) {
    const delayMs = parseRetryAfter(retryAfter);
    return new JiraError({
      kind: "throttled",
      message: "Jira is throttling requests. Retry after the indicated delay.",
      ...(delayMs === undefined ? {} : { retryAfterMs: delayMs }),
    });
  }
  if (status >= 500) return new JiraError({ kind: "unavailable", message: "Jira is temporarily unavailable." });
  return new JiraError({ kind: "unexpected_response", message: "Jira returned an unexpected HTTP response." });
}

async function readJsonBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLocaleLowerCase() ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("+json")) {
    throw new JiraError({ kind: "unexpected_response", message: "Jira returned a non-JSON response. Check the base URL and authentication." });
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_UPSTREAM_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new JiraError({ kind: "response_too_large", message: "The Jira response exceeds the 8 MiB request limit." });
  }
  if (response.body === null) throw new JiraError({ kind: "unexpected_response", message: "Jira returned an empty response." });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_UPSTREAM_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new JiraError({ kind: "response_too_large", message: "The Jira response exceeds the 8 MiB request limit." });
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new JiraError({ kind: "unexpected_response", message: "Jira returned invalid UTF-8 JSON." });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new JiraError({ kind: "unexpected_response", message: "Jira returned malformed JSON." });
  }
}

function normalizeMimeType(value: string): string {
  return value.split(";", 1)[0]!.trim().toLocaleLowerCase();
}

async function readAttachmentBody(response: Response, expectedMimeType: string, expectedBytes: number): Promise<Uint8Array> {
  const responseMimeType = response.headers.get("content-type");
  if (responseMimeType === null || normalizeMimeType(responseMimeType) !== expectedMimeType) {
    throw unexpected("attachment content type did not match its Jira metadata");
  }
  const contentLengthValue = response.headers.get("content-length");
  if (contentLengthValue !== null) {
    const contentLength = Number(contentLengthValue);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) throw unexpected("attachment content length was invalid");
    if (contentLength > MAX_ATTACHMENT_BYTES) {
      throw new JiraError({ kind: "response_too_large", message: "The attachment exceeds the 128 KiB content retrieval limit." });
    }
  }
  if (response.body === null) throw unexpected("Jira returned an empty attachment response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new JiraError({ kind: "response_too_large", message: "The attachment exceeds the 128 KiB content retrieval limit." });
    }
    if (size > expectedBytes) {
      void reader.cancel().catch(() => undefined);
      throw unexpected("attachment content exceeded its Jira metadata size");
    }
    chunks.push(part.value);
  }
  if (size !== expectedBytes) throw unexpected("attachment content size did not match its Jira metadata");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateImageSignature(bytes: Uint8Array, mimeType: string): void {
  const matches = mimeType === "image/png"
    ? bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
    : mimeType === "image/jpeg"
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mimeType === "image/gif"
        ? bytes.length >= 6 && new TextDecoder().decode(bytes.subarray(0, 6)).match(/^GIF8[79]a$/) !== null
        : bytes.length >= 12
          && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"
          && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP";
  if (!matches) throw unexpected("image bytes did not match their declared MIME type");
}

export function readConfig(env: Record<string, string | undefined>): Config {
  const rawUrl = env.JIRA_URL?.trim();
  if (rawUrl === undefined || rawUrl.length === 0) throw new Error("JIRA_URL is required.");
  const token = env.JIRA_KEY;
  if (token === undefined || token.trim().length === 0) throw new Error("JIRA_KEY is required.");

  let jiraUrl: URL;
  try {
    jiraUrl = new URL(rawUrl);
  } catch {
    throw new Error("JIRA_URL must be an absolute HTTPS URL.");
  }
  if (jiraUrl.protocol !== "https:" || jiraUrl.username !== "" || jiraUrl.password !== "" || jiraUrl.search !== "" || jiraUrl.hash !== "") {
    throw new Error("JIRA_URL must use HTTPS and cannot contain credentials, a query, or a fragment.");
  }
  jiraUrl.pathname = `${jiraUrl.pathname.replace(/\/+$/, "")}/`;
  if (jiraUrl.pathname === "//") jiraUrl.pathname = "/";

  const writeFlag = env.JIRA_ENABLE_WRITES?.trim();
  if (writeFlag !== undefined && writeFlag !== "true" && writeFlag !== "false") {
    throw new Error("JIRA_ENABLE_WRITES must be either true or false.");
  }
  return { jiraUrl, token, writesEnabled: writeFlag === "true" };
}
