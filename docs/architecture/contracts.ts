/**
 * Architecture contract, not an implemented client.
 * Output shapes below become Zod output schemas and inferred types during fill-in.
 * Do not maintain a second handwritten copy of those types in production.
 */
import type {
  AttachmentId, BoardId, CommentId, FieldId, IssueId, IssueKey, IssueTypeId,
  ProjectId, ProjectKey, ToolArguments, ToolInput, ToolName, TransitionId, Updated, UserName,
} from "./schemas.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type PermissionScope =
  | { kind: "global" }
  | { kind: "project"; projectKey: ProjectKey }
  | { kind: "issue"; issueKey: IssueKey };
export type Permission = "allowed" | "denied" | "unknown";
export type UserSummary = { displayName: string; name?: UserName; active?: boolean };
export type Access = {
  user: UserSummary; serverVersion: string; scope: PermissionScope;
  permissions: Record<string, Permission>;
};

/** Every result carries its Jira origin and observation time, never credentials. */
export type Provenance = { jiraUrl: string; observedAt: string };
export type PagePosition = { startAt: number; returnedCount: number };
export type PageContinuation =
  | { hasMore: true; nextStartAt: number }
  | { hasMore: false; nextStartAt?: never }
  | { hasMore: "unknown"; nextStartAt?: never };
export type PageEvidence =
  | { source: "total"; total: number }
  | { source: "isLast"; isLast: boolean; total?: number }
  | { source: "catalog"; total: number }
  | { source: "unknown" };
export type Page<T> = PagePosition & PageContinuation & {
  items: T[]; upstream: PageEvidence;
};

export type TextRead =
  | { tool: "jira_read_issue_field"; issueKey: IssueKey; fieldId: FieldId; expectedUpdated: Updated }
  | { tool: "jira_read_comment"; issueKey: IssueKey; commentId: CommentId; expectedUpdated: Updated };
export type ValueOmission = {
  path: string; reason: "result_limit";
  recovery: TextRead | { action: "select_fewer_fields" } | { action: "unavailable"; explanation: string };
};
export type ReadResult<T> = {
  data: T; provenance: Provenance; omissions: ValueOmission[];
};
/** Offsets count Unicode code points. Later windows require the first revision. */
export type TextWindow = {
  text: string; encoding: "plain" | "json"; offset: number; returnedCount: number;
  totalCodePoints: number; updated: Updated;
} & (
  | { complete: true; nextOffset?: never }
  | { complete: false; nextOffset: number }
);

export type NamedValue = { id: string; name: string };
export type ProjectSummary = { id: ProjectId; key: ProjectKey; name: string; type: string };
export type Project = ProjectSummary & {
  description: string | null;
  collections: Partial<Record<"issueTypes" | "components" | "versions", Page<NamedValue>>>;
};
export type FieldDefinition = {
  id: FieldId; name: string; custom: boolean; schema: Record<string, Json> | null;
};
export type IssueSummary = {
  id: IssueId; key: IssueKey; browseUrl: string; updated: Updated;
  /** Only returned fields exist; a missing field differs from a null value. */
  fields: Partial<Record<FieldId, unknown>>;
};
export type IssueLink = {
  id: string; type: string; direction: "inward" | "outward"; otherIssue: IssueKey;
};
export type HistoryEntry = {
  id: string; created: string; author: UserSummary | null;
  changes: { field: string; fieldId?: FieldId; from: string | null; to: string | null }[];
};
export type Changelog =
  | { requested: false }
  | {
    requested: true; entries: HistoryEntry[]; returnedCount: number;
    startAt?: number; total?: number; completeness: "complete" | "partial" | "unknown";
    continuation: { supported: false; reason: "endpoint_unverified" };
  };
export type Issue = IssueSummary & {
  names: Partial<Record<FieldId, string>>;
  schemas: Partial<Record<FieldId, Record<string, Json>>>;
  links: IssueLink[]; changelog: Changelog;
};
export type Comment = {
  id: CommentId; issueKey: IssueKey; body?: string | null;
  author: UserSummary | null; created: string; updated: Updated;
};
export type RemoteLink = { id: string; title: string; url: string };
export type KnownValue<T> = T | "unknown";
export type FieldMetadata = {
  id: FieldId; name: string; required: KnownValue<boolean>; schema: Record<string, Json> | null;
  operations: KnownValue<string[]>; allowedValues: KnownValue<unknown[]>; defaultValue?: unknown;
};
export type Transition = {
  id: TransitionId; name: string; targetStatus: NamedValue; fields: FieldMetadata[];
};
export type Board = { id: BoardId; name: string; type: "scrum" | "kanban" };
export type BoardDetail = Board & { configuration: Record<string, Json> };
export type Sprint = {
  id: number; name: string; state: "active" | "future" | "closed";
  startDate?: string; endDate?: string; completeDate?: string; goal?: string;
};
export type CreateMetadata =
  | { kind: "issueTypes"; projectKey: ProjectKey; page: Page<{ id: IssueTypeId; name: string }> }
  | { kind: "fields"; projectKey: ProjectKey; issueTypeId: IssueTypeId; page: Page<FieldMetadata> };
