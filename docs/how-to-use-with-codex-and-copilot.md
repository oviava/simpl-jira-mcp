# Connect Jira MCP to Codex or GitHub Copilot

This guide connects the local Jira MCP server to Codex or GitHub Copilot in VS Code. The server targets self-managed Jira Server or Data Center. It does not claim support for Jira Cloud.

## 1. Build the server

Clone this repository, then run these commands from its folder:

```sh
npm ci
npm run build
```

The MCP host needs Node.js 24 or newer and the absolute path to `dist/index.js`.

## 2. Create a Jira personal access token

In Jira, open **User > Profile > Personal access tokens**. Select **Create token**, give it a name, and choose an expiry if Jira offers one. Copy the token when Jira shows it. Jira will not show the value again after you close the dialog.

The token has the same Jira permissions as your user. Use an account that can read only the projects and issues you need. Keep the token private, and revoke it from the Personal access tokens page if it is exposed or no longer needed. See Atlassian's [personal access token guide](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html).

You also need the base URL for your Jira installation, for example `https://jira.example.com`. Include any installation path if your Jira URL has one.

## 3. Add it to Codex

Codex can run the server as a local standard input/output process. Open `~/.codex/config.toml` and add:

```toml
[mcp_servers.jira]
command = "node"
args = ["/absolute/path/to/jira-mcp/dist/index.js"]

[mcp_servers.jira.env]
JIRA_URL = "https://jira.example.com"
JIRA_KEY = "paste-your-personal-access-token-here"
JIRA_ENABLE_WRITES = "false"
```

This puts the token in your local Codex configuration file as plain text. Do not put it in a project file or commit it. Restrict access to `~/.codex/config.toml`, and avoid syncing or sharing that file. If you use a secret manager, remove the `JIRA_KEY` line and allow the `JIRA_KEY` environment variable with `env_vars = ["JIRA_KEY"]` instead. Start Codex in an environment that provides the token. If you use a Codex interface with an MCP server settings form, add the same command, argument, and environment values there.

Restart Codex after changing the configuration. Use `/mcp` in the Codex CLI to check that the Jira server connected.

## 4. Add it to GitHub Copilot in VS Code

Create or edit `.vscode/mcp.json`. This configuration asks for the token and lets VS Code store it as a secret:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "jira-key",
      "description": "Jira personal access token",
      "password": true
    }
  ],
  "servers": {
    "jira": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/index.js"],
      "env": {
        "JIRA_URL": "https://jira.example.com",
        "JIRA_KEY": "${input:jira-key}",
        "JIRA_ENABLE_WRITES": "false"
      }
    }
  }
}
```

Open the project in VS Code, approve the Jira server when prompted, then restart it from the MCP server controls. In Copilot Chat, use **Configure Tools** to check that Jira tools are available. VS Code's [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) describes secret input variables.

This example is for local VS Code sessions. If you use Copilot's remote Agent Host, configure secrets in a way that host supports. VS Code does not forward interactive input variables to that host.

## 5. Keep writes disabled

Leave `JIRA_ENABLE_WRITES` set to `false`. This release provides read-only tools. It has no Jira write tools. If you set `JIRA_ENABLE_WRITES=true`, the server refuses to start.

## Disclaimer

The MCP server reads Jira data using the configured user's permissions. Codex or Copilot may send data returned by Jira to the AI service that powers your session. Follow your organization's Jira, privacy, and AI usage rules. Review the tools and server configuration before connecting an account with access to sensitive projects.

The read-only design limits actions exposed through this server, but it does not change the token's Jira permissions or prevent the AI host from processing data the server returns. This guide is not a security review or a guarantee that every Jira deployment behaves the same way.

## References

- [Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [VS Code MCP server setup](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
- [Atlassian personal access tokens](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)
