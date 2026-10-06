# Jira MCP implementation tasks

Build an MCP server for one person using their own Jira personal access token. Run it locally from an MCP client. Use TypeScript 7+ and the official TypeScript SDK, as specified in the [implementation plan](mcp-implementation-plan.md).

Configuration comes from environment variables:

| Variable | Requirement |
| --- | --- |
| `JIRA_URL` | Required. Base URL of the user's Jira installation, including any installation path. |
| `JIRA_KEY` | Required. The user's personal access token. Retains the name used in discovery. |
| `JIRA_ENABLE_WRITES` | Optional. Defaults to `false`. The current release rejects `true` because write tools have not passed their acceptance gate. |

Implementation status: tasks 1–8 and 10 have runtime and synthetic Jira/MCP-client coverage. The 22 registered read-only tools pass fake-Jira tests through modern and legacy official-client stdio workflows. A clean installation of the packed artifact also passed an official-client stdio smoke check. The attachment-byte reader has direct synthetic safety coverage, including configured-path checks, but remains unadvertised pending live content-route verification. No live Jira acceptance or intended-host run was performed. Write tools await a designated test issue as described below.

No other configuration is required initially. The compatibility target is the self-managed Jira API verified during discovery. A configurable URL does not imply Jira Cloud support.

## First release: connection and issue research

- [x] **1. Set up the local MCP server.** Make it installable and runnable from an MCP client. Confirm that the client can discover and call its tools.
- [x] **2. Configure the Jira connection.** Read the URL and PAT from the environment, validate the configuration, and explain missing settings or failed authentication. Keep the PAT out of results and logs. Support a configured URL without changes to the source code.
- [x] **3. Show identity and access.** Report the connected Jira user and permissions for a selected project or issue. Distinguish denied access from permissions that could not be determined.
- [x] **4. Browse project information.** List accessible projects and show their issue types, components, versions, and fields. Include custom fields and distinguish fields with duplicate names.
- [x] **5. Search and read issues.** Support JQL search and issue lookup, including descriptions, status, people, labels, custom fields, and issue links. Include Jira links and make further result pages available.
- [x] **6. Read discussions and workflow options.** Retrieve comments, remote links, available transitions, and available change history. Make empty results and incomplete history clear.

The first release is complete when the user can connect, find an issue, inspect its details and discussion, and check their access from their MCP client.

## Extend the Jira workflow

- [x] **7. Browse boards and sprints.** List boards, inspect board issues, and read sprints where supported. Handle differences between Kanban and Scrum boards clearly.
- [x] **8. Prepare valid issue changes.** Discover required fields, allowed values, editable fields, and assignable users for the selected project and issue type. These read tools report metadata; mutation tools remain gated.
- [ ] **9. Add optional write tools.** After the designated test-issue acceptance gate passes, allow issue creation, updates, assignment, comments, issue links, and status transitions within the user's permissions. Return the affected Jira item and a clear outcome. Avoid duplicate changes after uncertain failures. The current release rejects `JIRA_ENABLE_WRITES=true`.
- [x] **10. Add supporting reads.** List worklogs, favorite filters, dashboards, and attachment metadata. A bounded attachment-byte reader is implemented and synthetic safety-tested; its live compatibility gate remains open, so it is not registered.

Write functionality is complete only after testing each supported operation on designated test issues and checking the resulting Jira state. Discovery verified permission flags, not write execution.

## Verify and deliver

- [ ] **11. Verify behavior and failures.** Synthetic behavior coverage exercises the read-only MCP workflows, pagination, custom fields, permission uncertainty, error handling, large responses, disabled writes, and credential privacy. Live Jira behavior and a real issue-research workflow remain unverified.
- [ ] **12. Document and package personal setup.** Setup instructions, an MCP client configuration example, environment-variable reference, and troubleshooting guidance are present. The packed release artifact has been installed in a clean directory and called through the official client with synthetic Jira; run it with the intended host against a real Jira issue-research workflow to finish this task.

Shared hosting, multiple users, OAuth, administration, issue deletion, bulk changes, sprint management, Confluence, and plugin-specific APIs are outside this task list. Attachment uploads and worklog changes remain follow-up work if needed.
