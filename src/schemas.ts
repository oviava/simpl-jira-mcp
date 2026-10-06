import * as z from "zod/v4";

export const issueKeySchema = z.string().max(255).regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/).brand<"IssueKey">();
export const projectKeySchema = z.string().max(255).regex(/^[A-Z][A-Z0-9_]*$/).brand<"ProjectKey">();
export const fieldIdSchema = z.string().max(100).regex(/^[A-Za-z][A-Za-z0-9_]*$/).brand<"FieldId">();
export const issueIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"IssueId">();
export const projectIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"ProjectId">();
export const commentIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"CommentId">();
export const transitionIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"TransitionId">();
export const issueTypeIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"IssueTypeId">();
export const boardIdSchema = z.number().int().positive().brand<"BoardId">();
export const attachmentIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"AttachmentId">();
export const updatedSchema = z.string().min(1).max(64).brand<"Updated">();
export const userNameSchema = z.string().min(1).max(255).brand<"UserName">();

const page = {
  startAt: z.number().int().nonnegative().default(0),
  maxResults: z.number().int().min(1).max(100).default(20),
};
const fields = z.array(fieldIdSchema).min(1).max(50).optional();
const defaultCollections = ["issueTypes", "components", "versions"] as const;

export const inputSchemas = {
  jira_get_access: z.strictObject({
    projectKey: projectKeySchema.optional(),
    issueKey: issueKeySchema.optional(),
  }).refine(value => value.projectKey === undefined || value.issueKey === undefined, {
    message: "Choose projectKey or issueKey, not both",
  }),
  jira_list_projects: z.strictObject({ projectKey: projectKeySchema.optional(), ...page }),
  jira_get_project: z.strictObject({
    projectKey: projectKeySchema,
    ...page,
    collections: z.array(z.enum(defaultCollections)).min(1).max(3).default([...defaultCollections]),
  }),
  jira_list_fields: z.strictObject({
    filter: z.string().max(200).optional(),
    customOnly: z.boolean().default(false),
    ...page,
  }),
  jira_search_issues: z.strictObject({
    jql: z.string().min(1).max(8000),
    fields,
    ...page,
  }),
  jira_get_issue: z.strictObject({
    issueKey: issueKeySchema,
    fields,
    includeChangelog: z.boolean().default(false),
  }),
  jira_list_comments: z.strictObject({ issueKey: issueKeySchema, ...page }),
  jira_list_remote_links: z.strictObject({ issueKey: issueKeySchema, ...page }),
  jira_list_transitions: z.strictObject({ issueKey: issueKeySchema, ...page }),
  jira_read_issue_field: z.strictObject({
    issueKey: issueKeySchema,
    fieldId: fieldIdSchema,
    offset: z.number().int().nonnegative().default(0),
    length: z.number().int().min(1).max(8000).default(4000),
    expectedUpdated: updatedSchema.optional(),
  }).refine(value => value.offset === 0 || value.expectedUpdated !== undefined, {
    message: "expectedUpdated is required after the first text window",
  }),
  jira_read_comment: z.strictObject({
    issueKey: issueKeySchema,
    commentId: commentIdSchema,
    offset: z.number().int().nonnegative().default(0),
    length: z.number().int().min(1).max(8000).default(4000),
    expectedUpdated: updatedSchema.optional(),
  }).refine(value => value.offset === 0 || value.expectedUpdated !== undefined, {
    message: "expectedUpdated is required after the first text window",
  }),
  jira_list_boards: z.strictObject({
    name: z.string().max(200).optional(),
    type: z.enum(["scrum", "kanban"]).optional(),
    ...page,
  }),
  jira_get_board: z.strictObject({ boardId: boardIdSchema }),
  jira_list_board_issues: z.strictObject({ boardId: boardIdSchema, fields, ...page }),
  jira_list_sprints: z.strictObject({
    boardId: boardIdSchema,
    state: z.array(z.enum(["active", "future", "closed"])).min(1).max(3).optional(),
    ...page,
  }),
  jira_get_create_metadata: z.strictObject({
    projectKey: projectKeySchema,
    issueTypeId: issueTypeIdSchema.optional(),
    ...page,
  }),
  jira_get_edit_metadata: z.strictObject({ issueKey: issueKeySchema, ...page }),
  jira_find_assignable_users: z.strictObject({
    projectKey: projectKeySchema,
    issueKey: issueKeySchema.optional(),
    query: z.string().min(1).max(200),
    ...page,
  }),
  jira_list_worklogs: z.strictObject({ issueKey: issueKeySchema, ...page }),
  jira_list_favourite_filters: z.strictObject({ ...page }),
  jira_list_dashboards: z.strictObject({ ...page }),
  jira_list_attachments: z.strictObject({ issueKey: issueKeySchema, ...page }),
  // Implemented for direct callers and synthetic safety coverage; not registered until the byte-content gate passes.
  jira_read_attachment: z.strictObject({ issueKey: issueKeySchema, attachmentId: attachmentIdSchema }),
} as const;

