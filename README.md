# @cereb/jira-openclaw-plugin

OpenClaw native plugin for Jira Cloud REST API v3. 9 named tools via `defineToolPlugin` (OpenClaw 0.5.17+). Replaces the `mcporter call atlassian.*` channel.

## 9 tools

| tool | 用途 | 必填 |
|---|---|---|
| `jira_search` | JQL 搜索 (默认 30 条) | `jql` |
| `jira_get` | 读单 ticket 详情 | `issueIdOrKey` |
| `jira_comment` | 给 ticket 加评论 (ADF dict) | `issueIdOrKey`, `body` |
| `jira_transition` | 转 ticket 状态 (按目标状态名) | `issueIdOrKey`, `targetStatus` |
| `jira_create_task` | 建主任务 (锁定模板 + `plan` label + assignee) | `project`, `summary`, `requirements`, `scope`, `acceptance_criteria` |
| `jira_create_subtask` | 建子任务 (锁定模板 + label + assignee) | `project`, `parent`, `summary`, `requirements`, `scope`, `acceptance_criteria`, `labels` |
| `jira_submit_verdict` | 提交判定 (PASS/FAIL) | `issueIdOrKey`, `verdict`, `summary` |
| `jira_abandon_task` | 重新规划时废弃子任务 | `issueIdOrKey`, `reason` |
| `jira_request_help` | 主任务卡住找人 | `issueIdOrKey`, `question` |

## 两条调用路径

**OpenClaw 原生 tool** (agent 默认) — 直接调 named tool:

```json
jira_search { jql: "project = WTO AND status != Done" }
jira_get { issueIdOrKey: "WTO-71" }
```

**独立 CLI `jira-tool`** (OpenCode / 终端 / CI):

```bash
jira-tool search '{"jql":"project = WTO AND status != Done"}'
jira-tool get '{"issueIdOrKey":"WTO-71"}'
jira-tool submit_verdict '{"issueIdOrKey":"WTO-100","verdict":"PASS","summary":"done"}'
```

完整方法说明 + 避坑清单: `skills/jira/SKILL.md`

## 配置 (env)

| env | required | default | 说明 |
|---|---|---|---|
| `ATST_TOKEN` | ✅ | — | OAuth 2.0 3LO access token (Bearer 头) |
| `JIRA_CLOUD_ID` | ✅ | — | Atlassian Cloud ID (UUID) |
| `JIRA_PROXY` | ❌ | `http://172.29.176.1:7890` | HTTP 代理 |

openclaw.json 的 `plugins.entries.jira-openclaw-plugin.config` 字段 (atstToken / cloudId / proxy) 优先于 env 变量（用于本地 dev override）。

任一 required env 未设 → 启动时 fail-fast 返清晰错误，不静默退化。

## 构建 + 验证

```bash
npm install
npm run typecheck
npm run build
openclaw plugins build --entry ./dist/index.js   # 生成 openclaw.plugin.json
openclaw plugins validate --entry ./dist/index.js
npm test
```

`openclaw` 是 peer dependency (dev install 拉 latest)，运行时 openclaw 通过 `peerDependenciesMeta.optional` 自动跳过。
