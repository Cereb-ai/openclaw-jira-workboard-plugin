---
name: jira
description: OpenClaw jira 云原生插件. 14 个 named tools (jira_search / jira_get / jira_list_comments / jira_get_comment / jira_comment / jira_list_attachments / jira_get_attachment / **jira_upload_attachment** / jira_transition / jira_create_task / jira_create_subtask / jira_submit_verdict / jira_abandon_task / jira_request_help). 触发词: 查评论 / 看评论 / 读评论 / 评论列表 / 列出评论 / list comments / get comment / 附件 / attachment / 上传附件 / upload
metadata:
  {
    "openclaw": { "emoji": "🎫" },
  }
---

# Jira Plugin Skill

> 插件暴露 14 个 named tools，每个 tool 对应一个 Jira Cloud REST v3 method。agent 直接调 named tool 即可，不需要 dispatcher 包装。comment / create_task / create_subtask / submit_verdict / abandon_task / request_help 内部完成多步 Jira API 调用，agent 不需要自行组合。**upload_attachment 是 0.5.1 新增**，替代之前用裸 curl + ATST_TOKEN 上传的 workaround。

---

## 调用形态（两种 agent，方法名 100% 对齐）

**路径 A — OpenClaw 原生 agent（含 cereb-pilot 等）**：直接调 named MCP 工具，无需包装：

```json
jira_search { jql: "project = <project-key> AND status != Done" }
jira_get { issueIdOrKey: "<issue-key>" }
jira_create_task { project: "WTO", summary: "...", requirements: "...", scope: "...", acceptance_criteria: "..." }
jira_upload_attachment { issueIdOrKey: "<issue-key>", filePath: "/path/to/x.png" }
```

**路径 B — 非 OpenClaw 原生 agent（codex 等，无 MCP 工具暴露）**：用 `jira-tool` 二进制。**方法名与 MCP 100% 对齐**——`jira_*` 全名和短名（search/get/comment/...）都接受，参数与 MCP 工具完全一致：

```bash
jira-tool jira_search '{"jql":"project = <project-key> AND status != Done"}'
jira-tool jira_get '{"issueIdOrKey":"<issue-key>"}'
jira-tool jira_create_task '{"project":"WTO","summary":"...","requirements":"...","scope":"...","acceptance_criteria":"..."}'
jira-tool jira_submit_verdict '{"issueIdOrKey":"<issue-key>","verdict":"PASS","summary":"done"}'
jira-tool jira_upload_attachment '{"issueIdOrKey":"<issue-key>","filePath":"/path/to/x.png"}'
# 短名同样可用（向后兼容）：
jira-tool search '{"jql":"project = <project-key> AND status != Done"}'
jira-tool get '{"issueIdOrKey":"<issue-key>"}'
# --help 打印方法列表
jira-tool --help
```

> ⚠️ **方法名必须用 MCP 名（`jira_*`）或短名**，两者都能直接调用。不要拼 `jira-tool jira` 之类的名字（无此方法）。CLI 只有 14 个方法，与 MCP 工具一一对应。

命令退出码: `0`=成功, `5`=业务错误, `2`=JSON 解析错, `1`=无参数.

> ✅ **CLI 无需设任何 env**：token / cloudId 从 `~/.openclaw/openclaw.json` 的 `plugins.entries.jira-openclaw-plugin.config` 读取（env `ATST_TOKEN` 只是兜底层级）。**排查 CLI 问题不要往 env 方向猜**（容器注入的是 `JIRA_ATST_TOKEN`，CLI 不读这个名字，但也不影响 —— 走 openclaw.json 兜底即可工作）。

> ⚠️ **CLI 输出是插件包裹格式**：stdout 为 `{"content":[{"type":"text","text":"<真 JSON 字符串>"}]}` —— **真 JSON 在 `content[0].text` 里，需解包两次**才能取字段：
>
> ```bash
> jira-tool get '{"issueIdOrKey":"CP-1"}' | python3 -c "import json,sys;d=json.load(sys.stdin);d=json.loads(d['content'][0]['text']);print(d['issue']['fields']['summary'])"
> ```
>
> 直接用 `json.load` 只看顶层会拿到包裹壳（不是票数据）—— 这是最常见的“结果全 0 / 字段取不到”误判来源。

> ⚠️ **JQL 检索坑**：本租户 JQL **不认 issue type 中文名**（`issuetype = 子任务` 返回 0）。找某票的子任务用 **`parent = <KEY>`**（已验证可用）；不确定连通性时先用 `key = <KEY>` 验证。

> **`jira_create_task` / `jira_create_subtask` 的 `requirements` / `scope` / `acceptance_criteria` 3 字段全是纯文本字符串, 不是 ADF dict, 不是数组.** plugin 自动按 `## 任务说明 / ## 职责范围 / ## 验收标准` 3 段拼接成 description. 用 `\n` 换行.
>
> **`jira_comment` 的 `body` 也是纯文本 string, 不是 ADF dict.** plugin 自动包成 ADF. 用 `\n` 换行. **agent 永远不需要知道 ADF**.

---

## 14 tool 速查

### 通用 (9)

| tool | 用途 | 必填 | 常用选填 |
|---|---|---|---|
| `jira_search` | JQL 搜索 (默认 30 条) | `jql` | `maxResults`, `fields` |
| `jira_get` | 读单 ticket 详情 (默认走白名单, 含 attachment 最新 5 个) | `issueIdOrKey` | `fields` |
| `jira_list_comments` | 拉 ticket 全部评论 (ADF → 纯文本 + mentions) | `issueIdOrKey` | `startAt`, `maxResults` (≤100), `orderBy`, `since` (ISO date, 客户端 filter), `authorAccountId` (客户端 filter) |
| `jira_get_comment` | 读单条评论 (ADF → 纯文本 + mentions) | `issueIdOrKey`, `commentId` | — |
| `jira_comment` | 给 ticket 加评论 (**纯文本 string**) | `issueIdOrKey`, `body` (string) | `mentionAccountIds` (string[] of accountIds) |
| `jira_list_attachments` | 列 ticket 所有附件 metadata (无 cap) | `issueIdOrKey` | — |
| `jira_get_attachment` | 下载附件二进制到本地 (默认 `/tmp/openclaw-attachments/{id}.{ext}`) | `attachmentId` | `saveToPath` (绝对路径) |
| **`jira_upload_attachment`** | **上传单个文件到 ticket (server-side read, 无需 base64 编码)** | `issueIdOrKey`, `filePath` (绝对路径) | — |
| `jira_transition` | 转 ticket 状态 (**逻辑名**，项目无关) | `issueIdOrKey`, `targetStatus` (逻辑名) | — |

### 原子任务操作 (5)

| tool | 用途 | 必填 | 常用选填 |
|---|---|---|---|
| `jira_create_task` | 建主任务 (labels 不传 → 默认 `['plan']`；传了 → 原样使用) | `project`, `summary`, `requirements`, `scope`, `acceptance_criteria` | `labels` |
| `jira_create_subtask` | 建子任务 (labels 必填，无默认; + assignee + 可选 block) | `project`, `parent`, `summary`, `requirements`, `scope`, `acceptance_criteria`, `labels` | `block` |
| `jira_submit_verdict` | 提交判定: PASS 转「已完成」; FAIL 加 `escalated` label + 清 assignee | `issueIdOrKey`, `verdict` (PASS\|FAIL), `summary` | `reason` (FAIL 必填), `evidence` |
| `jira_abandon_task` | 重新规划时废弃子任务 (评论 + 清 assignee + 转「已完成」) | `issueIdOrKey`, `reason` | — |
| `jira_request_help` | 主任务卡住找人 (评论 + `wait-approval` label; orchestrator 仍为 owner, **不清 assignee**) | `issueIdOrKey`, `question` | `mention` + `mentionDisplayName` (任一传需成对) |

---

## 调用示例

### 场景 1: 查 main 任务状态
```
jira_get { issueIdOrKey: "<issue-key>" }
```

### 场景 2: agent 写评论 (**纯文本，plugin 自动转 ADF**)

```
// 简单评论
jira_comment { issueIdOrKey: "<issue-key>", body: "✅ Phase 1 完成，3/3 AC 验证通过" }

// 多行评论（\n 转 hardBreak）
jira_comment { issueIdOrKey: "<issue-key>", body: "第一行\n第二行\n第三行" }

// 带 @mention
jira_comment {
  issueIdOrKey: "<issue-key>",
  body: "请看一下这边的审批进度",
  mentionAccountIds: ["5faab81caea468006ab5e23e"]
}
```

> **agent 只写 plain text，ADF 全部由 plugin 内部生成**. 不再需要 ADF dict 任何知识.

### 场景 3: plan agent 建主任务
```
jira_create_task {
  project: "WTO",
  summary: "迁移 auth 模块到 v3",
  requirements: "Why: 旧 auth 即将 EOL\n\n## What\n\n- 替换 client 调 v3 endpoint\n- 改 token refresh 逻辑",
  scope: "✅ 规划\n✅ 改 SKILL.md\n❌ 不改协议",
  acceptance_criteria: "AC1: 5/5 单测过\nAC2: 集成环境无 401\nAC3: SKILL.md 已更新"
}
```

> 3 字段 (requirements / scope / acceptance_criteria) **全是纯文本字符串**, 不是 ADF dict, 不是数组. 用 `\n` 换行. plugin 把 3 段拼成 `## 任务说明 / ## 职责范围 / ## 验收标准` description.

### 场景 4: 子任务 PASS
```
jira_submit_verdict { issueIdOrKey: "<issue-key>", verdict: "PASS", summary: "code 完成, 5/5 tests pass" }
```

### 场景 5: 子任务 FAIL (外部阻塞)
```
jira_submit_verdict { issueIdOrKey: "<issue-key>", verdict: "FAIL", summary: "blocked on X", reason: "X 系统升级, 预计明天恢复" }
```

### 场景 6: 重新规划 → 废弃子任务
```
jira_abandon_task { issueIdOrKey: "<issue-key>", reason: "主任务重新规划, 改用代码分析路径" }
```