export type ToolName = keyof typeof inputSchemas;
export type ToolInput<K extends ToolName> = z.output<(typeof inputSchemas)[K]>;

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(),
  z.array(jsonSchema), z.record(z.string(), jsonSchema),
]));

const provenanceSchema = z.object({ jiraUrl: z.string().url(), observedAt: z.string().min(1) });
const pageEvidenceSchema = z.union([
  z.object({ source: z.literal("total"), total: z.number().int().nonnegative() }),
  z.object({
    source: z.literal("isLast"),
    isLast: z.boolean(),
    total: z.number().int().nonnegative().optional(),
  }),
  z.object({ source: z.literal("catalog"), total: z.number().int().nonnegative() }),
  z.object({ source: z.literal("unknown") }),
]);
const pageSchema = <T extends z.ZodType>(item: T) => z.object({
  items: z.array(item),
  startAt: z.number().int().nonnegative(),
  returnedCount: z.number().int().nonnegative(),
  upstream: pageEvidenceSchema,
}).and(z.discriminatedUnion("hasMore", [
  z.object({ hasMore: z.literal(true), nextStartAt: z.number().int().nonnegative() }),
  z.object({ hasMore: z.literal(false), nextStartAt: z.never().optional() }),
  z.object({ hasMore: z.literal("unknown"), nextStartAt: z.never().optional() }),
]));
const namedValueSchema = z.object({ id: z.string(), name: z.string() });
const projectSummarySchema = z.object({
  id: projectIdSchema,
  key: projectKeySchema,
  name: z.string(),
  type: z.string(),
});
const fieldDefinitionSchema = z.object({
  id: fieldIdSchema,
  name: z.string(),
  custom: z.boolean(),
  schema: z.record(z.string(), jsonSchema).nullable(),
});
const issueSummarySchema = z.object({
  id: issueIdSchema,
  key: issueKeySchema,
  browseUrl: z.string().url(),
  updated: updatedSchema,
  fields: z.record(fieldIdSchema, z.unknown()),
});
const issueLinkSchema = z.object({
  id: z.string(),
  type: z.string(),
  direction: z.enum(["inward", "outward"]),
  otherIssue: issueKeySchema,
});
const historyEntrySchema = z.object({
  id: z.string(),
  created: z.string(),
  author: z.object({ displayName: z.string(), name: userNameSchema.optional(), active: z.boolean().optional() }).nullable(),
  changes: z.array(z.object({
    field: z.string(),
    fieldId: fieldIdSchema.optional(),
    from: z.string().nullable(),
    to: z.string().nullable(),
  })),
});
const changelogSchema = z.union([
  z.object({ requested: z.literal(false) }),
  z.object({
    requested: z.literal(true),
    entries: z.array(historyEntrySchema),
    returnedCount: z.number().int().nonnegative(),
    startAt: z.number().int().nonnegative().optional(),
    total: z.number().int().nonnegative().optional(),
    completeness: z.enum(["complete", "partial", "unknown"]),
    continuation: z.object({ supported: z.literal(false), reason: z.literal("endpoint_unverified") }),
  }),
]);
const issueSchema = issueSummarySchema.extend({
  names: z.record(fieldIdSchema, z.string()),
  schemas: z.record(fieldIdSchema, z.record(z.string(), jsonSchema)),
  links: z.array(issueLinkSchema),
  changelog: changelogSchema,
});
const userSummarySchema = z.object({
  displayName: z.string(),
  name: userNameSchema.optional(),
  active: z.boolean().optional(),
});
const accessSchema = z.object({
  user: userSummarySchema,
  serverVersion: z.string(),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("global") }),
    z.object({ kind: z.literal("project"), projectKey: projectKeySchema }),
    z.object({ kind: z.literal("issue"), issueKey: issueKeySchema }),
  ]),
  permissions: z.record(z.string(), z.enum(["allowed", "denied", "unknown"])),
});
const projectSchema = projectSummarySchema.extend({
  description: z.string().nullable(),
  collections: z.object({
    issueTypes: pageSchema(namedValueSchema).optional(),
    components: pageSchema(namedValueSchema).optional(),
    versions: pageSchema(namedValueSchema).optional(),
  }),
});
const commentSchema = z.object({
  id: commentIdSchema,
  issueKey: issueKeySchema,
  body: z.string().nullable().optional(),
  author: userSummarySchema.nullable(),
  created: z.string(),
  updated: updatedSchema,
});
const remoteLinkSchema = z.object({ id: z.string(), title: z.string(), url: z.string().url() });
const fieldMetadataSchema = z.object({
  id: fieldIdSchema,
  name: z.string(),
  required: z.union([z.boolean(), z.literal("unknown")]),
  schema: z.record(z.string(), jsonSchema).nullable(),
  operations: z.union([z.array(z.string()), z.literal("unknown")]),
  allowedValues: z.union([z.array(z.unknown()), z.literal("unknown")]),
  defaultValue: z.unknown().optional(),
});
const transitionSchema = z.object({
  id: transitionIdSchema,
  name: z.string(),
  targetStatus: namedValueSchema,
  fields: z.array(fieldMetadataSchema),
});
const boardSchema = z.object({
  id: boardIdSchema,
  name: z.string(),
  type: z.enum(["scrum", "kanban"]),
});
const boardDetailSchema = boardSchema.extend({ configuration: z.record(z.string(), jsonSchema) });
const sprintSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  state: z.enum(["active", "future", "closed"]),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  completeDate: z.string().optional(),
  goal: z.string().optional(),
});
const createMetadataSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("issueTypes"),
    projectKey: projectKeySchema,
    page: pageSchema(z.object({ id: issueTypeIdSchema, name: z.string() })),
  }),
  z.object({
    kind: z.literal("fields"),
    projectKey: projectKeySchema,
    issueTypeId: issueTypeIdSchema,
    page: pageSchema(fieldMetadataSchema),
  }),
]);
const assignableUserSchema = z.object({ name: userNameSchema, displayName: z.string(), active: z.boolean() });
const worklogSchema = z.object({
  id: z.string(),
  author: userSummarySchema.nullable(),
  started: z.string(),
  timeSpentSeconds: z.number().int().nonnegative(),
  comment: z.string().nullable(),
});
const filterSchema = z.object({ id: z.string(), name: z.string(), jql: z.string(), browseUrl: z.string().url() });
const dashboardSchema = z.object({ id: z.string(), name: z.string(), browseUrl: z.string().url() });
const attachmentSchema = z.object({
  id: attachmentIdSchema,
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  created: z.string(),
});
const textWindowFields = {
  text: z.string(),
  encoding: z.enum(["plain", "json"]),
  offset: z.number().int().nonnegative(),
  returnedCount: z.number().int().nonnegative(),
  totalCodePoints: z.number().int().nonnegative(),
  updated: updatedSchema,
};
const textWindowSchema = z.discriminatedUnion("complete", [
  z.object({ ...textWindowFields, complete: z.literal(true), nextOffset: z.never().optional() }),
  z.object({ ...textWindowFields, complete: z.literal(false), nextOffset: z.number().int().nonnegative() }),
]);
const attachmentContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), mimeType: z.string(), text: z.string() }),
  z.object({ kind: z.literal("image"), mimeType: z.string(), base64: z.string() }),
]);
const omissionSchema = z.object({
  path: z.string(),
  reason: z.literal("result_limit"),
  recovery: z.union([
    z.object({
      tool: z.literal("jira_read_issue_field"),
      issueKey: issueKeySchema,
      fieldId: fieldIdSchema,
      expectedUpdated: updatedSchema,
    }),
    z.object({
      tool: z.literal("jira_read_comment"),
      issueKey: issueKeySchema,
      commentId: commentIdSchema,
      expectedUpdated: updatedSchema,
    }),
    z.object({ action: z.literal("select_fewer_fields") }),
    z.object({ action: z.literal("unavailable"), explanation: z.string() }),
  ]),
});
const readResultSchema = <T extends z.ZodType>(data: T) => z.object({
  data,
  provenance: provenanceSchema,
  omissions: z.array(omissionSchema),
});

