# @cereb/jira-openclaw-plugin

OpenClaw native plugin for Jira Cloud REST API v3. Single dispatcher tool `jira`
exposes 9 methods: `search` / `get` / `comment` / `create_task` / `create_subtask` /
`submit_verdict` / `abandon_task` / `request_help` / `transition`.

Replaces the `mcporter call atlassian.*` channel with a native agent tool. Reads
`ATST_TOKEN` / `JIRA_CLOUD_ID` / `JIRA_PROXY` from environment.

## 9 methods

| method | 用途 | 必填 |
|---|---|---|
| `search` | JQL 搜索 (默认 30 条) | `jql` |
| `get` | 读单 ticket 详情 | `issueIdOrKey` |
| `comment` | 给 ticket 加评论 (ADF dict) | `issueIdOrKey`, `body` |
| `create_task` | 建主任务（锁定模板 + `plan` label + assignee） | `project`, `summary`, `requirements`, `scope`, `acceptance_criteria` |
| `create_subtask` | 建子任务（锁定模板 + label + assignee + 可选 block） | `project`, `parent`, `summary`, `requirements`, `scope`, `acceptance_criteria`, `labels` |
| `submit_verdict` | 提交判定：`verdict=PASS` 评论 + 转「已完成」；`verdict=FAIL` 评论 + `escalated` label + 清 assignee | `issueIdOrKey`, `verdict` (PASS\|FAIL), `summary`, `reason` (FAIL 必填) |
| `abandon_task` | 重新规划时废弃子任务（仅子任务） | `issueIdOrKey`, `reason` |
| `request_help` | 主任务卡住找人（仅主任务，wait-approval label） | `issueIdOrKey`, `question` |
| `transition` | 转 ticket 状态（按目标状态名） | `issueIdOrKey`, `targetStatus` |

## 两条调用路径

**OpenClaw 原生 tool `jira`** (agent 默认):

```json
jira { method: "search", args: { jql: "project = WTO AND status != Done" } }
```

**独立 CLI `jira-tool`** (OpenCode / 终端 / CI):

```bash
jira-tool search '{"jql":"project = WTO AND status != Done"}'
jira-tool get '{"issueIdOrKey":"WTO-71"}'
```

完整方法说明 + 避坑清单：`skills/jira/SKILL.md`

## 配置 (env)

| env | required | default | 说明 |
|---|---|---|---|
| `ATST_TOKEN` | ✅ | — | OAuth 2.0 3LO access token (Bearer 头) |
| `JIRA_CLOUD_ID` | ✅ | — | Atlassian Cloud ID (UUID) |
| `JIRA_PROXY` | ❌ | `http://172.29.176.1:7890` | HTTP 代理 |

任一 required env 未设 → 启动时 fail-fast 返清晰错误，不静默退化。

## 构建

```bash
npm install
npm run typecheck
npm run build
npm test
```

`openclaw` 是 peer dependency (dev install 拉 latest)，运行时 openclaw 通过 `peerDependenciesMeta.optional` 自动跳过。