### 场景 7: 主任务卡住 → 找人
```
jira_request_help { issueIdOrKey: "<issue-key>", question: "需要确认 ABC 的优先级" }
```

### 场景 8: 手动转状态 (**逻辑名，跨项目通用**)

```
// 项目无关的逻辑名（推荐）
jira_transition { issueIdOrKey: "<issue-key>", targetStatus: "in_progress" }  // → 任意项目"进行中"
jira_transition { issueIdOrKey: "CP-1",    targetStatus: "done" }         // → SSSS 的 已完成 / CP 的 complete
jira_transition { issueIdOrKey: "CP-1",    targetStatus: "review" }       // → Review / 审查 / In Review
jira_transition { issueIdOrKey: "CP-1",    targetStatus: "blocked" }      // → 任意 Block* 状态
jira_transition { issueIdOrKey: "CP-1",    targetStatus: "reopen" }       // → Reopen / 重新打开

// 项目特有名字（last-resort fallback）
jira_transition { issueIdOrKey: "CP-1",    targetStatus: "In Review" }     // 精确匹配
```

**支持的逻辑名**: `todo` / `in_progress` / `done` / `review` / `blocked` / `reopen` / `cancelled` / `open` / `backlog` / `doing` / `active` / `closed` / `complete` / `completed` / `resolved` / `cancel`

### 场景 9: 上传附件 (0.5.1 新增, 替代裸 curl workaround)

```
// 上传单个文件
jira_upload_attachment { issueIdOrKey: "<issue-key>", filePath: "/path/to/screenshot.png" }

// 上传多个文件 (换 filePath 重复调用即可)
jira_upload_attachment { issueIdOrKey: "<issue-key>", filePath: "/path/to/evidence.png" }
```

**返回结构** (CP-2715 batch 4 精简后):
```json
{
  "ok": true,
  "method": "upload_attachment",
  "request": { "issueIdOrKey": "<issue-key>" },
  "count": 1,
  "attachments": [
    { "id": "13428", "filename": "screenshot.png", "size": 12345, "mimeType": "image/png", "content": ".../attachment/content/13428" }
  ]
}
```

**失败返回** (结构化错误):
```json
{ "ok": false, "error": { "status": 404, "message": "file not found: /tmp/missing.png" } }
{ "ok": false, "error": { "status": 413, "message": "file too large (>100MB)" } }
{ "ok": false, "error": { "status": 401, "message": "..." } }
```

**约束**:
- 单文件最大 100MB (Jira 默认上限)
- filePath 必须是 server-side 可读的绝对路径
- 不需要 base64 编码, plugin 用 Node 内置 FormData + Blob 直传
- 不再需要 agent 自己读 `~/.openclaw/openclaw.json` 拿 ATST_TOKEN + 拼 multipart 边界

**何时用**: 之前用 `curl -X POST ... -F file=@...` 上传附件的 workaround 全部废弃, 改调 `jira_upload_attachment` 即可。

---

## 上下文优化 (省 context)

3 个工具专门为「减少 LLM context 占用」设计. `jira_get` 默认会向 Atlassian 拉一整个 issue payload — 其中 `comment` 和 `worklog` 子资源动辄 5-50 KB per ticket, 但 agent 多数场景下根本用不到. 这 3 个工具让 agent **按需拉取**, 避免一次拉全.

### `jira_get` 默认白名单 (server-side fields whitelist)

```json
jira_get { issueIdOrKey: "<issue-key>" }
```

默认不带任何参数 → plugin **服务端** 走 `fields` query param 限定白名单 (0.5.0+ 13 个字段, 0.4.x 早期 12 个; 0.5.0 加 `attachment`):

```
summary, status, issuetype, priority, labels,
assignee, reporter, created, updated, parent, description,
issuelinks, attachment
```

白名单**排除** `comment` / `worklog` 等重资源 (`attachment` 已加, 默认 cap 5 条). 实测对比 `*navigable` 默认集, 一个 long-lived ticket 可以从 30+ KB 砍到 1-3 KB.

**为什么走服务端 query 而不是 client-side filter**: Atlassian wire payload 在我们 formatter 跑之前就开始烧 token 了, 客户端裁剪救不了 wire cost. 唯一靠谱的省点是 `fields` query param.

**怎么扩**:
```json
jira_get { issueIdOrKey: "<issue-key>", fields: ["*all"] }                  // 全量 (相当于 *navigable)
jira_get { issueIdOrKey: "<issue-key>", fields: ["customfield_10019"] }     // 单 custom field
jira_get { issueIdOrKey: "<issue-key>", fields: ["summary","status","customfield_10019"] }  // 混搭
```

返回结构不变: `issue.summary` / `issue.status` / `issue.description` (CP-2669 G2: 纯文本, 不是 ADF) / `issue.fields` (curated fields dict, **不含** comment/worklog, 含原始 ADF `description` 字段供需要 raw 的 caller 用).

### `jira_list_comments`

```json
jira_list_comments { issueIdOrKey: "<issue-key>", maxResults: 10, orderBy: "-created" }
jira_list_comments { issueIdOrKey: "<issue-key>", since: "2026-06-15T00:00:00.000+0800", authorAccountId: "712020:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx..." }
```

- 走 `GET /issue/{key}/comment`, **CP-2669 G4** 默认 `maxResults=10` 上限 100, `orderBy="-created"` (最新在前)
- **comment body 自动从 ADF 转纯文本** (heading 渲染成 `## xxx`, bulletList 渲染成 `- xxx`, mention 渲染成 `@displayName`)
- **CP-2669 G3**: 单条 body 超过 500 字符会被截断 + 追加尾部标记 `…[正文已截断, 共 N 字符, 全文用 jira_get_comment {id} 获取]`. 全文用 `jira_get_comment` 单独取.
- 每个 comment 带 `mentions: [{accountId, displayName}]` 列表 — 回答 "谁被 @ 了" 这个高频问题不需要回扫 ADF
- **CP-2669 G5 翻页**: 响应里有 `nextStartAt` 时, 直接拿来当下次的 `startAt` (即 "最后一条偏移 + 1"). 没有 `nextStartAt` = 没有剩余, 翻到末页.
- `since` (可选, ISO date string) — **客户端 filter**: 保留 `created >= since` 的评论. 留空 / 省略 → 不过滤, 不 throw. 非法 ISO string → 软错误. 例: `"2026-06-15"` 或 `"2026-06-15T10:00:00.000+0800"`.
- `authorAccountId` (可选, string) — **客户端 filter**: 保留 `author.accountId` 匹配的评论. 留空 / 省略 → 不过滤, 不 throw. 例: `"712020:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`.
- **CP-2669 G5**: `total` (总评论数) + `returned` (本次过滤后条数) 取代旧 `rawCount` / `count` / `summary{}`.

### `jira_get_comment`

```json
jira_get_comment { issueIdOrKey: "<issue-key>", commentId: "10001" }
```

- 走 `GET /issue/{key}/comment/{id}`, 两个参数都必填 (Atlassian 的 comment id 只在 issue 内唯一)
- 输出 shape 跟 `jira_list_comments` 单条一致: `{id, author, created, body, mentions}`. **CP-2700 batch 2**: 旧 `summary{key, commentId, author, created, bodyChars, mentionCount}` 块去除 (key==request.issueIdOrKey, commentId==comment.id, author==comment.author.displayName, created==comment.created, bodyChars/mentionCount 派生计数 → 与 request/comment 字段全部重复)
- `body` **不截断** — 本工具是 `jira_list_comments` 500-char 截断的全文逃生舱 (description 声明 NEVER truncated); 仍只返回 plain text, 不暴露原始 ADF doc
- `details` = <100 字符一句话语义摘要, 例 `成功获取 CP-2690 评论 22475: 张三 2026-09-06, 正文 1280 字`

### 三者配合的典型 workflow

```text
1. jira_search { jql: "project = <project-key> AND status = 'In Progress'" }
   → 拿到 N 个 ticket key (search 已经走默认 fields, 不付 comment 成本)

2. 对每个 key:
   jira_get { issueIdOrKey: "SSSS-N" }
   → 默认白名单, 不拉 comment / worklog (vs *navigable 省 ~80%)

3. 需要看 description 正文:
   jira_get 返回的 issue.description 已经够用 (默认白名单含 description)

4. 需要看评论历史时 (按需):
   jira_list_comments { issueIdOrKey: "SSSS-N", maxResults: 10 }
   → 纯文本 + mentions, 不付 ADF 成本

5. 某条评论很关键, 想看完整原 ADF:
   → 现阶段没有 raw ADF 工具. 需要的话用 Atlassian UI.
```

---

## 返回字段契约 (CP-2384, 0.5.2+; CP-2669, 0.6.0; CP-2693 batch 1; CP-2700 batch 2; CP-2710 batch 3; CP-2715 batch 4)

14 个高频工具 (jira_get / jira_list_comments / jira_comment / jira_search / jira_create_task / jira_create_subtask / jira_get_comment / jira_list_attachments / jira_get_attachment / jira_upload_attachment / jira_submit_verdict / jira_abandon_task / jira_request_help / jira_transition) 的返回字段做了统一裁剪: **agent 自己传入的请求参数不回显** (key 类标识除外), **产物标识 / 错误原因完整保留**, 反结果反馈 (block 状态 / verdict / 标签状态 / 转态结果) 字段不动. 下表是逐字段契约, 与实现 `src/handlers/*.ts` 逐字段一致.