export type EditMetadata = { issueKey: IssueKey; page: Page<FieldMetadata> };
export type AssignableUser = { name: UserName; displayName: string; active: boolean };
export type Worklog = {
  id: string; author: UserSummary | null; started: string; timeSpentSeconds: number; comment: string | null;
};
export type Filter = { id: string; name: string; jql: string; browseUrl: string };
export type Dashboard = { id: string; name: string; browseUrl: string };
export type Attachment = {
  id: AttachmentId; filename: string; mimeType: string; sizeBytes: number; created: string;
};
/** The runtime implements bounded text/image retrieval; registration has a separate live compatibility gate. */
export type AttachmentContent =
  | { kind: "text"; mimeType: string; text: string }
  | { kind: "image"; mimeType: string; base64: string };

export type MutationEffect =
  | { kind: "issue"; issue: { id: IssueId; key: IssueKey; browseUrl: string } }
  | { kind: "comment"; issueKey: IssueKey; commentId: CommentId }
  | { kind: "assignment"; issueKey: IssueKey; assignee: UserName | null }
  | { kind: "transition"; issueKey: IssueKey; transitionId: TransitionId }
  | { kind: "link"; inwardIssueKey: IssueKey; outwardIssueKey: IssueKey; linkType: string; linkId?: string };
export type MutationReceipt = {
  outcome: "acknowledged"; effect: MutationEffect;
  verification: "read_back" | "not_verified";
};
export type ReconcileCall =
  | { tool: "jira_search_issues"; arguments: ToolArguments<"jira_search_issues"> }
  | { tool: "jira_get_issue"; arguments: ToolArguments<"jira_get_issue"> }
  | { tool: "jira_list_comments"; arguments: ToolArguments<"jira_list_comments"> };
export type MutationFailure = {
  kind: "write_outcome_unknown";
  message: string;
  reconcile: ReconcileCall;
};
export type ResourceIdentifier =
  | { kind: "issue"; issueKey: IssueKey }
  | { kind: "comment"; issueKey: IssueKey; commentId: CommentId }
  | { kind: "field"; fieldId: FieldId }
  | { kind: "catalog_item"; tool: ReadToolName; id: string; startAt: number };
export type JiraFailure =
  | { kind: "invalid_input"; message: string; fields?: FieldId[] }
  | { kind: "unauthenticated" | "forbidden" | "not_found_or_hidden"; message: string }
  | { kind: "throttled"; message: string; retryAfterMs?: number }
  | { kind: "timeout" | "unavailable" | "unexpected_response" | "response_too_large"; message: string }
  | {
    kind: "result_too_large"; message: string; resource: ResourceIdentifier;
    recovery?: TextRead | { action: "select_fewer_fields" } | { action: "unavailable"; explanation: string };
  }
  | { kind: "source_changed" | "stale_edit" | "metadata_incomplete" | "unsupported_value"; message: string }
  | MutationFailure;
/** Cancellation propagates through AbortSignal; it is not an empty success. */
export declare class JiraError extends Error {
  readonly failure: JiraFailure;
  constructor(failure: JiraFailure);
}

export type ToolData = {
  jira_get_access: Access;
  jira_list_projects: Page<ProjectSummary>;
  jira_get_project: Project;
  jira_list_fields: Page<FieldDefinition>;
  jira_search_issues: Page<IssueSummary>;
  jira_get_issue: Issue;
  jira_list_comments: Page<Comment>;
  jira_list_remote_links: Page<RemoteLink>;
  jira_list_transitions: Page<Transition>;
  jira_read_issue_field: TextWindow;
  jira_read_comment: TextWindow;
  jira_list_boards: Page<Board>;
  jira_get_board: BoardDetail;
  jira_list_board_issues: Page<IssueSummary>;
  jira_list_sprints: Page<Sprint>;
  jira_get_create_metadata: CreateMetadata;
  jira_get_edit_metadata: EditMetadata;
  jira_find_assignable_users: Page<AssignableUser>;
  jira_create_issue: MutationReceipt;
  jira_update_issue: MutationReceipt;
  jira_add_comment: MutationReceipt;
  jira_assign_issue: MutationReceipt;
  jira_transition_issue: MutationReceipt;
  jira_link_issues: MutationReceipt;
  jira_list_worklogs: Page<Worklog>;
  jira_list_favourite_filters: Page<Filter>;
  jira_list_dashboards: Page<Dashboard>;
  jira_list_attachments: Page<Attachment>;
  jira_read_attachment: AttachmentContent;
};
export type WriteToolName =
  | "jira_create_issue" | "jira_update_issue" | "jira_add_comment"
  | "jira_assign_issue" | "jira_transition_issue" | "jira_link_issues";