export const outputSchemas = {
  jira_get_access: readResultSchema(accessSchema),
  jira_list_projects: readResultSchema(pageSchema(projectSummarySchema)),
  jira_get_project: readResultSchema(projectSchema),
  jira_list_fields: readResultSchema(pageSchema(fieldDefinitionSchema)),
  jira_search_issues: readResultSchema(pageSchema(issueSummarySchema)),
  jira_get_issue: readResultSchema(issueSchema),
  jira_list_comments: readResultSchema(pageSchema(commentSchema)),
  jira_list_remote_links: readResultSchema(pageSchema(remoteLinkSchema)),
  jira_list_transitions: readResultSchema(pageSchema(transitionSchema)),
  jira_read_issue_field: readResultSchema(textWindowSchema),
  jira_read_comment: readResultSchema(textWindowSchema),
  jira_list_boards: readResultSchema(pageSchema(boardSchema)),
  jira_get_board: readResultSchema(boardDetailSchema),
  jira_list_board_issues: readResultSchema(pageSchema(issueSummarySchema)),
  jira_list_sprints: readResultSchema(pageSchema(sprintSchema)),
  jira_get_create_metadata: readResultSchema(createMetadataSchema),
  jira_get_edit_metadata: readResultSchema(z.object({ issueKey: issueKeySchema, page: pageSchema(fieldMetadataSchema) })),
  jira_find_assignable_users: readResultSchema(pageSchema(assignableUserSchema)),
  jira_list_worklogs: readResultSchema(pageSchema(worklogSchema)),
  jira_list_favourite_filters: readResultSchema(pageSchema(filterSchema)),
  jira_list_dashboards: readResultSchema(pageSchema(dashboardSchema)),
  jira_list_attachments: readResultSchema(pageSchema(attachmentSchema)),
  jira_read_attachment: readResultSchema(attachmentContentSchema),
} as const;

export type ToolOutput<K extends ToolName> = z.output<(typeof outputSchemas)[K]>;
export type IssueKey = z.output<typeof issueKeySchema>;
export type ProjectKey = z.output<typeof projectKeySchema>;
export type FieldId = z.output<typeof fieldIdSchema>;
export type Updated = z.output<typeof updatedSchema>;
export type CommentId = z.output<typeof commentIdSchema>;
export type JsonValue = Json;
