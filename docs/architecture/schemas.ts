/** Design sketch: public tool inputs and semantic identifiers, using Zod 4. */
import * as z from "zod/v4";

export const issueKeySchema = z.string().max(255).regex(/^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/).brand<"IssueKey">();
export const projectKeySchema = z.string().max(255).regex(/^[A-Z][A-Z0-9_]*$/).brand<"ProjectKey">();
export const fieldIdSchema = z.string().max(100).regex(/^[A-Za-z][A-Za-z0-9_]*$/).brand<"FieldId">();
export const issueIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"IssueId">();
export const projectIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"ProjectId">();
export const issueTypeIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"IssueTypeId">();
export const commentIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"CommentId">();
export const transitionIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"TransitionId">();
export const attachmentIdSchema = z.string().regex(/^[1-9][0-9]*$/).brand<"AttachmentId">();
export const boardIdSchema = z.number().int().positive().brand<"BoardId">();
export const updatedSchema = z.string().min(1).max(64).brand<"Updated">();
export const userNameSchema = z.string().min(1).max(255).brand<"UserName">();

export type IssueKey = z.output<typeof issueKeySchema>;
export type ProjectKey = z.output<typeof projectKeySchema>;
export type FieldId = z.output<typeof fieldIdSchema>;
export type IssueId = z.output<typeof issueIdSchema>;
export type ProjectId = z.output<typeof projectIdSchema>;
export type IssueTypeId = z.output<typeof issueTypeIdSchema>;
export type CommentId = z.output<typeof commentIdSchema>;
export type TransitionId = z.output<typeof transitionIdSchema>;
export type AttachmentId = z.output<typeof attachmentIdSchema>;
export type BoardId = z.output<typeof boardIdSchema>;
export type Updated = z.output<typeof updatedSchema>;
export type UserName = z.output<typeof userNameSchema>;

const page = {
  startAt: z.number().int().nonnegative().default(0),
  maxResults: z.number().int().min(1).max(100).default(20),
};
const fields = z.array(fieldIdSchema).min(1).max(50).optional();
const issue = { issueKey: issueKeySchema };
const project = { projectKey: projectKeySchema };
const fieldValues = z.record(fieldIdSchema, z.unknown());
const textWindow = {
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().min(1).max(8000).default(4000),
  expectedUpdated: updatedSchema.optional(),
};
const requireSnapshot = <T extends { offset: number; expectedUpdated?: Updated | undefined }>(value: T) =>
  value.offset === 0 || value.expectedUpdated !== undefined;

/** Schemas describe caller JSON. Handlers receive z.output, with defaults applied. */
export const inputSchemas = {
  jira_get_access: z.strictObject({
    projectKey: projectKeySchema.optional(), issueKey: issueKeySchema.optional(),
  }).refine(value => value.projectKey === undefined || value.issueKey === undefined, {
    message: "Choose projectKey or issueKey, not both",
  }),
  jira_list_projects: z.strictObject({ projectKey: projectKeySchema.optional(), ...page }),
  jira_get_project: z.strictObject({
    ...project, ...page,
    collections: z.array(z.enum(["issueTypes", "components", "versions"])).min(1).max(3)
      .default(["issueTypes", "components", "versions"]),
  }),
  jira_list_fields: z.strictObject({
    filter: z.string().max(200).optional(), customOnly: z.boolean().default(false), ...page,
  }),
  jira_search_issues: z.strictObject({ jql: z.string().min(1).max(8000), fields, ...page }),
  jira_get_issue: z.strictObject({ ...issue, fields, includeChangelog: z.boolean().default(false) }),
  jira_list_comments: z.strictObject({ ...issue, ...page }),
  jira_list_remote_links: z.strictObject({ ...issue, ...page }),
  jira_list_transitions: z.strictObject({ ...issue, ...page }),

  // Recovery reads extend the original nine tools to make size limits usable.
  jira_read_issue_field: z.strictObject({ ...issue, fieldId: fieldIdSchema, ...textWindow })
    .refine(requireSnapshot, { message: "expectedUpdated is required after the first text window" }),
  jira_read_comment: z.strictObject({ ...issue, commentId: commentIdSchema, ...textWindow })
    .refine(requireSnapshot, { message: "expectedUpdated is required after the first text window" }),

  jira_list_boards: z.strictObject({
    name: z.string().max(200).optional(), type: z.enum(["scrum", "kanban"]).optional(), ...page,
  }),
  jira_get_board: z.strictObject({ boardId: boardIdSchema }),
  jira_list_board_issues: z.strictObject({ boardId: boardIdSchema, fields, ...page }),
  jira_list_sprints: z.strictObject({
    boardId: boardIdSchema,
    state: z.array(z.enum(["active", "future", "closed"])).min(1).max(3).optional(), ...page,
  }),
  jira_get_create_metadata: z.strictObject({ ...project, issueTypeId: issueTypeIdSchema.optional(), ...page }),
  jira_get_edit_metadata: z.strictObject({ ...issue, ...page }),
  jira_find_assignable_users: z.strictObject({
    ...project, issueKey: issueKeySchema.optional(), query: z.string().min(1).max(200), ...page,
  }),
  jira_create_issue: z.strictObject({ ...project, issueTypeId: issueTypeIdSchema, fields: fieldValues }),
  jira_update_issue: z.strictObject({
    ...issue, fields: fieldValues.refine(value => Object.keys(value).length > 0),
    expectedUpdated: updatedSchema.optional(),
  }),
  jira_add_comment: z.strictObject({ ...issue, body: z.string().min(1).max(64000) }),
  jira_assign_issue: z.strictObject({
    ...issue, assignee: userNameSchema.nullable(), expectedUpdated: updatedSchema.optional(),
  }),
  jira_transition_issue: z.strictObject({
    ...issue, transitionId: transitionIdSchema, fields: fieldValues.optional(),
    expectedUpdated: updatedSchema.optional(),
  }),
  jira_link_issues: z.strictObject({
    inwardIssueKey: issueKeySchema, outwardIssueKey: issueKeySchema,
    linkType: z.string().min(1).max(200),
  }),
  jira_list_worklogs: z.strictObject({ ...issue, ...page }),
  jira_list_favourite_filters: z.strictObject(page),
  jira_list_dashboards: z.strictObject(page),
  jira_list_attachments: z.strictObject({ ...issue, ...page }),
  // Deferred binary retrieval: advertised only after its separate acceptance gate.
  jira_read_attachment: z.strictObject({ ...issue, attachmentId: attachmentIdSchema }),
} as const;

export type ToolName = keyof typeof inputSchemas;
export type ToolArguments<K extends ToolName> = z.input<(typeof inputSchemas)[K]>;
export type ToolInput<K extends ToolName> = z.output<(typeof inputSchemas)[K]>;
