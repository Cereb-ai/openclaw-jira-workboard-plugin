---
name: jira
description: OpenClaw jira 云原生插件. 提供两条调用路径:
  1) OpenClaw 原生 tool `jira` (agent 默认)
  2) 独立 CLI `jira-tool` (OpenCode / 任意 shell, 不依赖 OpenClaw)
  10 个 method: 3 只读 (search/get/comment) + 6 原子任务操作 (create_task/create_subtask/complete_task/escalate_task/abandon_task/request_help) + 1 通用操作 (transition). 触发词: "找 WTO-XXX"、"读 ticket"、"给 ticket 加评论"、"建主任务/子任务"、"完成任务"、"升级/废弃子任务"、"找人帮助"、"转状态".
metadata:
  {
    "openclaw": { "emoji": "🎫" },
  }
---

# Jira Plugin Skill (0.3.1)

> 插件暴露 10 个 method，其中 6 个是原子任务操作——每个 method 内部完成多步 Jira API 调用，agent 不需要自行组合底层操作。`comment` 是只读/轻写 method，用于给 ticket 加评论（Phase 计划、进度同步等），不走 6 个原子模板。`transition` 是通用状态流转 method，pipeline 内部使用，agent 一般不需手动调。

---

## 调用形态

**结构化** (agent 默认, 优先):
```json
jira { "method": "search", "args": { "jql": "project = WTO AND status != Done" } }
```

**字符串** (兼容 wecom_mcp 习惯):
```json
jira { "call": "search {\"jql\":\"project = WTO\"}" }
```

**扁平** (简写):
```json
jira { "method": "search", "jql": "project = WTO" }
```

**CLI 二进制** (OpenCode / 终端 / CI):
```bash
jira-tool search '{"jql":"project = WTO AND status != Done"}'
jira-tool get '{"issueIdOrKey":"WTO-71"}'
```
命令退出码: `0`=成功, `5`=业务错误, `2`=JSON 解析错, `1`=无参数.

---

## 10 method 速查 (0.3.1)

### 只读 (3)

| method | 用途 | 必填 | 常用选填 |
|---|---|---|---|
| `search` | JQL 搜索 (默认 30 条) | `jql` | `maxResults`, `fields` |
| `get` | 读单 ticket 详情 | `issueIdOrKey` | `fields` |
| `comment` | 给 ticket 加评论 (ADF, 支持 @mention) | `issueIdOrKey`, `body` | `visibility`, `adf` |

### 原子任务操作 (6)

| method | 谁调 | 用途 | 必填 | 选填 |
|---|---|---|---|---|
| `create_task` | plan agent | 建主任务（锁定模板 + `plan` label + assignee） | `project`, `summary`, `requirements`, **`scope`**, `acceptance_criteria` | `labels` |
| `create_subtask` | plan agent | 建子任务（锁定模板 + label + assignee + 可选 block） | `project`, `parent`, `summary`, `requirements`, **`scope`**, `acceptance_criteria`, `labels` | `block` |
| `complete_task` | 主/子 agent | 任务完成（评论 verdict + 转「已完成」） | `issueIdOrKey`, `verdict`, `summary` |
| `escalate_task` | 子任务 agent | 子任务做不了升级（评论 + `escalated` label + 清 assignee） | `issueIdOrKey`, `reason` |
| `abandon_task` | plan agent | 重新规划时废弃子任务（评论 + 清 assignee + 转「已完成」） | `issueIdOrKey`, `reason` |
| `request_help` | plan agent | 主任务卡住找人（评论 + `wait-approval` label + 清 assignee） | `issueIdOrKey`, `question` |

> `create_subtask` / `create_task` **`scope` 参数 (string, 必填)**:
> 按 label 写 ✅ 负责 / ❌ 不负责。code: "✅ 写代码、跑测试、提 PR\n❌ 不部署（kubectl/gcloud/Cloud Build）、不 merge、不 review"
> review: "✅ 审查 PR 代码改动、APPROVED 后 merge 到 dev\n❌ 不改代码、不部署"
> test: "✅ 测试验证、出报告\n❌ 不修代码、不部署"
> ops: "✅ 部署/配置/环境排查\n❌ 不改业务代码"
> analyze: "✅ 代码分析、定位问题、出报告\n❌ 不修代码、不部署"
>
> ⚠️ **0.3.3+ scope 改必填**：未传 `scope` 或传空串 → create_task / create_subtask 返回
> 错误 `create_X requires scope (string, non-empty)`。主任务 + 子任务 description 都会
> 渲染 `## 职责范围` 节，缺失视为模板违反。
> `create_subtask` 可选 `block` 参数: `{ blocks: ["WTO-97"], blockedBy: ["WTO-95"] }`
> `complete_task` 可选 `evidence` 参数（string，证据/截图路径）

### 通用操作 (1)

| method | 谁调 | 用途 | 必填 |
|---|---|---|---|
| `transition` | pipeline / agent | 转 ticket 状态（按目标状态名） | `issueIdOrKey`, `targetStatus` |

> `targetStatus` 用状态名（如 `In Progress` / `Done` / `已完成`），不是 transition button 上的文字。

---

## 场景

### 场景 1: 搜索 + 读取

```
1. jira { method: "search", args: { jql: "project = WTO AND status != Done ORDER BY updated DESC", maxResults: 10 } }
2. jira { method: "get", args: { issueIdOrKey: "WTO-110" } }
```

### 场景 2: 建主任务并开始规划

