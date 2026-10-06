# SIMPL Jira API capability report

Observed on 2 October 2026, 14:09:57 to 14:10:10 Europe/Bucharest. This report describes access through the current `JIRA_KEY` principal at `https://jira.simplprogramme.eu`.

The token supports a useful Jira MCP server today. Core issue reads, JQL search, project metadata, workflow metadata, and Jira Software board and sprint reads succeeded. Jira also reports write permissions in several projects, but this investigation performed no mutations. The [implementation plan](mcp-implementation-plan.md) uses these findings.

## Evidence and scope

The final discovery run made 50 GET requests. Forty-eight returned HTTP 200 JSON, one returned 403, and one returned 302. Earlier exploratory requests confirmed the same deployment and sampled additional issues. The final run is the baseline for the counts below.

- [Machine-readable evidence](jira-discovery-evidence.json) contains request URLs, timestamps, statuses, selected counts, and permission flags. It excludes account identities, issue descriptions, comment bodies, and credential values.
- [Raw responses and manifest](../work/discovery/manifest.json) remain locally under ignored `work/discovery/`. These files contain private Jira content and are not part of the shareable report.
- The investigation used bounded, sequential GET requests, refused redirects, used a 25-second timeout, and limited each response to 8 MiB.
- Evidence extraction read only responses referenced by the final manifest. Older files left by earlier runs did not enter its evidence. The temporary investigation scripts have been removed; this report and the evidence retain their outcomes.

Successful reads verify only the sampled resources. Permission flags indicate authorization, not successful execution of a write. Empty results mean the endpoint worked but returned no entries for that sample. A redirect does not prove either access or absence of a product.

## Deployment and authentication

| Property | Observed result |
| --- | --- |
| Jira version | `10.3.25`, build `10030025` |
| Deployment label | `/serverInfo` reports `Server` |
| API family | Self-managed Jira platform REST v2 and Jira Software Agile REST v1 |
| Authentication | `Authorization: Bearer` using `JIRA_KEY` succeeded |
| Principal | `/myself` returned an active user with Europe/Bucharest timezone |
| Visible projects | `JCS`, `PSOT`, `SC1PLAN`, `SCE`, `SIMPL`, `SPGRLOG` |
| Visible issue search total | 36,726 across projects, including 32,498 in SIMPL |