export type ReadToolName = Exclude<ToolName, WriteToolName>;
export type ToolOutput<K extends ToolName> = K extends WriteToolName
  ? ToolData[K] : ReadResult<ToolData[K]>;
export type CallOptions = { signal: AbortSignal };
export type Config = { jiraUrl: URL; token: string; writesEnabled: boolean };

/** Concrete implementation owns all endpoint and operation policy. No plugin registry. */
export declare class JiraClient {
  constructor(config: Config);
  getAccess(input: ToolInput<"jira_get_access">, options: CallOptions): Promise<ToolOutput<"jira_get_access">>;
  listProjects(input: ToolInput<"jira_list_projects">, options: CallOptions): Promise<ToolOutput<"jira_list_projects">>;
  getProject(input: ToolInput<"jira_get_project">, options: CallOptions): Promise<ToolOutput<"jira_get_project">>;
  listFields(input: ToolInput<"jira_list_fields">, options: CallOptions): Promise<ToolOutput<"jira_list_fields">>;
  searchIssues(input: ToolInput<"jira_search_issues">, options: CallOptions): Promise<ToolOutput<"jira_search_issues">>;
  getIssue(input: ToolInput<"jira_get_issue">, options: CallOptions): Promise<ToolOutput<"jira_get_issue">>;
  listComments(input: ToolInput<"jira_list_comments">, options: CallOptions): Promise<ToolOutput<"jira_list_comments">>;
  listRemoteLinks(input: ToolInput<"jira_list_remote_links">, options: CallOptions): Promise<ToolOutput<"jira_list_remote_links">>;
  listTransitions(input: ToolInput<"jira_list_transitions">, options: CallOptions): Promise<ToolOutput<"jira_list_transitions">>;
  readIssueField(input: ToolInput<"jira_read_issue_field">, options: CallOptions): Promise<ToolOutput<"jira_read_issue_field">>;
  readComment(input: ToolInput<"jira_read_comment">, options: CallOptions): Promise<ToolOutput<"jira_read_comment">>;
  listBoards(input: ToolInput<"jira_list_boards">, options: CallOptions): Promise<ToolOutput<"jira_list_boards">>;
  getBoard(input: ToolInput<"jira_get_board">, options: CallOptions): Promise<ToolOutput<"jira_get_board">>;
  listBoardIssues(input: ToolInput<"jira_list_board_issues">, options: CallOptions): Promise<ToolOutput<"jira_list_board_issues">>;
  listSprints(input: ToolInput<"jira_list_sprints">, options: CallOptions): Promise<ToolOutput<"jira_list_sprints">>;
  getCreateMetadata(input: ToolInput<"jira_get_create_metadata">, options: CallOptions): Promise<ToolOutput<"jira_get_create_metadata">>;
  getEditMetadata(input: ToolInput<"jira_get_edit_metadata">, options: CallOptions): Promise<ToolOutput<"jira_get_edit_metadata">>;
  findAssignableUsers(input: ToolInput<"jira_find_assignable_users">, options: CallOptions): Promise<ToolOutput<"jira_find_assignable_users">>;
  createIssue(input: ToolInput<"jira_create_issue">, options: CallOptions): Promise<MutationReceipt>;
  updateIssue(input: ToolInput<"jira_update_issue">, options: CallOptions): Promise<MutationReceipt>;
  addComment(input: ToolInput<"jira_add_comment">, options: CallOptions): Promise<MutationReceipt>;
  assignIssue(input: ToolInput<"jira_assign_issue">, options: CallOptions): Promise<MutationReceipt>;
  transitionIssue(input: ToolInput<"jira_transition_issue">, options: CallOptions): Promise<MutationReceipt>;
  linkIssues(input: ToolInput<"jira_link_issues">, options: CallOptions): Promise<MutationReceipt>;
  listWorklogs(input: ToolInput<"jira_list_worklogs">, options: CallOptions): Promise<ToolOutput<"jira_list_worklogs">>;
  listFavouriteFilters(input: ToolInput<"jira_list_favourite_filters">, options: CallOptions): Promise<ToolOutput<"jira_list_favourite_filters">>;
  listDashboards(input: ToolInput<"jira_list_dashboards">, options: CallOptions): Promise<ToolOutput<"jira_list_dashboards">>;
  listAttachments(input: ToolInput<"jira_list_attachments">, options: CallOptions): Promise<ToolOutput<"jira_list_attachments">>;
  readAttachment(input: ToolInput<"jira_read_attachment">, options: CallOptions): Promise<ToolOutput<"jira_read_attachment">>;
}

/** Startup boundary. Reject missing credentials, URL userinfo/query/fragment and invalid flags. */
export function readConfig(_env: Record<string, string | undefined>): Config {
  throw new Error("not implemented");
}
