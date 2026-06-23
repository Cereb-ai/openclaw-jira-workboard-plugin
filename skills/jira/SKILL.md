---
name: jira
description: OpenClaw jira 云原生插件. 9 个 named tools (jira_search / jira_get / jira_comment / jira_transition / jira_create_task / jira_create_subtask / jira_submit_verdict / jira_abandon_task / jira_request_help). 触发词:
metadata:
  {
    "openclaw": { "emoji": "🎫" },
  }
---

# Jira Plugin Skill

> 插件暴露 9 个 named tools，每个 tool 对应一个 Jira Cloud REST v3 method。agent 直接调 named tool 即可，不需要 dispatcher 包装。comment / create_task / create_subtask / submit_verdict / abandon_task / request_help 内部完成多步 Jira API 调用，agent 不需要自行组合。

---

## 调用形态

**OpenClaw 原生 tool** (agent 默认) — 直接调 named tool:

```json
jira_search { jql: "project = WTO AND status != Done" }
jira_get { issueIdOrKey: "WTO-71" }
jira_create_task { project: "WTO", summary: "...", requirements: "...", scope: "...", acceptance_criteria: ["..."] }
```

**CLI 二进制** (OpenCode / 终端 / CI):

```bash
jira-tool search '{"jql":"project = WTO AND status != Done"}'
jira-tool get '{"issueIdOrKey":"WTO-71"}'
jira-tool create_task '{"project":"WTO","summary":"...","requirements":"...","scope":"...","acceptance_criteria":["..."]}'
jira-tool submit_verdict '{"issueIdOrKey":"WTO-100","verdict":"PASS","summary":"done"}'
```

命令退出码: `0`=成功, `5`=业务错误, `2`=JSON 解析错, `1`=无参数.

---

## 9 tool 速查

### 通用 (4)

| tool | 用途 | 必填 | 常用选填 |
|---|---|---|---|
| `jira_search` | JQL 搜索 (默认 30 条) | `jql` | `maxResults`, `fields` |
| `jira_get` | 读单 ticket 详情 | `issueIdOrKey` | `fields` |
| `jira_comment` | 给 ticket 加评论 (ADF dict body) | `issueIdOrKey`, `body` | `mentionMap` |
| `jira_transition` | 转 ticket 状态 (按目标状态名) | `issueIdOrKey`, `targetStatus` | — |

### 原子任务操作 (5)

| tool | 用途 | 必填 | 常用选填 |
|---|---|---|---|
| `jira_create_task` | 建主任务 (锁定模板 + `plan` label + assignee) | `project`, `summary`, `requirements`, `scope`, `acceptance_criteria` | `labels` |
| `jira_create_subtask` | 建子任务 (锁定模板 + label + assignee + 可选 block) | `project`, `parent`, `summary`, `requirements`, `scope`, `acceptance_criteria`, `labels` | `block` |
| `jira_submit_verdict` | 提交判定: PASS 转「已完成」; FAIL 加 `escalated` label + 清 assignee | `issueIdOrKey`, `verdict` (PASS\|FAIL), `summary` | `reason` (FAIL 必填), `evidence` |
| `jira_abandon_task` | 重新规划时废弃子任务 (评论 + 清 assignee + 转「已完成」) | `issueIdOrKey`, `reason` | — |
| `jira_request_help` | 主任务卡住找人 (评论 + `wait-approval` label + 清 assignee) | `issueIdOrKey`, `question` | — |

---

## 调用示例

### 场景 1: 查 main 任务状态
```
jira_get { issueIdOrKey: "SSSS-241" }
```

### 场景 2: plan agent 写 Phase 计划评论
```
jira_comment { issueIdOrKey: "SSSS-241", body: {
  version: 1,
  type: "doc",
  content: [
    {type: "heading", attrs: {level: 2}, content: [{type: "text", text: "Phase 拆解"}]},
    {type: "bulletList", content: [
      {type: "listItem", content: [{type: "paragraph", content: [{type: "text", text: "P1: 修 Save 持久化"}]}]},
      {type: "listItem", content: [{type: "paragraph", content: [{type: "text", text: "P2: 接入 v3 auth"}]}]}
    ]}
  ]
}}
```

### 场景 3: plan agent 建主任务
```
jira_create_task { project: "WTO", summary: "...", requirements: "...", scope: "✅ 代码\n❌ 部署", acceptance_criteria: ["..."] }
```

### 场景 4: 子任务 PASS
```
jira_submit_verdict { issueIdOrKey: "WTO-100", verdict: "PASS", summary: "code 完成, 5/5 tests pass" }
```

### 场景 5: 子任务 FAIL (外部阻塞)
```
jira_submit_verdict { issueIdOrKey: "WTO-100", verdict: "FAIL", summary: "blocked on X", reason: "X 系统升级, 预计明天恢复" }
```

### 场景 6: 重新规划 → 废弃子任务
```
jira_abandon_task { issueIdOrKey: "WTO-100", reason: "主任务重新规划, 改用代码分析路径" }
```

### 场景 7: 主任务卡住 → 找人
```
jira_request_help { issueIdOrKey: "SSSS-50", question: "需要确认 ABC 的优先级" }
```

### 场景 8: 手动转状态
```
jira_transition { issueIdOrKey: "WTO-100", targetStatus: "已完成" }
```

---

## 避坑清单

1. **`comment.body` 必 ADF dict**: `{version:1, type:"doc", content:[{type:"paragraph", content:[{type:"text", text:"..."}]}]}`. 字符串 body 不支持.
2. **`submit_verdict.verdict` 必为 `PASS` 或 `FAIL`**: 其他值 → fail-fast. reason 必填 (FAIL 时).
3. **`request_help` 仅主任务**: 子任务请用 `submit_verdict({verdict:"FAIL", reason})`. (会返清晰错误并指明替代方案)
4. **`abandon_task` 仅子任务**: 主任务请用 `submit_verdict({verdict:"FAIL"})` 或 `request_help`.
5. **`@mention` 用 ADF `mention` 节点 + `mentionMap`**: plugin 强校验 ADF mentions 和 map 的双射 (mentionMap 省略或 `{}` → 不做校验).
6. **`transition` 用状态名不是 button label**: 例如 SSSS 项目用 "已完成" (状态名) 不是 "Done" (button label). 不确定时 `jira_get` 看当前 status, 或 `jira_transition` 返错时会列可用 transitions. Plugin 返错格式: "Available transitions (label → destination): To Do → 待办, In Progress → 正在进行, Done → 已完成".

---

## 配置 (env)

| env | required | default | 说明 |
|---|---|---|---|
| `ATST_TOKEN` | ✅ | — | OAuth 2.0 3LO access token (Bearer 头) |
| `JIRA_CLOUD_ID` | ✅ | — | Atlassian Cloud ID (UUID) |
| `JIRA_PROXY` | ❌ | `http://172.29.176.1:7890` | HTTP 代理 |

任一 required env 未设 → 启动时 fail-fast 返清晰错误，不静默退化。

openclaw.json 的 `plugins.entries.jira-openclaw-plugin.config` 字段 (atstToken / cloudId / proxy) 优先于 env 变量（用于本地 dev override）。
