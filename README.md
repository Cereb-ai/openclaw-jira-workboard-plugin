# @cereb/jira-openclaw-plugin

OpenClaw native plugin for Jira Cloud REST API v3. Single dispatcher tool `jira`
exposes 6 methods (MVP 0.1.0): `search` / `get` / `create` / `update` / `comment`
/ `transition`.

Replaces the `mcporter call atlassian.*` channel with a native agent tool. Reads
`ATST_TOKEN` / `JIRA_CLOUD_ID` / `JIRA_PROXY` from environment (no mcporter
dependency).

## 配置 (env)

| env | required | default | 说明 |
|---|---|---|---|
| `ATST_TOKEN` | ✅ | — | OAuth 2.0 3LO access token (Bearer 头) |
| `JIRA_CLOUD_ID` | ✅ | — | Atlassian Cloud ID (UUID) |
| `JIRA_PROXY` | ❌ | `http://172.29.176.1:7890` | HTTP 代理 |

任一 required env 未设 → 启动时 fail-fast 返清晰错误，不静默退化。

详见 `skills/jira/SKILL.md`。

## 端到端 (5 步闭环)

```bash
npm install
npm run typecheck
npm run build
npm pack
openclaw plugins install "npm-pack:./cereb-jira-openclaw-plugin-0.1.0.tgz"
# 之后需 Leo 在本地 pty 重启 gateway:
# systemctl --user restart openclaw-gateway.service
```

## MVP 6 method

| method | REST | 必填 |
|---|---|---|
| `search` | `GET /rest/api/3/search` | `jql` |
| `get` | `GET /rest/api/3/issue/{key}` | `issueIdOrKey` |
| `create` | `POST /rest/api/3/issue` | `project`, `issuetype`, `summary` |
| `update` | `PUT /rest/api/3/issue/{key}` | `issueIdOrKey`, `fields` |
| `comment` | `POST /rest/api/3/issue/{key}/comment` | `issueIdOrKey`, `body` (ADF) |
| `transition` | `GET+POST /rest/api/3/issue/{key}/transitions` | `issueIdOrKey`, `targetStatus` |

## 不在 MVP (留 0.2.0)

- `add_label` / `remove_label` / `block`
- `property_get` / `property_set` / `property_del`
- Confluence method
- OAuth token refresh 流程 (Leo 用的是 long-lived ATST)

## 安全

- ❌ 不写 token 原文到任何文件 / log / commit
- ❌ 不读 `mcporter.json` / `openclaw.json` / `installs.json`
- ✅ 只从 `process.env.ATST_TOKEN` 读