Sources are the live [server information](https://jira.simplprogramme.eu/rest/api/2/serverInfo), [current user](https://jira.simplprogramme.eu/rest/api/2/myself), and [projects](https://jira.simplprogramme.eu/rest/api/2/project) endpoints. The deployment label does not establish licensing or clustering. The observed API belongs to the Server/Data Center family, so Cloud REST v3 schemas, Cloud account IDs, and Cloud token scopes are not the implementation baseline. Atlassian documents bearer authentication for self-managed installations in its [personal access token guide](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html). The token's creation method and expiry were not inspected.

## Verified read capabilities

Paths in this table are relative to the fixed Jira root. The evidence JSON records the actual query parameters and sampled IDs.

| Capability | Endpoint | Result and boundary |
| --- | --- | --- |
| Identity and version | `/rest/api/2/myself`, `/serverInfo` | Both succeeded. |
| Permissions | `/rest/api/2/mypermissions` | Unscoped, all six project contexts, and two issue contexts succeeded. |
| Project catalog | `/rest/api/2/project` | Six projects, all marked `software`. |
| SIMPL configuration | `/rest/api/2/project/SIMPL`, `/components`, `/versions`, `/statuses` | 35 components and 10 versions. |
| JQL search | `/rest/api/2/search` | Global, SIMPL, and attachment searches succeeded with bounded pages. |
| Issue detail | `/rest/api/2/issue/{key}` | Selected fields, names, schemas, and embedded changelog returned. |
| Comments | `/rest/api/2/issue/{key}/comment` | Pagination verified. SIMPL-33846 reports three comments; only two were requested. |
| Issue links | `issuelinks` in issue detail | One link on SIMPL-33846 and eight on SIMPL-22027. |
| Remote links | `/rest/api/2/issue/{key}/remotelink` | Succeeded, with empty lists on both sampled issues. |
| Workflow transitions | `/rest/api/2/issue/{key}/transitions?expand=transitions.fields` | Six transitions on SIMPL-33846 and one on SIMPL-22027. No transitions executed. |
| Editable fields | `/rest/api/2/issue/{key}/editmeta` | 20 fields on SIMPL-33846 and 19 on SIMPL-22027. No updates attempted. |
| Worklog reads | `/rest/api/2/issue/{key}/worklog` | Both samples returned empty worklog collections. Nonempty worklogs remain untested. |
| Field definitions | `/rest/api/2/field` | 249 fields, including 207 custom fields. |
| Reference data | `/issuetype`, `/priority`, `/status`, `/issueLinkType` under `/rest/api/2` | 29 issue types, nine priorities, 93 statuses, and 12 link types. These counts are not SIMPL-specific. |
| Create metadata | `/rest/api/2/issue/createmeta/SIMPL/issuetypes` and `.../10600` | 18 creatable types; field metadata sampled for L0 Requirement. |
| Assignee lookup | `/rest/api/2/user/assignable/search?project=SIMPL&maxResults=1` | One result requested successfully. No directory-wide user export. |
| Attachment configuration | `/rest/api/2/attachment/meta` | Enabled; upload limit 10,485,760 bytes, or 10 MiB. |
| Attachment metadata | `/rest/api/2/search`, attachment field selected | SIMPL-29888 returned metadata for two PNG files. The runtime scopes this verified search route to one issue key; binary download was not attempted. |
| Saved filters | `/rest/api/2/filter/favourite` | Two favorites. Other users' private filters remain outside this result. |
| Dashboards | `/rest/api/2/dashboard?maxResults=5` | Total 191, first five returned. Gadget contents were not inspected. |
| Agile boards | `/rest/agile/1.0/board?maxResults=10` | Total 72, first ten returned. |
| Board configuration and issues | `/rest/agile/1.0/board/{id}/configuration`, `/issue` | Succeeded for Kanban board 172 and Scrum board 183. |
| Sprints | `/rest/agile/1.0/board/183/sprint?state=active,future&maxResults=5` | Five active sprints returned; `isLast=false`, so this is an incomplete page. |

Issue samples were [SIMPL-33846](https://jira.simplprogramme.eu/browse/SIMPL-33846), an Expedite issue in In Progress, and [SIMPL-22027](https://jira.simplprogramme.eu/browse/SIMPL-22027), a Test Execution in Closed. Attachment metadata came from [SIMPL-29888](https://jira.simplprogramme.eu/browse/SIMPL-29888). These identifiers make the observations traceable; statuses and counts can change after this report.

## Permissions differ across projects

This table comes from `/mypermissions?projectKey={key}`. Yes means Jira returned `havePermission=true`. It does not prove that a write will pass workflow validators, field configuration, issue security, or issue-specific restrictions.

| Permission | SIMPL | SCE | SPGRLOG | PSOT | JCS | SC1PLAN |
| --- | --- | --- | --- | --- | --- | --- |
| Browse | Yes | Yes | Yes | Yes | Yes | Yes |
| Create issues | Yes | Yes | Yes | Yes | Yes | No |
| Edit issues | Yes | Yes | Yes | Yes | Yes | No |
| Assign issues | Yes | Yes | Yes | No | No | No |
| Transition issues | Yes | Yes | Yes | Yes | Yes | No |
| Add comments | Yes | Yes | Yes | Yes | Yes | Yes |
| Create attachments | Yes | Yes | Yes | Yes | Yes | Yes |
| Link issues | Yes | Yes | Yes | No | No | No |
| Log work | Yes | Yes | Yes | No | No | Yes |
| Delete issues | No | Yes | Yes | No | No | No |
| Administer project | No | No | No | No | No | No |
| Manage sprints | No | No | No | No | No | No |

`ADMINISTER` and `SYSTEM_ADMIN` are false in the unscoped response. Sprint start/stop and sprint name/goal editing are also denied in SIMPL. Read access to sprints therefore does not imply sprint management access.

The unscoped response reports delete permission, while SIMPL explicitly denies it. Project and issue context must accompany operational permission checks. An additional discrepancy appeared for attachment deletion: SIMPL project-level `DELETE_ALL_ATTACHMENTS` was true, while both final sampled issues reported false. Never use the unscoped response as an authorization grant for a particular issue.

## Custom fields and workflow constraints

These field mappings were observed through `/field`. They describe this installation and should be discovered at runtime instead of copied into server logic.

| Meaning | Observed field ID | Observed schema |
| --- | --- | --- |
| Sprint | `customfield_10105` | Array of strings, GreenHopper sprint custom type |
| Story points | `customfield_10106` | Number |
| Epic link | `customfield_10101` | Plugin-defined `any` schema |
| Epic name | `customfield_10103` | String |

Several display names repeat across custom fields. IDs and schema/plugin identifiers are more reliable than names alone. The API returned description values as strings or null in the sampled issues. There is no evidence here for applying Cloud ADF document schemas to this installation.

Create metadata for L0 Requirement, issue type `10600`, marks `summary`, `project`, `issuetype`, and these custom fields as required:

- `customfield_11412`, Applicability.
- `customfield_11411`, Requirement Type.
- `customfield_11300`, PUBLISHED.

Other issue types can have different requirements. Field defaults and allowed values also need to be read before constructing a create request. For transitions, SIMPL-33846's Cancelled transition exposes `resolution`, `fixVersions`, and `worklog` fields. Transition names, IDs, and accepted fields depend on the issue's workflow and current state.

The embedded changelog returned 14 histories for SIMPL-33846 and 25 for SIMPL-22027. Large-history pagination and a dedicated changelog endpoint were not tested. An MCP response must preserve completeness metadata instead of claiming the entire history is present.

## Capabilities that remain unverified or unavailable

| Area | Evidence | Conclusion |
| --- | --- | --- |
| Global administration | `/rest/api/2/application-properties` returned 403 | This request is denied; administration is outside the proposed server scope. |
| Jira Service Management | `/rest/servicedeskapi/servicedesk?limit=5` returned 302; redirects were refused | Product availability and token access are unknown. |
| Plugin APIs | Field and permission metadata mention test management, Tempo, and scripted fields | Plugin-specific REST access is not established. A Test Execution issue is readable through core Jira. |
| Attachments | Configuration and file metadata succeeded | File download, upload, and deletion remain untested. |
| Writes | Permissions and create/edit/transition metadata succeeded | No create, update, comment, assignment, transition, link, worklog, or delete request was sent. |
| Webhooks and administration | No dedicated endpoint probes | No confirmed access and no proposed initial support. |
| Confluence | No request made | A separate service and `CONFLUENCE_KEY` are required. Jira authentication says nothing about Confluence access. |
| Scale and errors | Small, sequential requests only | No rate-limit, load, timeout, token-expiry, or permission-revocation test. |

Atlassian's [Data Center REST reference](https://developer.atlassian.com/server/jira/platform/rest/v11002/) documents issue, search, comment, attachment, filter, workflow, permission, and Agile API families. Its current default targets a newer Jira release. The version-specific documentation pages did not expose operation details reliably through the documentation reader, so this report uses live responses as evidence of 10.3.25 compatibility. Documented write paths in the plan still require integration testing against this instance.

## Investigation method and retained outcomes

The [evidence JSON](jira-discovery-evidence.json) records the final request URLs, query parameters, timestamps, statuses, counts, and selected permission flags. Private raw responses and their manifest remain under ignored `work/discovery/`. These outcomes support the TypeScript implementation; the temporary Python scripts are no longer part of the repository.

The investigation capped project permission checks at ten projects and sampled the first visible Kanban and Scrum boards from the first ten board results. It did not exhaustively inventory Jira. This prose report is a dated snapshot. Future verification must repeat the relevant requests through TypeScript tooling and review the report against new evidence.
