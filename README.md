# Jira MCP

A local stdio MCP server for one Jira user's personal access token. The runtime targets self-managed Jira REST API v2 installations and exposes read-only tools.

## Run the server

Follow [How to set up the Jira MCP server](docs/setup.md) to build it and pass `JIRA_URL` and `JIRA_KEY` through your MCP host.

The read-only server registers 22 tools for issue research, Agile boards and sprints, change-preparation metadata, worklogs, favorite filters, dashboards, attachment metadata, and bounded issue-field and comment recovery. Attachment-byte retrieval has a bounded implementation but remains unadvertised until live content-route compatibility is verified. Write tools are not registered, and `JIRA_ENABLE_WRITES=true` is rejected until they pass acceptance on a designated test issue.

## Design documents

- [Jira capability report](docs/jira-capability-report.md) records access checked on 2 October 2026.
- [MCP implementation plan](docs/mcp-implementation-plan.md) defines the tool groups and their acceptance gates.
- [MCP architecture](docs/mcp-architecture.md) defines module ownership, request limits, and result contracts.
- [Architecture sketches](docs/architecture/README.md) record the domain schemas and SDK contract.
- [Implementation tasks](docs/implementation-tasks.md) tracks the planned functionality.
- [Discovery evidence](docs/jira-discovery-evidence.json) records request outcomes without issue text or account identities.

Private raw API responses remain in ignored `work/discovery/` files. The temporary Python investigation scripts are not part of the runtime.