> **裁剪原则**: 请求回声 (agent 刚发的请求参数原样回显) 视为回声噪声, 裁掉; key 类标识 (issueIdOrKey / jql / parent / accountId 等) 是 agent 标识后续 ticket 的锚, 保留; 服务端产物标识 (issue.key/id/self、comment.id/self/created) 是 agent 后续 follow-up 的依据, 保留; 错误原因 (HTTP status + message) 必须完整保留, 禁止静默.
>
> **CP-2669 G1 + CP-2693 batch 1 + CP-2700 batch 2 + CP-2710 batch 3 + CP-2715 batch 4 全量推广**: `ToolResult.details` (放在 content 之外的那份) 改为 **<100 字符一句话语义摘要**, 不再默认回填全量 `data`. 试点两工具 (jira_get / jira_list_comments) G1 沿用; **CP-2693 batch 1** 把 4 个高频工具 (jira_search / jira_comment / jira_create_task / jira_create_subtask) 显式传入语义摘要; **CP-2700 batch 2** 把 2 个只读查询工具 (jira_get_comment / jira_list_attachments) 显式传入语义摘要; **CP-2710 batch 3** 把 4 个状态机写工具 (jira_submit_verdict / jira_abandon_task / jira_request_help / jira_transition) 显式传入语义摘要; **CP-2715 batch 4** 把 2 个附件传输工具 (jira_get_attachment / jira_upload_attachment) 显式传入语义摘要 — 至此 14 个高频工具 (jira_get / jira_list_comments / jira_search / jira_comment / jira_create_task / jira_create_subtask / jira_get_comment / jira_list_attachments / jira_get_attachment / jira_upload_attachment / jira_submit_verdict / jira_abandon_task / jira_request_help / jira_transition) 全部推广完成. 摘要样例:
> - jira_get 成功: `"成功获取 CP-2667: 标题, N 附件"`
> - jira_list_comments 成功: `"CP-2667 共 25 条评论, 本次返回 10 条 (→10 翻页)"`
> - jira_search 成功: `"JQL 命中 12 票, 本次返回 3 票"`
> - jira_comment 成功: `"已评论 CP-2690: 评论 22475 发布成功"`
> - jira_create_task 成功: `"成功创建主任务 CP-2691: <summary 前截断>"`
> - jira_create_subtask 成功: `"成功创建子任务 CP-2695 (父 CP-2690): <summary 前截断>"`
> - jira_get_comment 成功 (CP-2700 batch 2): `"成功获取 CP-2690 评论 22475: 张三 2026-09-06, 正文 1280 字"`
> - jira_list_attachments 成功 (CP-2700 batch 2): `"CP-2690 共 5 个附件, 总大小 2.3 MB"` / `"CP-2700 无附件"`
> - jira_transition 成功 (CP-2710 batch 3): `"CP-2690 已转至「已完成」 (done category 匹配)"`
> - jira_submit_verdict PASS (CP-2710 batch 3): `"CP-2690 已 PASS: 评论已发 + 转「已完成」"`
> - jira_submit_verdict FAIL (CP-2710 batch 3): `"CP-2690 已 FAIL: escalated 已标 + assignee 已清"`
> - jira_abandon_task 成功 (CP-2710 batch 3): `"CP-2690 子任务已废弃: 评论 + 清 assignee + 转「已完成」+ 清 escalated"`
> - jira_request_help 成功 (CP-2710 batch 3): `"CP-2690 主任务已问人: 评论已发 + wait-approval 标签已加"` / `"... + @提及 张三"`
> - jira_get_attachment 成功 (CP-2715 batch 4): `"附件 12345 (hello.txt) 已下载, 11 字节"`
> - jira_upload_attachment 成功 (CP-2715 batch 4): `"已上传 screenshot.png (12345 字节) 至 SSSS-454"`
> - 状态机 partial (CP-2710 batch 3): `"CP-2690 部分完成: 评论已发但转态失败, 见 hint"`
> - 错误 (全部高频工具): `"<tool_name> 失败: HTTP <status> <statusText>"` / `"<tool_name> 失败: <原因>"`
>
> **CP-2693 batch 1 — 回声裁剪 + summary 去重推进**: `jira_create_task` 同步 `jira_create_subtask` 模式 (`request: {fields}` → `{project, summary, labels}`); `jira_comment` 旧 `summary{key, commentId, url}` 块去除; `jira_create_subtask` 旧顶层 `parent` 与 `summary{key, id, url, parent}` 块去除.
> **CP-2700 batch 2 — 只读查询补全 + 附件 compact**: `jira_get_comment` 旧 `summary{key, commentId, author, created, bodyChars, mentionCount}` 块去除 (6 个字段全部与 request/comment 重复), `body` **保留全文不截断** (本工具是 list_comments 500-char 截断的全文逃生舱). `jira_list_attachments` 每项 compact 对齐 `get.ts:109` compactAttachment 模式 (去 author.avatarUrls/active/timeZone/locale/accountType/emailAddress/self; 每项省 ~600B), 旧 `summary{key, attachmentCount}` 块去除 (count == attachments.length == summary.attachmentCount 三重复, 仅留 count). **no-cap 语义不动** (本工具是 jira_get cap 5 的全量列举逃生舱).
> **CP-2710 batch 3 — 状态机写工具 4 件套精简**: `jira_transition` 旧 `summary{key, to, toCategory, matchedBy}` 块去除 (4 字段全部与 transition 块重复), `matchedBy` 合并进 `transition{}` 块 (L103 vs L114 同值双份消除), `request.targetStatus` / `request.resolvedBy` 回声去除 (仅留 `request.issueIdOrKey` 锚). 无匹配 error + hint「Available transitions」完整保留. `jira_submit_verdict` PASS 分支顶层 `verdict:"PASS"` 补齐 (旧仅 FAIL 顶层有, PASS 只在 summary 内), 旧 `summary{key, verdict, commentId, transitionedTo, toCategory}` 块去除; FAIL 成功路径 `hint` 字段去除 (语义冗余于 label 反馈, v0.5 草稿池定); FAIL 顶层 verdict 保留. `jira_abandon_task` 旧 `summary{key, commentId, assigneeCleared, transitionedTo, labelsRemoved, labels, labelsRemoveError}` 块去除 (`labels` 数组回声裁, `labelsRemoved` 布尔 + `labelsRemoveError` 字符串保留), top-level `comment` / `assigneeCleared` / `labelsRemoved` / `labelsRemoveError` / `transition` 全保留 (状态机写). `jira_request_help` 旧 `summary{key, commentId, label, mentioned}` 块去除 (4 字段全部与顶层 label/method/comment 重复), `mentioned` 字段从 summary 移出至顶层 (`accountId | null`, **红线 #28510** accountId 保留). 4 工具 partial 分支结构 0 改动 (CP-2710 红线 #28510). 详见各工具小节.
> **CP-2715 batch 4 — 附件传输 2 件套精简 (12 工具推广收口)**: `jira_get_attachment` 旧 `summary{attachmentId, path, size, mimeType, filename}` 块去除 (5 字段 100% 与顶层 `path` / `size` / `mimeType` / `filename` 重复), `request.saveToPath` 回声去除 (agent 刚传, 最终落盘路径由顶层 `path` 给出, 含默认 `/tmp/openclaw-attachments/{id}.{ext}` 推导值). 错误路径 `{error}` 契约 0 改动 (L75/L83/L96/L100/L116/L130/L155 9 个 textResult 调用点全部加 details 第二参). `jira_upload_attachment` 旧 `summary{issueIdOrKey, filePath, filename, size, attachmentCount}` 块去除 (5 字段全部与 request / 顶层 / attachments 重复; `filePath` 全路径重复 2 次可上百字符, 体积最大冗余), `request.filePath` / `size` / `filename` 回声去除 (仅留 `request.issueIdOrKey` 锚); `attachments` 数组逐项显式 pick 5 字段 (`id` / `filename` / `size` / `mimeType` / `content`), 防止 Atlassian 原始项 `author` / `created` / `self` / `thumbnail` 等混入; `attachmentCount` 由派生 `count: items.length` 替换; 错误对象 `{ok:false, error:{status,message}}` 与 synthetic status (404 missing file / 413 oversize / 500 misc) 语义完整保留. 2 工具 17 个 textResult 调用点 (get 9 + upload 8) 全部双参且 `details` <100 字符. **CP-2714 非阻塞 suggestion ① L278 头部枚举 off-by-one 修正**: 旧「11 个高频工具」与括号枚举 12 个不一致 → 本批统一为 14 个 (12 工具推广完成, 工具数与 description 14 named tools 对齐). 详见各工具小节.

### `jira_get` 返回契约

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"get"` | 方法名 |
| `request.issueIdOrKey` | `string` | 唯一保留的请求回声 |
| `issue.key` | `string` | ticket key (e.g. `CP-2384`) |
| `issue.id` | `string` | Atlassian 内部 id |
| `issue.summary` | `string` | ticket 标题 |
| `issue.status` | `string` | 状态名 |
| `issue.issuetype` | `string` | 类型名 |
| `issue.priority` | `string?` | 优先级 |
| `issue.labels` | `string[]` | 标签 |
| `issue.assignee` | `string \| null` | assignee 显示名 (displayName) |
| `issue.reporter` | `string \| null` | reporter 显示名 (displayName) |
| `issue.created` | `string` | 创建时间 |
| `issue.updated` | `string` | 最近更新时间 |
| `issue.parent` | `{key, summary} \| null` | 父 ticket 标识 (subtask 时有) |
| `issue.issuelinks` | `{blocks, blockedBy}` | **CP-2384 新 shape**: 见下 |
| `issue.description` | `string \| null` | **CP-2669 G2**: 纯文本 (adfToPlainText), **不是 ADF doc**; 原始 ADF 仍可通过 `issue.fields.description` 读取 |
| `issue.attachments[]` | `attachment[]` | 最近 5 个附件 metadata |
| `issue.attachmentCount` | `number` | 总附件数 |
| `issue.moreCount?` | `number` | 超出 5 cap 的剩余数 |
| `issue.fields` | `object` | 原始 fields 字典 (callers 想 drill in 用 `fields:['*all']` 拿全量) |

**`issue.issuelinks` 结构 (CP-2384 AC1)**:

```json
{
  "blocks": [{ "key": "CP-100", "statusCategory": "In Progress" }],
  "blockedBy": [{ "key": "CP-50", "statusCategory": "Done" }]
}
```

- `blocks`: 本 ticket **堵住**的下游 ticket (即本 ticket 是 blocker). 原 API 用 `outwardIssue` 表示.
- `blockedBy`: 堵住本 ticket 的上游 ticket. 原 API 用 `inwardIssue` 表示.
- 每个 link 项: `{key, statusCategory}` 仅 2 字段 (≤50 字符 JSON/项). `statusCategory` 来自关联票 `status.statusCategory.name` ("To Do" / "In Progress" / "Done" — 平台级 taxonomy, **display name 随实例 locale 本地化**, 项目无关). Cereb Jira 中文 locale 实测返回 "待办" / "正在进行" / "完成"; 英文 locale 返回 "To Do" / "In Progress" / "Done". 调用方做状态过滤需按本实例实测值匹配, 不要硬编码英文名.
- 关联类型不属于 "blocks" 的 (Duplicate / Relates / Clones 之类) **静默丢弃**; 要拿原 shape 调 `jira_get { fields: ['*all'] }` 然后读 `fields.issuelinks`.

**CP-2669 G6 details 摘要样例**: `"成功获取 CP-2667: [标题], 3 附件"` (附件数=0 时省略 "N 附件" 段).

### `jira_list_comments` 返回契约 (CP-2669 G5 精简后)

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"list_comments"` | 方法名 |
| `request.issueIdOrKey` | `string` | 唯一保留的请求回声 |
| `total` | `number` | ticket 总评论数 (Atlassian 上游字段) |
| `returned` | `number` | 本次过滤后实际返回条数 (含 since / authorAccountId 客户端 filter) |
| `nextStartAt?` | `number` | **CP-2669 G5**: 仅当仍有剩余评论时出现; 翻页 cursor = 上次最后一条偏移 + 1, 直接作为下一次 startAt 传入 |
| `comments[]` | `comment[]` | 见下 |

**字段精简 (CP-2669 G5)**:
- ❌ 移除 `startAt` / `maxResults` / `rawCount` / `count` / 整个 `summary{}` 嵌套 (回声 / 重复计数 / 过滤参数 全部砍掉 — agent 已知道自己传了什么)
- ✅ 仅留 `total` / `returned` 两个数字: `total` 让 LLM 判断 "票上还有多少我没看", `returned` 让 LLM 判断 "这次拿到几条". `nextStartAt` 翻页 cursor 出现条件: 仍有剩余 (`startAt + maxResults < total`)

**`comments[]` 每条结构**:

| 字段 | 类型 |
|---|---|
| `id` | `string` |
| `author` | `{displayName, accountId} \| null` |
| `created` | `string` |
| `updated` | `string` |
| `body` | `string` (纯文本, **不是 ADF**; **CP-2669 G3**: > 500 字符截断 + 尾部 `…[正文已截断, 共 N 字符, 全文用 jira_get_comment {id} 获取]` 标记) |
| `mentions[]` | `{accountId, displayName}[]` (deduped) |

**CP-2669 G3 body 截断说明**: 单条 comment body > 500 字符时, 截断到 500 字符 + 追加尾部标记 (N = 截断前字符数). 全文用 `jira_get_comment {issueIdOrKey} {commentId}` 单独取.

**CP-2669 G4 默认值变更**: `maxResults` 默认 20 → **10** (旧 50 → 20 → 10). 上限仍 100.

**CP-2669 G6 details 摘要样例**:
- 有剩余: `"CP-2667 共 25 条评论, 本次返回 10 条 (→10 翻页)"`
- 无剩余: `"CP-2667 共 8 条评论, 本次返回 8 条"`

### `jira_comment` 返回契约 (CP-2693 batch 1 精简后)

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"comment"` | 方法名 |
| `request.issueIdOrKey` | `string` | 唯一保留的 key-class 请求回声 |
| `request.mentions` | `string[]` | mentionAccountIds (key-class, 保留) |
| `request.bodyChars` | `number` | 原 body 字符数 (不含正文) |
| `comment.id` | `string` | 新建评论 id |
| `comment.self` | `string` | 评论 REST URL |
| `comment.created` | `string` | 评论创建时间 |

**CP-2384 反断言**: **不回显** body 原文 (`request.body` 字段不存在); 错误路径 (`error`) 完整保留 HTTP status / message. `bodyChars` 让 agent 自检长度但不回显原文.

**CP-2693 batch 1**: 旧 `summary{key, commentId, url}` 块去除 (key/commentId/url 都与 request.issueIdOrKey / comment.id / comment.self 重复, 按 v0.5 草稿池落地). `details` = <100 字符一句话摘要, 例 `已评论 CP-2690: 评论 22475 发布成功`.

### `jira_search` 返回契约 (CP-2693 batch 1 fields silent-drop 修正)

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"search"` | 方法名 |
| `request.jql` | `string` | 唯一保留的请求回声 |
| `total` | `number` | JQL 命中总数 (Atlassian 端) |
| `count` | `number` | 本次返回条数 |
| `issues[]` | `issue[]` | 见下 |

**`issues[]` 每条结构 (固定 8 字段白名单)**:

| 字段 | 类型 | 备注 |
|---|---|---|
| `key` | `string` | |
| `id` | `string` | |
| `summary` | `string` | |
| `status` | `string` | 状态名 |
| `issuetype` | `string` | |
| `labels` | `string[]` | |
| `created` | `string` | |
| `parent` | `string?` | parent key (subtask 时) |

**CP-2384 说明**: 默认 `fields` **去掉** `issuelinks` (search callers 一般只需要 triage 元数据, issuelinks 留给 `jira_get` 按需拉); 请求回声只留 `jql`, 砍 `maxResults` / `fields` 字段.

**CP-2693 batch 1 — `fields` silent-drop 修正**: `fields` 参数**仅用于服务端收窄拉取** (降 wire token); 显式传白名单外字段 (如 `["description"]` / `["customfield_*"]`) **不会**扩展返回 — formatIssues 固定只输出 8 字段. 需要 description / customfield_* 等白名单外字段 → 调 `jira_get { fields: [...] }` 单票逃生舱. `details` = <100 字符一句话摘要, 例 `JQL 命中 12 票, 本次返回 3 票`.

### `jira_create_task` 返回契约 (CP-2693 batch 1 新增)

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"create_task"` | 方法名 |
| `request.project` | `string` | 项目 key |
| `request.summary` | `string` | 主任务标题 |
| `request.labels` | `string[]` | 实际生效 labels (含自动加的 `plan`) |
| `issue.id` | `string` | 新建主任务 Atlassian id |
| `issue.key` | `string` | 新建主任务 key |
| `issue.self` | `string` | 新建主任务 REST URL |
| `block?` | `[{direction, keys}]` | 0.5.2+ block 计划 (有传 `block` 时) |
| `block_errors?` | `string[]` | 0.5.2+ block 失败列表 |

**CP-2693 batch 1**: `request: {fields}` 全量回声去除 (12 工具单点最大冗余 — 含 `buildTaskDescription` 渲染的 ADF description 1-3KB+, 完全就是 agent 自己的输入 bounce back). 对齐 `create_subtask` CP-2384 已拍板模式, 只留 key 类 `project` / `summary` / `labels`. 旧 `summary{key, id, url}` 块去除 (`issue{key, id, self}` 已覆盖). **`block` / `block_errors` 结果反馈完整保留** — CP-2384 反断言. `details` = <100 字符一句话摘要, 例 `成功创建主任务 CP-2691: <summary 前截断>`.

### `jira_create_subtask` 返回契约 (CP-2693 batch 1 精简后)

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"create_subtask"` | 方法名 |
| `request.parent` | `string` | 父 ticket key |
| `request.summary` | `string` | 本 subtask 标题 |
| `request.labels` | `string[]` | 本 subtask labels |
| `issue.id` | `string` | 新建 subtask 的 Atlassian id |
| `issue.key` | `string` | 新建 subtask 的 key |
| `issue.self` | `string` | 新建 subtask 的 REST URL |
| `block?` | `[{direction, keys}]` | 0.3.1+ block 计划 (有传 `block` 时) |
| `block_errors?` | `string[]` | 0.3.1+ block 失败列表 |

**CP-2384 说明**: 请求回声从 `request: {fields: <full ADF>}` 砍到 `{parent, summary, labels}` 3 字段, requirements / scope / acceptance_criteria 全文不再回显. **block 反馈 (`block` / `block_errors`) 完整保留** — CP-2384 不裁结果反馈.

**CP-2693 batch 1**: 旧顶层 `parent` 与 `summary{key, id, url, parent}` 块去除 (与 `request.parent` / `issue{key, id, self}` 重复), 与 `create_task` 同构收敛, 留 `request.parent` 为锚. `details` = <100 字符一句话摘要, 例 `成功创建子任务 CP-2695 (父 CP-2690): <summary 前截断>`.

### `jira_get_comment` 返回契约 (CP-2700 batch 2 精简后)

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"get_comment"` | 方法名 |
| `request.issueIdOrKey` | `string` | 唯一保留的 key-class 请求回声 |
| `request.commentId` | `string` | 唯一保留的 key-class 请求回声 (参数原值, 数字字符串) |
| `comment.id` | `string` | Atlassian 评论 id |
| `comment.author` | `{displayName, accountId} \| null` | 作者 (displayName + accountId, **红线 #28510**: accountId 不删) |
| `comment.created` | `string` | 创建时间 |
| `comment.updated` | `string` | 最近更新时间 |
| `comment.body` | `string` | **CP-2700 batch 2**: **NEVER truncated** (本工具是 `jira_list_comments` 500-char 截断的全文逃生舱); 纯文本 (非 ADF) |
| `comment.mentions[]` | `{accountId, displayName}[]` | comment 内 @mention 列表 (deduped) |

**CP-2700 batch 2**: 旧 `summary{key, commentId, author, created, bodyChars, mentionCount}` 块去除 (6 个字段全部与 `request` / `comment` 字段重复, 按 v0.5 §description 草稿池白名单建议落地). `body` 故意保留全文不截断 — 截断逻辑归 `jira_list_comments` (500-char cap), agent 拿到截断尾标 → 用 `jira_get_comment {issueIdOrKey, commentId}` 单独取完整正文 (这正是本工具的设计目的). `details` = <100 字符一句话摘要, 例 `成功获取 CP-2690 评论 22475: 张三 2026-09-06, 正文 1280 字`.

### `jira_list_attachments` 返回契约 (CP-2700 batch 2 新增)

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"list_attachments"` | 方法名 |
| `request.issueIdOrKey` | `string` | 唯一保留的请求回声 |
| `count` | `number` | 附件总数 (无 cap; = `attachments.length`) |
| `attachments[]` | `attachment[]` | compact 字段集 (见下) |

**`attachments[]` 每项结构 (compact 模式, 对齐 `jira_get.compactAttachment`)**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `string` | Atlassian 附件 id |
| `self` | `string` | REST URL (元数据) |
| `filename` | `string` | 文件名 |
| `size` | `number` | 字节数 |
| `mimeType` | `string` | MIME 类型 |
| `created` | `string` | 上传时间 |
| `content` | `string` | 下载 URL (api.media.atlassian.com, 不含文件字节) |
| `thumbnail` | `string?` | 缩略图 URL |
| `author.displayName` | `string` | 上传者 displayName |
| `author.accountId` | `string` | 上传者 accountId (红线 #28510: 保留) |

**CP-2700 batch 2**: 旧 `summary{key, attachmentCount}` 块去除 (`count` == `attachments.length` == `summary.attachmentCount` 原本就是 3-way 重复). 每项 attachment compact 对齐 `get.ts:109` `compactAttachment` 模式: 去 `author.avatarUrls` / `active` / `timeZone` / `locale` / `accountType` / `emailAddress` / `self` (~600B/att), `author` 仅留 `{displayName, accountId}`. **no-cap 语义不动** — 本工具是 `jira_get` 5-attachment cap 的全量列举逃生舱, 想要完整列表 (例如 "找上周的截图") 直接调本工具, 不需要翻页 / startAt. `details` = <100 字符一句话摘要, 例 `CP-2690 共 5 个附件, 总大小 2.3 MB` / `CP-2700 无附件`.

### `jira_transition` 返回契约 (CP-2710 batch 3 精简后)

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"transition"` | 方法名 |
| `request.issueIdOrKey` | `string` | 唯一保留的 key-class 请求回声 |
| `transition.id` | `string` | Atlassian transition id |
| `transition.name` | `string` | transition 显示名 (e.g. "Done") |
| `transition.to` | `string` | 目标 status 名 (e.g. "已完成") |
| `transition.category` | `string` | 目标 statusCategory.key (e.g. "done") |
| `transition.matchedBy` | `"category" \| "business-pattern" \| "exact-name"` | **CP-2710 batch 3**: 合并自旧 `summary.matchedBy` (L103 vs L114 同值双份消除) |

**CP-2710 batch 3**: 旧 `summary{key, to, toCategory, matchedBy}` 块去除 (4 字段全部与 `transition{}` 块重复); `matchedBy` 合并进 `transition{}` 块; `request.targetStatus` / `request.resolvedBy` 回声去除 (仅留 `request.issueIdOrKey` 锚). 无匹配 error + hint「Available transitions」完整保留 (CP-2710 红线 #28510: 错误信息不静默). `details` = <100 字符一句话摘要, 例 `CP-2690 已转至「已完成」 (done category 匹配)`.

### `jira_submit_verdict` 返回契约 (CP-2710 batch 3 精简后)

**成功 (PASS)**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"submit_verdict"` | 方法名 |
| `verdict` | `"PASS"` | **CP-2710 batch 3**: 顶层 verdict 补齐 (旧仅在 summary 块内) |
| `comment.id` | `string` | Atlassian 评论 id |
| `comment.self` | `string` | 评论 REST URL |
| `transition.id` | `string` | Atlassian transition id |
| `transition.name` | `string` | transition 显示名 |
| `transition.to` | `string` | 目标 status 名 (e.g. "已完成") |
| `transition.toCategory` | `string` | 目标 statusCategory.key (e.g. "done") |
| `transition.matchedBy` | `"category" \| "business-pattern" \| "exact-name"` | **CP-2710 batch 3**: 合并自旧 `summary.transitionedTo` 等 |

**成功 (FAIL)**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"submit_verdict"` | 方法名 |
| `verdict` | `"FAIL"` | 顶层 verdict (本批之前已在顶层) |
| `comment.id` | `string` | 评论 id |
| `comment.self` | `string` | 评论 REST URL |
| `label` | `"escalated"` | 已加的 escalated label |
| `assigneeCleared` | `true` | assignee 已清 |

**partial (任意分支)**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `false` | 失败标记 |
| `method` | `"submit_verdict"` | 方法名 |
| `partial` | `true` | partial 标记 |
| `verdict` | `"PASS" \| "FAIL"` | **CP-2710 batch 3**: 顶层 verdict (旧仅 FAIL 顶层有) |
| `comment.id` | `string?` | 评论 id (可能未拿到) |
| `comment.self` | `string?` | 评论 REST URL (可能未拿到) |
| `label?` | `"escalated"` | (FAIL partial label OK 路径) |
| `hint?` | `string` | partial 修复指引 (CP-2710 红线 #28510: 完整保留) |

**CP-2710 batch 3**: PASS 顶层 `verdict:"PASS"` 补齐 (旧仅 FAIL 顶层有, PASS 只在 `summary.verdict` 块内); 旧 `summary{key, verdict, commentId, transitionedTo, toCategory}` 块去除 (PASS 全部 5 字段 + FAIL 4 字段全部与 request/comment/transition 重复); FAIL 成功路径 `hint` 字段去除 (语义冗余于 label 反馈, v0.5 草稿池定); partial 分支结构 0 改动 (CP-2710 红线 #28510: 错误 / hint 完整保留). `details` = <100 字符一句话摘要, 例 `CP-2690 已 PASS: 评论已发 + 转「已完成」` / `CP-2690 已 FAIL: escalated 已标 + assignee 已清` / `CP-2690 部分完成: 评论已发但转态失败, 见 hint`.

### `jira_abandon_task` 返回契约 (CP-2710 batch 3 精简后)

**成功**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"abandon_task"` | 方法名 |
| `comment.id` | `string` | 评论 id |
| `comment.self` | `string` | 评论 REST URL |
| `assigneeCleared` | `boolean` | assignee 是否清空 (5 步全 OK 时 = true) |
| `labelsRemoved` | `boolean` | labels 是否清空 |
| `labelsRemoveError?` | `string` | 移除 labels 失败时的错误信息 |
| `transition.id` | `string` | Atlassian transition id |
| `transition.name` | `string` | transition 显示名 |
| `transition.to` | `string` | 目标 status 名 (e.g. "已完成") |

**partial**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `false` | 失败标记 |
| `method` | `"abandon_task"` | 方法名 |
| `partial` | `true` | partial 标记 |
| `comment.id` | `string?` | 评论 id |
| `comment.self` | `string?` | 评论 REST URL |
| `assigneeCleared?` | `boolean` | (可能已 OK, 也可能未尝试) |
| `hint?` | `string` | partial 修复指引 (CP-2710 红线 #28510) |

**CP-2710 batch 3**: 旧 `summary{key, commentId, assigneeCleared, transitionedTo, labelsRemoved, labels, labelsRemoveError}` 块去除 (labels 数组回声裁, `labelsRemoved` 布尔 + `labelsRemoveError` 字符串作为状态反馈保留在顶层; 5 字段全部与 comment/assigneeCleared/transition/labelsRemoved 顶层字段重复). top-level `comment` / `assigneeCleared` / `labelsRemoved` / `labelsRemoveError` / `transition` 全保留 (状态机写的产物反馈). partial 分支结构 0 改动 (CP-2710 红线 #28510). `details` = <100 字符一句话摘要, 例 `CP-2690 子任务已废弃: 评论 + 清 assignee + 转「已完成」+ 清 escalated` / `CP-2690 部分废弃: 评论已发但转态失败, 见 hint`.

### `jira_request_help` 返回契约 (CP-2710 batch 3 精简后)

**成功**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"request_help"` | 方法名 |
| `comment.id` | `string` | 评论 id |
| `comment.self` | `string` | 评论 REST URL |
| `label` | `"wait-approval"` | 已加的 wait-approval label |
| `mentioned` | `string \| null` | **CP-2710 batch 3**: 顶层 mention accountId (红线 #28510: 保留) 或 `null` (无 mention) |

**partial**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `false` | 失败标记 |
| `method` | `"request_help"` | 方法名 |
| `partial` | `true` | partial 标记 |
| `comment.id` | `string` | 评论 id (OK) |
| `comment.self` | `string` | 评论 REST URL (OK) |
| `hint` | `string` | partial 修复指引 (含 `add_label` 调用模板) |

**CP-2710 batch 3**: 旧 `summary{key, commentId, label, mentioned}` 块去除 (4 字段全部与顶层 label/method/comment 重复); `mentioned` 字段从 summary 移出至顶层 (`accountId | null`, **红线 #28510** accountId 保留). orchestrator 仍是 owner, 不清 assignee (description 同步: 旧「+ 清 assignee」表述错误, 实际未清; CP-2710 落地后 description 与实现一致). partial 分支结构 0 改动 (CP-2710 红线 #28510). `details` = <100 字符一句话摘要, 例 `CP-2690 主任务已问人: 评论已发 + wait-approval 标签已加` / `... + @提及 张三` / `CP-2690 部分完成: 评论已发但 wait-approval label 失败, 见 hint`.

### `jira_get_attachment` 返回契约 (CP-2715 batch 4 精简后)

**成功**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"get_attachment"` | 方法名 |
| `request.attachmentId` | `string` | 唯一保留的 key-class 请求回声 |
| `path` | `string` | 实际落盘路径 (默认 `/tmp/openclaw-attachments/{id}.{ext}`, 或 `saveToPath`) |
| `size` | `number` | 文件字节数 (实际下载) |
| `mimeType` | `string` | MIME 类型 (来自 attachment metadata) |
| `filename` | `string` | 原始文件名 (来自 attachment metadata) |

**错误**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `error` | `string` | 错误信息 (CP-2715 红线: 错误路径 0 改动, 文案逐字保留) |

**CP-2715 batch 4**: 旧 `summary{attachmentId, path, size, mimeType, filename}` 块去除 (5 字段 100% 与顶层 `path` / `size` / `mimeType` / `filename` 重复, 是 v0.5 §5 草稿池最直白的「整块重复」案例). `request.saveToPath` 回声去除 (agent 刚传的参数; 最终落盘路径由顶层 `path` 给出, 含默认 `/tmp/openclaw-attachments/{id}.{ext}` 推导值). 错误路径契约 0 改动 — `{error}` 文案逐字保留 (`get_attachment requires a non-empty `attachmentId`` / `saveToPath` must be a string / `jira.get_attachment (metadata) failed: ...` / `failed to create /tmp/openclaw-attachments: ...` / `jira.get_attachment download failed: HTTP <status>` / `... download failed: <原因>`). 9 个 textResult 调用点 (L70/L75/L83/L96/L100/L116/L130/L138/L155) 全部双参且 `details` <100 字符. `details` = <100 字符一句话摘要, 例 `附件 12345 (hello.txt) 已下载, 11 字节` / `jira_get_attachment 失败: HTTP 404` / `jira_get_attachment 失败: 缺少 attachmentId`.

### `jira_upload_attachment` 返回契约 (CP-2715 batch 4 精简后)

**成功**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `true` | 成功标记 |
| `method` | `"upload_attachment"` | 方法名 |
| `request.issueIdOrKey` | `string` | 唯一保留的 key-class 请求回声 |
| `count` | `number` | 上传成功的附件数 (= `attachments.length`, 派生字段) |
| `attachments[]` | `attachment[]` | compact 5 字段集 (见下) |

**`attachments[]` 每项结构 (compact 模式, v0.5 §6 草稿池 5 字段)**:

| 字段 | 类型 | 含义 |
|---|---|---|
| `id` | `string` | Atlassian 附件 id |
| `filename` | `string` | 上传的文件名 (= `basename(filePath)`) |
| `size` | `number` | 文件字节数 (来自 Atlassian 上传响应) |
| `mimeType` | `string` | MIME 类型 |
| `content` | `string` | 下载 URL (api.media.atlassian.com, 不含文件字节) |

**错误** (既有契约, CP-2715 红线 0 改动):

| 字段 | 类型 | 含义 |
|---|---|---|
| `ok` | `false` | 失败标记 |
| `error.status` | `number` | synthetic 状态: 404 (missing file) / 413 (oversize, >100MB) / 500 (misc) / upstream HTTP 4xx/5xx 透传 |
| `error.message` | `string` | 错误信息 (synthetic message 文本逐字保留 / 上游 `HTTP <status> <statusText>: <body>` 透传前 500 字符) |

**CP-2715 batch 4**: 旧 `summary{issueIdOrKey, filePath, filename, size, attachmentCount}` 块去除 (5 字段全部与 request / 顶层 / attachments 重复; `filePath` 全路径重复 2 次可上百字符, 是 12 工具单点最大体积冗余). `request.filePath` / `request.size` / `request.filename` 回声去除 (仅留 `request.issueIdOrKey` 锚). `attachments` 数组**逐项显式 pick 5 字段** (`id` / `filename` / `size` / `mimeType` / `content`), 防止 Atlassian 原始项 `author` / `created` / `self` / `thumbnail` / `metadata` 等混入. `attachmentCount` 由派生 `count: items.length` 替换 (去重 — 旧 `count == attachments.length == summary.attachmentCount` 原本就是 3-way 重复). 错误对象 `{ok:false, error:{status,message}}` 与 synthetic status (404 missing file / 413 oversize / 500 misc) 语义完整保留; 上游 HTTP 4xx/5xx 透传 `res.status` 0 改动. `MAX_FILE_SIZE = 100 * 1024 * 1024` (100 MB) 输入侧 cap 0 改动. 8 个 textResult 调用点 (L53/L58/L69/L82/L92/L121/L132/L151) 全部双参且 `details` <100 字符. `details` = <100 字符一句话摘要, 例 `已上传 screenshot.png (12345 字节) 至 SSSS-454` / `jira_upload_attachment 失败: 文件不存在 /tmp/x.png` / `jira_upload_attachment 失败: 文件超 100MB (104857601 字节)` / `jira_upload_attachment 失败: HTTP 401`.

### 反断言 (本次不动)

- **CP-2715 batch 4 全量覆盖 (12 工具推广收口)**: 至此 14 个高频工具 (除 2 个 add_label / remove_label / block 内部分支工具外) 全部精简完成. **CP-2715 batch 4 新动**: `jira_get_attachment` / `jira_upload_attachment` (回到本批契约段). 历史批次: **CP-2693 batch 1** 动 `search` / `comment` / `create_task` / `create_subtask`; **CP-2700 batch 2** 动 `get_comment` / `list_attachments`; **CP-2710 batch 3** 动 `submit_verdict` / `abandon_task` / `request_help` / `transition`.
- **`jira_get` 的 `fields` 全量仍可用**: 调 `jira_get { fields: ['*all'] }` 后, `parsed.issue.fields.issuelinks` 仍是原数组 (旧 `{id, type, inwardIssue, outwardIssue}` 形状); 想 follow-up 拿到原 shape 不影响. **CP-2693 batch 1** / **CP-2700 batch 2** / **CP-2710 batch 3** 都不动 `jira_get` 的 `fields` 逃生舱语义.
- **`jira_search` 的 `fields` 仅服务端收窄, 不扩展返回集**: 显式传 `["description"]` / `["customfield_*"]` 等白名单外字段会被静默丢弃 (formatIssues 固定 8 字段). 需要这些字段 → 走 `jira_get { fields: [...] }` 单票逃生舱.
- **错误路径仍走 `error` 字段**: 14 个高频工具任何 4xx / 5xx / 网络错 都返回 `{error: "jira.<method> failed: ..."}` (12 个查询/状态机写工具) 或 `{ok:false, error:{status,message}}` (2 个 upload_attachment / 关联工具的合成错误结构, 含 synthetic status 404/413/500), **不**走 result feedback 路径. **CP-2715 batch 4**: 2 个附件传输工具的合成错误对象 shape 完整保留 — `{ok:false, error:{status,message}}` 结构与 status 语义 (404 missing file / 413 oversize / 500 misc) 0 改动, 仅 `details` 第二参补充 <100 字符一句话摘要.
- **`jira_get_comment` 的 `body` 不截断**: 必须保持 — 这是 list_comments 500-char 截断的全文逃生舱; description 声明 NEVER truncated.
- **`jira_list_attachments` 不含文件内容**: 字节走 `jira_get_attachment`; attachments[] 项 `content` 字段是下载 URL (api.media.atlassian.com), 不是文件字节.
- **CP-2710 batch 3 状态机写工具 partial 分支结构 0 改动**: `submit_verdict` / `abandon_task` / `request_help` 三个 partial 分支 (4 个 partial 路径) 字段集合 / 顺序 / 命名 / hint 文案 完整保留 (CP-2710 红线 #28510); 仅 `details` 字段从 dict 摘要 (与 content 等大) 改为 <100 字符 string.
- **CP-2710 batch 3 author.accountId / mentions 保留**: `jira_request_help` 的 `mentioned` 字段含 accountId (红线 #28510: accountId 不删), 写 partial 路径也保留 `comment` 含 author 信息; `jira_submit_verdict` 评论 author 由 server 端生成, 路径不涉及.
- **CP-2710 batch 3 verdict / label / assigneeCleared 语义与执行顺序 0 改动**: `submit_verdict` FAIL 路径仍先 comment → 后 label → 后 clear assignee; PASS 路径仍先 comment → 后 transition; `abandon_task` 5 步顺序不变; `request_help` 3 步顺序不变.
- **CP-2715 batch 4 attachments compact 5 字段 + error 结构 0 改动**: `jira_upload_attachment` 的 `attachments[]` 始终是 `{id, filename, size, mimeType, content}` 这 5 字段, 即使 Atlassian 上传响应带 `author` / `created` / `self` / `thumbnail` / `_links` / `metadata` 等附加字段也 0 混入 (handler 内 `pickCompact` 显式 pick, 不 `...rest`). 错误对象 `{ok:false, error:{status,message}}` 与 synthetic status 语义 (404 missing file / 413 oversize / 500 misc / 上游 4xx/5xx 透传 res.status) 完整保留. `MAX_FILE_SIZE = 100 * 1024 * 1024` 输入侧 cap 0 改动 (Atlassian Cloud 单附件硬上限).
- **CP-2715 batch 4 default 落盘路径 0 改动**: `jira_get_attachment` 默认 `/tmp/openclaw-attachments/{id}.{ext}` (ext 来自 mimeType 推导, 见 `extFromMime` 表); 不入 git 系统目录 (`~/.openclaw/...`); caller `saveToPath` 覆盖时不自动 `mkdir` 父目录 (caller 责任). 顶层 `path` 始终是最终落盘路径, 反映默认路径推导值.

---

## ADF Builder Guide (Atlassian Document Format, plugin 内部)

> **官方参考:** https://developer.atlassian.com/cloud/jira/platform/apis/document/structure

ADF 是 Atlassian 的富文本 JSON 格式. **agent 永远不需要直接构造 ADF**——所有 agent-facing 参数都是 plain string, plugin 在内部构造 ADF (comment body / task description / verdict comment / escalate comment / help comment). 这一节只是开发者/调试参考.

### 顶层结构

```json
{
  "version": 1,
  "type": "doc",
  "content": [ /* 数组: 顶层 block 节点 */ ]
}
```

`content` **必须**是数组. 空数组 `[]` = 空文档. **绝不能** `content: {item: [...]}` (LLM 常见错误, 会被拦截).

### Block 节点 (放在 doc.content 里)

| type | attrs | 内部 content | 用途 |
|------|-------|-------------|------|
| `paragraph` | — | inline 数组 | 普通段落 |
| `heading` | `{level: 1\|2\|3\|4\|5\|6}` | inline 数组 | 标题 (h1-h6) |
| `codeBlock` | `{language: "bash"\|"yaml"\|...}` | inline 数组 | 代码块 (内容要 text) |
| `blockquote` | — | block + inline 数组 | 引用 |
| `bulletList` | — | `listItem` 数组 | 无序列表 |
| `orderedList` | `{order: 1}` 可选 | `listItem` 数组 | 有序列表 |
| `listItem` | — | block 数组 (通常包 paragraph) | 列表项 |
| `panel` | `{panelType: "info"\|"warning"\|"error"}` | block + inline | 信息面板 |
| `rule` | — | — | 分隔线 (无 content) |
| `table` | `{isNumberColumnEnabled: bool}` | `tableRow` 数组 | 表格 |

### Inline 节点 (放在 block.content 里)

| type | attrs | 用途 |
|------|-------|------|
| `text` | — | 文字. **`text` 字段是文字内容** |
| `mention` | `{id: accountId, text: "@displayName"}` | @提及 |
| `hardBreak` | — | 软换行 |
| `emoji` | `{shortName: ":smile:"}` 或 `{id: "..."}` | emoji |
| `link` | `{href: "https://..."}` | 链接 (包 text 节点) |

### 4 个标准模式 (copy-paste ready)

#### 1. 单段纯文本 (最常用, 不确定时用这个)

```json
{
  "version": 1,
  "type": "doc",
  "content": [
    {
      "type": "paragraph",
      "content": [
        { "type": "text", "text": "你的内容写在这里" }
      ]
    }
  ]
}
```

#### 2. 标题 + 段落

```json
{
  "version": 1,
  "type": "doc",
  "content": [
    {
      "type": "heading",
      "attrs": { "level": 2 },
      "content": [{ "type": "text", "text": "标题" }]
    },
    {
      "type": "paragraph",
      "content": [{ "type": "text", "text": "正文段落" }]
    }
  ]
}
```

#### 3. 代码块

```json
{
  "version": 1,
  "type": "doc",
  "content": [
    {
      "type": "codeBlock",
      "attrs": { "language": "bash" },
      "content": [
        { "type": "text", "text": "kubectl get pods" }
      ]
    }
  ]
}
```

#### 4. 项目列表 (bulletList / listItem / paragraph 三层包装)

```json
{
  "version": 1,
  "type": "doc",
  "content": [
    {
      "type": "heading",
      "attrs": { "level": 3 },
      "content": [{ "type": "text", "text": "AC 验收标准" }]
    },
    {
      "type": "bulletList",
      "content": [
        {
          "type": "listItem",
          "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "AC1: ..." }] }
          ]
        },
        {
          "type": "listItem",
          "content": [
            { "type": "paragraph", "content": [{ "type": "text", "text": "AC2: ..." }] }
          ]
        }
      ]
    }
  ]
}
```

> **ListItem 内部必须包一层 `paragraph`** (不是直接放 text 节点).

### Plugin 拦截的 3 种 invalid ADF (返 400 INVALID_INPUT 前先报清楚)

1. **空对象 `{}`** — 通常是 LLM 把 wrapper 弄丢了. **重试**: 检查嵌套结构是不是双层. 报错 `node type="...": has no content children.`
2. **`content: {item: [...]}`** — LLM 误把数组当对象. **重试**: 改成 `content: [{...}, {...}]`. 报错 `content is object, must be an Array`.
3. **任何节点 `content` 不是数组** — **重试**: 改成数组. 报错同上.

### ❌ vs ✅ ADF 对比表 (高频踩坑)

| 场景 | ❌ 错误写法 | ✅ 正确写法 | 报错 / 后果 |
|---|---|---|---|
| 顶层 `content` 必须是数组 | `content: {item: [{...}]}` | `content: [{type:"paragraph", content:[...]}]` | `content is object, must be an Array` |
| 缺 `doc` 顶层 wrapper | `{"paragraph": {...}}` | `{"version":1,"type":"doc","content":[{"type":"paragraph",...}]}` | `node type="paragraph": has no content children.` |
| `listItem` 内部结构 | `{"type":"listItem","content":[{type:"text",text:"x"}]}` | `{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"x"}]}]}` | 跳过 paragraph 直接放 text 渲染被吃 / 不通过 schema |
| `codeBlock` 内容 | `{"type":"codeBlock","attrs":{"language":"bash"},"content":"kubectl get pods"}` | `{"type":"codeBlock","attrs":{"language":"bash"},"content":[{"type":"text","text":"kubectl get pods"}]}` | `content is string, must be an Array` |
| `heading` 缺 `attrs.level` | `{"type":"heading","content":[{type:"text",text:"t"}]}` | `{"type":"heading","attrs":{"level":2},"content":[{type:"text",text:"t"}]}` | 渲染为默认 h1 或被忽略 |
| `mention` 缺 `text` | `{"type":"mention","attrs":{"id":"abc"}}` | `{"type":"mention","attrs":{"id":"abc","text":"@Alice"}}` | `mentionMap` 校验失败 / 显示为 `[accountId:abc]` |
| `panel` attrs 拼写 | `{"type":"panel","attrs":{"type":"info"}, ...}` | `{"type":"panel","attrs":{"panelType":"info"}, ...}` | `panelType` 必须是 `info/warning/error/success/note` |
| 字符串 `body` (jira_comment) | `body: "hello"` | `body: {version:1,type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"hello"}]}]}` | `INVALID_INPUT: comment body must be ADF dict` |
| `create_task.requirements` 给 ADF dict | `{version:1,type:"doc",content:[...]}` | `"Why: ...\n## What\n- 加 X"` (纯字符串) | `create_task requires \`requirements\` (plain text string, non-empty)` |
| `create_task.acceptance_criteria` 给数组 | `["AC1: ...", "AC2: ..."]` | `"AC1: ...\nAC2: ..."` (单个字符串, `\n` 分隔) | `create_task requires \`acceptance_criteria\` (plain text string, non-empty)` |
| 空 `content` 作 comment body | `content: []` | 至少 `[{type:"paragraph",content:[{type:"text",text:"..."}]}]` | 评论渲染空白 |

> **速记口诀**: `doc → content 是数组` / `listItem 里套 paragraph` / `text 永远在 inline.content 里` / `codeBlock.attrs.language 是字符串`.

### 不知道 ADF 时怎么办

1. **首选: 抄上面的 4 个标准模式** (覆盖 90% 场景)
2. **次选: 去 ADF Builder playground** https://developer.atlassian.com/cloud/jira/platform/apis/document/playground
   - 用 WYSIWYG 编辑器手动构造你要的格式
   - 复制下面生成的 JSON 套到 `body` 字段 (`create_task` / `create_subtask` 的 3 字段是纯文本字符串, 不要再写 ADF)
3. **不确定的 node type: 去看官方结构表** https://developer.atlassian.com/cloud/jira/platform/apis/document/structure

---

## Python Helper 模板 (ADF 构造, 仅供开发者参考)

> **⚠️ 警告**: `jira_comment` 的 `body` 现为 **plain string**（plugin 自动转 ADF），`jira_create_task` / `jira_create_subtask` 的 3 字段也是纯文本字符串。**agent-facing 参数一律不收 ADF dict**——本节 ADF 构造仅用于开发者调试 / 内部富文本逻辑参考，不要把它传给 `jira-tool comment` / `jira_comment` 等任何 agent-facing 工具。
>
> 本节保证 (a) `doc.content` 永远是数组 (b) `listItem` 自动包 `paragraph` (c) 不会出现 `content` 是 string/object 的情况.

### 1. 节点构造函数 (Node Builders)

```python
from typing import Any

def text(s: str) -> dict[str, Any]:
    """inline: 纯文本节点"""
    return {"type": "text", "text": s}

def paragraph(*inlines: dict[str, Any]) -> dict[str, Any]:
    """block: 段落, 包一组 inline 节点 (text / mention / hardBreak / emoji / link)"""
    return {"type": "paragraph", "content": list(inlines)}

def heading(level: int, s: str) -> dict[str, Any]:
    """block: 标题, level ∈ [1, 6]"""
    assert 1 <= level <= 6, f"heading level must be 1-6, got {level}"
    return {"type": "heading", "attrs": {"level": level}, "content": [text(s)]}

def code_block(language: str, code: str) -> dict[str, Any]:
    """block: 代码块. content 必须是数组 (单 text 节点)"""
    return {
        "type": "codeBlock",
        "attrs": {"language": language},
        "content": [text(code)],
    }

def list_item(*blocks: dict[str, Any]) -> dict[str, Any]:
    """listItem: 自动包一层 paragraph (若调用方传了 raw text, 也帮你包)"""
    wrapped: list[dict[str, Any]] = []
    for b in blocks:
        if b.get("type") in ("paragraph", "heading", "codeBlock", "bulletList", "orderedList", "blockquote"):
            wrapped.append(b)
        else:
            # raw text / inline 节点 → 包成 paragraph
            wrapped.append(paragraph(b))
    return {"type": "listItem", "content": wrapped}

def bullet_list(*items: str | dict[str, Any]) -> dict[str, Any]:
    """bulletList: 接受纯字符串 (自动转 listItem) 或 listItem dict"""
    list_items: list[dict[str, Any]] = []
    for it in items:
        if isinstance(it, str):
            list_items.append(list_item(paragraph(text(it))))
        else:
            list_items.append(it)
    return {"type": "bulletList", "content": list_items}

def panel(panel_type: str, *blocks: dict[str, Any]) -> dict[str, Any]:
    """panel: panelType ∈ info | warning | error | success | note"""
    assert panel_type in {"info", "warning", "error", "success", "note"}, f"bad panelType: {panel_type}"
    return {"type": "panel", "attrs": {"panelType": panel_type}, "content": list(blocks)}

def mention(account_id: str, display_name: str) -> dict[str, Any]:
    """inline @mention. display_name 必填, 同时记入 mentionMap"""
    return {"type": "mention", "attrs": {"id": account_id, "text": f"@{display_name}"}}
```

### 2. Doc 包装 + mention 收集

```python
def doc(*blocks: dict[str, Any]) -> dict[str, Any]:
    """顶层 ADF doc. content 永远是数组 (空就 []), 绝不返回对象."""
    return {"version": 1, "type": "doc", "content": list(blocks)}


def collect_mentions(adf: dict[str, Any]) -> dict[str, str]:
    """扫 ADF 收集所有 mention 节点 → {accountId: displayName}.
    传给 jira_comment 的 mentionMap, plugin 会做双射校验."""
    mentions: dict[str, str] = {}

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "mention":
                attrs = node.get("attrs", {})
                if "id" in attrs and "text" in attrs:
                    mentions[attrs["id"]] = attrs["text"].lstrip("@")
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(adf)
    return mentions
```

### 3. 完整使用示例 (给 ticket 写评论)

```python
# 场景: 给 <issue-key> 加一段 Phase 总结评论（body 是 plain string，\n 换行）
body = "Phase 完成总结\n\n- P1 修 Save 持久化 已完成 (5/5 tests pass)\n- 已合入 main, 待 review"

# → 调用 jira_comment (CLI 形式，方法名用 MCP 名或短名均可)
import json, subprocess
subprocess.run([
    "jira-tool", "jira_comment",
    json.dumps({
        "issueIdOrKey": "<issue-key>",
        "body": body,
        "mentionAccountIds": ["<accountId>"],
    }, ensure_ascii=False),
], check=True)
```

### 4. `jira_create_task` / `jira_create_subtask` 字段构造 (0.5.0+ 纯文本)

```python
def build_acceptance_criteria_text(items: list[str]) -> str:
    """把 ["AC1: xxx", "AC2: yyy"] 拼成单个纯文本字符串 (\\n 分隔)."""
    return "\n".join(items)


def build_scope_text(in_scope: list[str], out_of_scope: list[str]) -> str:
    """scope 字段常用 ✅/❌ 两栏对比, 输出纯文本字符串."""
    lines = ["✅ 负责"] + [f"  - {s}" for s in in_scope]
    lines.append("❌ 不负责")
    lines += [f"  - {s}" for s in out_of_scope]
    return "\n".join(lines)


def build_requirements_text(why: str, what_bullets: list[str]) -> str:
    """requirements 字段, 输出纯文本字符串."""
    lines = [f"Why: {why}", "", "## What", ""]
    lines += [f"- {b}" for b in what_bullets]
    return "\n".join(lines)


# 用法 (CLI)
# jira-tool create_task '{
#   "project": "WTO",
#   "summary": "...",
#   "requirements": "<build_requirements_text(...) 返回值>",
#   "scope": "<build_scope_text(...) 返回值>",
#   "acceptance_criteria": "<build_acceptance_criteria_text(...) 返回值>"
# }'
```

> **重要**: 这 3 个 helper 返回 `str`, 不是 ADF dict. plugin 内部把它和模板拼接成 ADF (`## 任务说明` / `## 职责范围` / `## 验收标准`). agent 不再需要 (也不应该) 给这 3 个字段写 ADF.

### 5. Markdown → ADF 简易转换 (单段/列表场景够用)

```python
import re

def md_inline_to_adf(s: str) -> list[dict[str, Any]]:
    """极简: 处理 **bold** / `code` / 普通 text. 不处理 link / 嵌套."""
    out: list[dict[str, Any]] = []
    i = 0
    pattern = re.compile(r"\*\*(.+?)\*\*|`([^`]+)`")
    last = 0
    for m in pattern.finditer(s):
        if m.start() > last:
            out.append(text(s[last:m.start()]))
        if m.group(1) is not None:
            out.append({"type": "text", "text": m.group(1), "marks": [{"type": "strong"}]})
        else:
            out.append({"type": "text", "text": m.group(2), "marks": [{"type": "code"}]})
        last = m.end()
    if last < len(s):
        out.append(text(s[last:]))
    return out or [text(s)]


def md_to_adf(md: str) -> dict[str, Any]:
    """把每行 - xxx 当 bullet, 其他行当 paragraph."""
    blocks: list[dict[str, Any]] = []
    bullet_buf: list[str] = []
    for line in md.splitlines():
        line = line.rstrip()
        if line.startswith("- "):
            bullet_buf.append(line[2:])
        else:
            if bullet_buf:
                blocks.append(bullet_list(*bullet_buf))
                bullet_buf = []
            if line.strip():
                blocks.append(paragraph(*md_inline_to_adf(line)))
    if bullet_buf:
        blocks.append(bullet_list(*bullet_buf))
    return doc(*blocks)
```

### 6. 自检 (写完 ADF 先跑一遍)

```python
def validate_adf(adf: dict[str, Any]) -> list[str]:
    """返回错误列表 (空 = OK). 比 plugin 提前拦截, 节省一次 round-trip."""
    errs: list[str] = []
    if adf.get("type") != "doc":
        errs.append("root.type must be 'doc'")
    if "version" not in adf:
        errs.append("root.version missing")
    content = adf.get("content")
    if not isinstance(content, list):
        errs.append(f"root.content must be Array, got {type(content).__name__}")
        return errs
    for i, node in enumerate(content):
        errs.extend(_check_node(node, f"content[{i}]"))
    return errs


# ADF node types that are "leaf" — no `content` array expected
_LEAF_NODES = {"rule", "text", "hardBreak", "emoji"}


def _check_node(node: Any, path: str) -> list[str]:
    errs: list[str] = []
    if not isinstance(node, dict):
        return [f"{path}: must be dict, got {type(node).__name__}"]
    t = node.get("type")
    if not t:
        return [f"{path}: missing type"]
    if t in _LEAF_NODES:
        return []
    c = node.get("content")
    if c is None:
        errs.append(f"{path} type={t}: has no content children.")
        return errs
    if not isinstance(c, list):
        return [f"{path} type={t}: content is {type(c).__name__}, must be an Array"]
    # listItem 必须包 paragraph
    if t == "listItem":
        for j, child in enumerate(c):
            if isinstance(child, dict) and child.get("type") != "paragraph":
                errs.append(f"{path}.content[{j}] type={child.get('type')}: listItem child must be paragraph")
    for j, child in enumerate(c):
        errs.extend(_check_node(child, f"{path}.content[{j}]"))
    return errs


# 用法
adf = build_acceptance_criteria(["AC1: 改 Save", "AC2: 加 index"])
problems = validate_adf(adf)
assert not problems, problems  # OK 才发
```

> **要点回顾**: helper 设计保证 `doc.content` 永远是数组 + `listItem` 自动包 `paragraph` + `codeBlock.content` 永远是 `[text(...)]` 三条最容易踩坑的点. 实际 production 仍建议跑 `validate_adf` 自检再下发.

---

## 避坑清单

1. **`jira_comment.body` 是纯文本 string，不是 ADF dict**: plugin 自动转 ADF（`\n` → hardBreak）。不要传 ADF dict（会被拒，报 `comment body must be a plain string`）。
2. **`create_task` / `create_subtask` 的 `requirements` / `scope` / `acceptance_criteria` 全是纯文本字符串**: 不是 ADF dict, 不是数组. plugin 内部拼 3 段 ADF. `acceptance_criteria` 用 `\n` 分隔多条 AC.
3. **`submit_verdict.verdict` 必为 `PASS` 或 `FAIL`**: 其他值 → fail-fast. reason 必填 (FAIL 时).
4. **`request_help` 仅主任务**: 子任务请用 `submit_verdict({verdict:"FAIL", reason})`. (会返清晰错误并指明替代方案)
5. **`abandon_task` 仅子任务**: 主任务请用 `submit_verdict({verdict:"FAIL"})` 或 `request_help`.
6. **`@mention` 用 ADF `mention` 节点 + `mentionMap`**: plugin 强校验 ADF mentions 和 map 的双射 (mentionMap 省略或 `{}` → 不做校验).
7. **`transition` / `submit_verdict` 现在项目无关**：两者都接受逻辑名 `done` / `in_progress` / `review` / `blocked` / `reopen` / `todo` / `cancelled`，plugin 内部用 Jira 的 `statusCategory` (平台级标准) 匹配。**不再需要知道项目特有的状态名**。不确定可用状态时调 `jira_get` 看当前 status，或看 transition 返错时的 `Available transitions` 列表。
8. **`jira_get` 默认走白名单, 不拉 `comment` / `worklog`** (~80% context 节省 vs `*navigable`). 需要全量 → `fields: ['*all']`; 需要单个 custom field → `fields: ['customfield_10019']`. 评论另走 `jira_list_comments` (ADF → 纯文本, deduped mentions). 3 个上下文优化工具详见上面"上下文优化" section.
9. **`jira_list_comments` / `jira_get_comment` 输出永远是纯文本, 不是 ADF**: plugin 自动 ADF → plain text. 所以**不要**把 `jira_list_comments` 的输出直接喂回 `jira_comment` 的 `body` (会被 Atlassian 当成 string body 拒掉). 要 reply 哪条评论, 手动写 ADF.

---

## 配置 (env)

| env | required | default | 说明 |
|---|---|---|---|
| `ATST_TOKEN` | ✅ | — | OAuth 2.0 3LO access token (Bearer 头) |
| `JIRA_CLOUD_ID` | ✅ | — | Atlassian Cloud ID (UUID) |
| `JIRA_PROXY` | ❌ | `http://proxy.example.com:8080` | HTTP 代理 |

任一 required env 未设 → 启动时 fail-fast 返清晰错误，不静默退化。

openclaw.json 的 `plugins.entries.jira-openclaw-plugin.config` 字段 (atstToken / cloudId / proxy) 优先于 env 变量（用于本地 dev override）。
