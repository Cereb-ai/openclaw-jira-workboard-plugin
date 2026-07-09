# @cereb/jira-openclaw-plugin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.5.1-blue.svg)](package.json)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-%3E%3D2026.5.17-purple.svg)](https://docs.openclaw.ai)

OpenClaw native plugin for Jira Cloud REST API v3 — exposes 14 named tools (one per Jira REST method), each invocable directly from an OpenClaw agent or the bundled `jira-tool` CLI. Replaces the legacy `mcporter call atlassian.*` channel.

## Features

- **14 named tools** for Jira Cloud REST v3 — search, get, comment (list / get / post), attachments (list / get / upload), transitions, create task / subtask, submit verdict, abandon, request help.
- **Two invocation paths** — call as an OpenClaw named tool, or use the bundled `jira-tool` CLI from OpenCode, a terminal, or CI.
- **Fail-fast on missing config** — clear error messages, never silent fallback.
- **Orchestrator-friendly** — `jira_create_task` / `jira_create_subtask` auto-format ADF `description` and lock the `plan` label; `jira_submit_verdict` atomically posts the verdict and transitions the ticket.
- **ADF round-tripping** — `jira_comment.body` is plain text (auto-wrapped to ADF); `jira_list_comments` / `jira_get_comment` outputs are plain text (auto-unwrapped from ADF).

## Tools

| tool | purpose | required args |
|---|---|---|
| `jira_search` | JQL search (default 30) | `jql` |
| `jira_get` | read single ticket (whitelisted fields, default excludes comment/worklog) | `issueIdOrKey` |
| `jira_list_comments` | list all comments (ADF → plain text + mentions) | `issueIdOrKey` |
| `jira_get_comment` | read one comment (ADF → plain text + mentions) | `issueIdOrKey`, `commentId` |
| `jira_comment` | post a comment (plain-text `body`, auto-wrapped to ADF) | `issueIdOrKey`, `body` |
| `jira_list_attachments` | list attachment metadata for a ticket | `issueIdOrKey` |
| `jira_get_attachment` | download one attachment's bytes | `attachmentId` |
| `jira_upload_attachment` | upload a file to a ticket | `issueIdOrKey`, `file` |
| `jira_transition` | transition ticket by target status (logical name) | `issueIdOrKey`, `targetStatus` |
| `jira_create_task` | create main task (locked template + `plan` label + assignee) | `project`, `summary`, `requirements`, `scope`, `acceptance_criteria` |
| `jira_create_subtask` | create subtask (locked template + label + assignee) | `project`, `parent`, `summary`, `requirements`, `scope`, `acceptance_criteria`, `labels` |
| `jira_submit_verdict` | submit PASS/FAIL verdict (atomic: post comment + transition) | `issueIdOrKey`, `verdict`, `summary` |
| `jira_abandon_task` | abandon a subtask during re-planning | `issueIdOrKey`, `reason` |
| `jira_request_help` | escalate main task to a human | `issueIdOrKey`, `question` |

Per-tool argument schemas, ADF builder guide, and the 避坑清单 live in [`skills/jira/SKILL.md`](skills/jira/SKILL.md).

## Installation

### From local source (development)

```bash
git clone https://github.com/Cereb-ai/openclaw-jira-workboard-plugin.git
cd openclaw-jira-workboard-plugin
npm install
npm run build
npm pack
openclaw plugins install "npm-pack:./$(ls cereb-jira-openclaw-plugin-*.tgz | head -1)" --force
systemctl --user restart openclaw-gateway.service   # required to load the new plugin
```

### From npm (once published)

```bash
npm install -g @cereb/jira-openclaw-plugin
openclaw plugins install "@cereb/jira-openclaw-plugin"
systemctl --user restart openclaw-gateway.service
```

## Configuration

The plugin reads config in this order (highest priority first):

1. `plugins.entries.jira-openclaw-plugin.config` in `~/.openclaw/openclaw.json`
2. Environment variables (`ATST_TOKEN`, `JIRA_CLOUD_ID`, `JIRA_PROXY`)

### `~/.openclaw/openclaw.json`

```json
{
  "plugins": {
    "entries": {
      "jira-openclaw-plugin": {
        "enabled": true,
        "config": {
          "atstToken": "<OAuth 2.0 3LO access token>",
          "cloudId": "<Atlassian Cloud ID (UUID)>",
          "proxy": "<HTTP proxy URL (optional)>"
        }
      }
    }
  }
}
```

### Environment variables

| variable | required | default | description |
|---|---|---|---|
| `ATST_TOKEN` | ✅ | — | OAuth 2.0 3LO access token (Bearer header) |
| `JIRA_CLOUD_ID` | ✅ | — | Atlassian Cloud ID (UUID) |
| `JIRA_PROXY` | ❌ | (none — direct connection) | HTTP proxy URL (e.g. `http://proxy.example.com:8080`) |

Any missing required variable → fail-fast at startup with an actionable error pointing at the missing field.

## Usage

**OpenClaw native tool** (default for agents):

```json
jira_search { jql: "project = WTO AND status != Done" }
jira_get { issueIdOrKey: "WTO-71" }
```

**Standalone CLI** `jira-tool` (for OpenCode, terminal, CI):

```bash
jira-tool search '{"jql":"project = WTO AND status != Done"}'
jira-tool get '{"issueIdOrKey":"WTO-71"}'
jira-tool submit_verdict '{"issueIdOrKey":"WTO-100","verdict":"PASS","summary":"done"}'
```

Exit codes: `0` = success, `5` = business error, `2` = JSON parse error, `1` = missing args.

## Development

```bash
npm install
npm run typecheck        # tsc --noEmit
npm run build            # tsc -p tsconfig.json
npm test                 # vitest run
```

Validate the plugin manifest after `src/index.ts` changes:

```bash
npx openclaw plugins build --entry ./dist/index.js
npx openclaw plugins validate --entry ./dist/index.js
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for code structure, how to add a new tool, and PR guidelines.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and PR workflow.

## License

[MIT](LICENSE) © 2026 Leo Wang / Cereb

## Links

- **Repository**: https://github.com/Cereb-ai/openclaw-jira-workboard-plugin
- **Issues**: https://github.com/Cereb-ai/openclaw-jira-workboard-plugin/issues
- **OpenClaw docs**: https://docs.openclaw.ai