```
1. jira { method: "create_task", args: {
     project: "WTO",
     summary: "Opp. Score 模块 E2E 测试",
     requirements: "对 WTO 商机评分模块的 7 个 AC 进行端到端自动化测试",
     scope: "✅ 测试验证、出报告\n❌ 不修代码、不部署",
     acceptance_criteria: ["AC-001 ~ AC-007 全部 PASS", "截图 + 测试结果上传 Outline"]
   } }
// → 自动: plan label + assignee + ADF description (含 ## 职责范围)
```

### 场景 3: 拆解规划 → 建子任务 (含 scope + block 依赖)

```
1. jira { method: "create_subtask", args: {
     project: "WTO",
     parent: "WTO-99",
     summary: "修复 Configuration Save 持久化",
     requirements: "配置保存后 close+reopen 值未持久化",
     scope: "✅ 写代码、跑测试、提 PR\n❌ 不部署、不 merge、不 review",
     acceptance_criteria: ["w1 改为 0.7 后 close+reopen 仍为 0.7"],
     labels: ["code"],
     block: { blockedBy: ["WTO-95"] }
   } }
// scope 按 label 选择对应的职责文本
```

### 场景 4: 子任务完成

```
1. jira { method: "complete_task", args: {
     issueIdOrKey: "WTO-100",
     verdict: "PASS",
     summary: "frontend 3 处代码改动生效，AC-007 Save 持久化通过",
     evidence: "screenshots/opp-score-ac007/06-reopen-config-modal.png"
   } }
// verdict: PASS | FAIL | BLOCKED
```

### 场景 5: 子任务做不了 → 升级

```
1. jira { method: "escalate_task", args: {
     issueIdOrKey: "WTO-95",
     reason: "auth center 代码需要 Leo 介入，非当前 agent 能力范围"
   } }
// → 评论 + escalated label + 清 assignee
```

### 场景 6: 主任务卡住 → 找人

```
1. jira { method: "request_help", args: {
     issueIdOrKey: "WTO-94",
     question: "admin2 登录 401，需要确认 dev 端 v3 auth API schema 是否变更"
   } }
// → 评论 + wait-approval label + 清 assignee → pipeline 跳过 → 人等回复后手动移除 label → 下一轮自动接管
```

### 场景 7: 重新规划 → 废弃子任务

```
1. jira { method: "abandon_task", args: {
     issueIdOrKey: "WTO-96",
     reason: "主任务重新规划，DB 直查方向不再需要，改用代码分析路径"
   } }
// → 评论 + 清 assignee + 转「已完成」
```

### 场景 8: plan agent 写 Phase 计划评论

```
1. jira { method: "comment", args: {
     issueIdOrKey: "WTO-99",
     body: "## Phase 拆解\n- P1: 修 Save 持久化 (WTO-100)\n- P2: 接入 v3 auth (依赖 P1)\n- P3: E2E 回归",
     adf: true
   } }
// → ADF 文档评论，不改状态/labels/assignee
```

---

## ⚠️ 避坑清单

1. **`complete_task.verdict` 必须是 `PASS` / `FAIL` / `BLOCKED` 之一**，其他值 → fail-fast.

2. **`escalate_task` / `abandon_task` 只能作用于子任务**，传主任务 key → fail-fast 返清晰错误.

3. **`request_help` 后 pipeline 自动跳过该 ticket**（含 `wait-approval` label）。人处理完后**手动移除 `wait-approval`**，下一轮 cron 自动接管——不需要 agent 调 method.

4. **`comment` body 是 ADF JSON 时传 `adf: true`**，否则按 wiki markup 渲染;`@mention` 需要 ADF `mention` 节点 + `accountId`.

5. **未设 `ATST_TOKEN` / `JIRA_CLOUD_ID` env → fail-fast** 返清晰错误，不会静默退化.

6. **未设 `JIRA_PROXY` → 用默认 `http://172.29.176.1:7890`**（不报错）.

---

## 配置

| env | 必填 | 默认 | 说明 |
|---|---|---|---|
| `ATST_TOKEN` | ✅ | — | OAuth 2.0 3LO access token |
| `JIRA_CLOUD_ID` | ✅ | — | Atlassian Cloud ID (UUID) |
| `JIRA_PROXY` | ❌ | `http://172.29.176.1:7890` | HTTP 代理 URL |

---

## 统一路径原则

**所有 Jira 操作走 `jira` native tool 的 10 个 method**，agent 不自行组合底层 REST API。

| 任务 | 用什么 |
|---|---|
| 找 ticket | `jira {method:'search', args:{jql:'...'}}` |
| 读 ticket | `jira {method:'get', args:{issueIdOrKey:'WTO-70'}}` |
| 加评论 | `jira {method:'comment', args:{issueIdOrKey:'WTO-70', body:'...', adf:true}}` |
| 建主任务 | `jira {method:'create_task', args:{...}}` |
| 建子任务 | `jira {method:'create_subtask', args:{...}}` |
| 完成任务 | `jira {method:'complete_task', args:{...}}` |
| 升级子任务 | `jira {method:'escalate_task', args:{...}}` |
| 废弃子任务 | `jira {method:'abandon_task', args:{...}}` |
| 找人帮助 | `jira {method:'request_help', args:{...}}` |
| 转状态 | `jira {method:'transition', args:{issueIdOrKey:'WTO-70', targetStatus:'已完成'}}` |

> **CLI 替代**: `jira-tool <method> '<args-json>'`

---

## 相关链接

- **项目目录**: `~/dev/projects/jira-openclaw-plugin`
- **Atlassian Cloud REST API v3**: https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/

---

## 贡献指南

加新 method 时:
1. `src/handlers/<name>.ts` 写 handler
2. `src/dispatch.ts` 加 `MVP_METHODS` + `switch` case
3. `skills/jira/SKILL.md` 速查表 + 场景 + 避坑清单同步更新
4. 跑: `npm run typecheck && npm run build && npm pack`
