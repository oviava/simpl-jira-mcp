# How to set up the Jira MCP server

Build the local server and pass its Jira connection settings through your MCP host.

## Requirements

- Node.js 24 or newer.
- An HTTPS URL for a self-managed Jira installation.
- A Jira personal access token with permission to read the projects and issues you need.

## Install dependencies and build

From the repository root, run:

```sh
npm ci
npm run build
```

The build creates `dist/index.js`.

## Configure the MCP host

Set `JIRA_URL` and `JIRA_KEY` in the host's environment for the server process. Keep the token in the host's secret store or environment manager. Do not commit it to this repository.

Configure the host to run Node with the absolute path to `dist/index.js`. For example:

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["/absolute/path/to/jira-mcp/dist/index.js"]
    }
  }
}
```

The server reads `JIRA_URL` and `JIRA_KEY` from its process environment. `JIRA_URL` must use HTTPS and may include an installation path. The server sends `JIRA_KEY` only as a bearer token to that Jira host.

## Keep writes disabled

The current release has no write tools. Leave `JIRA_ENABLE_WRITES` unset or set it to `false`. If you set it to `true`, startup fails with an explanatory error.

## Check the architecture files

Run `npm run check:architecture` to check the source sketches, tool catalog, local links, and retained evidence. Run `npm run build` to type-check and compile the runtime.
