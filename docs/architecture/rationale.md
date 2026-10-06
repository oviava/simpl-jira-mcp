# Jira MCP architecture rationale

## Problem

The server turns verified self-managed Jira reads into MCP operations and may later support explicitly enabled mutations. The current runtime implements a 22-tool read-only catalog, including bounded comment recovery. Mutations await a designated test issue. Attachment-byte retrieval is implemented but remains unadvertised pending live content-route compatibility. Permission scope, incomplete metadata, unknown custom values, and bounded results make a direct endpoint wrapper insufficient. The caller needs complete operations and honest uncertainty.

## Usage

The caller searches `project = EXAMPLE ORDER BY updated DESC`, reads a returned issue key, and continues comment pages using `nextStartAt`. An omitted large field names `jira_read_issue_field` and its revision. An optional update accepts replacement fields and can check `expectedUpdated`. The [usage sketch](usage.ts) records these call sites without exposing authentication, URLs, or Jira wire schemas.

## Shape

Retain `index.ts`, `schemas.ts`, `jira.ts`, and `server.ts`. A concrete `JiraClient` hides request construction, authentication, response parsing, pagination, projection, metadata checks, and mutation dispatch behind methods named for caller operations. The MCP adapter adds validation, descriptions, annotations, protocol encoding, and sanitized failure results. There is no repository interface or tool plugin registry.

Parse at the environment, tool-input, and upstream-response boundaries, per boundary-discipline. Encode scoped access, continuation, and uncertain mutation outcomes as distinct types, per model-the-domain. Keep the runtime within the original four modules until implementation justifies a split, per laziness-protocol. The [contract sketch](contracts.ts) and [input schemas](schemas.ts) make these choices reviewable.

The interface is deep because one method finishes a Jira operation. Callers retain domain choices such as JQL, issue keys, fields, and page offsets. They also see real uncertainty, including hidden issues, partial histories, live page drift, and a mutation with a lost response.

## Synthesis decision

Two independent candidates were produced. Candidate A used a concrete Jira client and MCP adapter with centralized contracts. Candidate B put schemas, response parsing, projection, and handlers in operation groups backed by a shared HTTP capability. These are different ownership models, not variants of one file layout.

Choose A as the base because the current read catalog needs neither an operation registry nor generic registration types. Simplify its five-module map to the plan's four modules by keeping environment parsing in `index.ts`. Adopt B's rule that operation semantics own projection and recovery; the final adapter measures encoded results but cannot trim arbitrary JSON. Adopt A's focused recovery helpers instead of B's window branches, which tied comment identity to a page position.

The architect skill's arena skill and configured runner rule were absent. Candidate A ran on the available `gpt-5.6-sol` with maximum reasoning, and B on `gpt-6.1-sol`. No Claude or Grok review occurred. The comparison used the architect runner prompt, rationale template, and four design red flags directly.

| Red flag | Screening result |
| --- | --- |
| Shallow module | Client methods complete reads or writes, including policy; callers do not coordinate internal stages. |
| Information leakage | Jira wire schemas stay private; SDK context and result encoding stay in the adapter. |
| Temporal decomposition | Modules own Jira knowledge, public schemas, protocol adaptation, or process lifecycle. There are no load/validate/save modules. |
| Pass-through method | The adapter adds MCP validation, annotations, output checks, and error conversion. No second forwarding service exists. |

## Tradeoffs accepted

- Accept a growing concrete method catalog in exchange for explicit signatures and short call traces. Split by Jira capability only when real size warrants it.
- Accept two additional recovery reads and local catalog paging in exchange for making the plan's size limits usable. Single values above the upstream byte cap still fail explicitly.
- Accept refetching and live page drift in exchange for no persistent cache or shared snapshot lifecycle. Revision checks protect text reconstruction only.
- Accept best-effort write preflight and reconciliation in exchange for no database or durable deduplication. Never claim atomic edits or exactly-once mutation execution.

## Alternatives considered

Operation-owned groups are viable, but require a typed registration mechanism and expose request construction to every group. Their benefit does not justify that extra shape for the first catalog. Reconsider if later operations cease to fit coherent client methods.

A generic `jira_request` tool exposes URL paths, wire formats, pagination, and safety policy to the model. A generated Jira client exposes unverified endpoint coverage and still leaves the caller coordinating operation policy. Both hide less of the caller's real work than the selected client.

## Open questions and risks

- The pinned toolchain compiles the first runtime release and its official-client tests verify modern and legacy stdio behavior. Node 24 and the intended MCP host remain untested.
- Does the installation support direct comment-by-ID retrieval, and which changelog fields establish completeness? Verify them before advertising those guarantees.
- Which designated issues cover each mutation's permissions, required custom fields, and workflow validators? Write execution remains unverified.
- Which attachment MIME and origin cases can fit the final MCP result without redirects? Keep byte retrieval deferred until those checks pass.

## Next implementation step

Select a designated test issue or project before implementing and testing write operations. Keep attachment bytes unadvertised until the live content route and access behavior under the configured installation path are verified.
