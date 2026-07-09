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

## 调用形态

**OpenClaw 原生 tool** (agent 默认) — 直接调 named tool:

```json
jira_search { jql: "project = <project-key> AND status != Done" }
jira_get { issueIdOrKey: "<issue-key>" }
jira_create_task { project: "WTO", summary: "...", requirements: "...", scope: "...", acceptance_criteria: "..." }
```

**CLI 二进制** (OpenCode / 终端 / CI):

```bash
jira-tool search '{"jql":"project = <project-key> AND status != Done"}'
jira-tool get '{"issueIdOrKey":"<issue-key>"}'
jira-tool create_task '{"project":"WTO","summary":"...","requirements":"...","scope":"...","acceptance_criteria":"..."}'
jira-tool submit_verdict '{"issueIdOrKey":"<issue-key>","verdict":"PASS","summary":"done"}'
```

命令退出码: `0`=成功, `5`=业务错误, `2`=JSON 解析错, `1`=无参数.

> **`jira_create_task` / `jira_create_subtask` 的 `requirements` / `scope` / `acceptance_criteria` 3 字段全是纯文本字符串, 不是 ADF dict, 不是数组.** plugin 自动按 `## 任务说明 / ## 职责范围 / ## 验收标准` 3 段拼接成 description. 用 `\n` 换行.
>
> **`jira_comment` 的 `body` 也是纯文本 string, 不是 ADF dict.** plugin 自动包成 ADF. 用 `\n` 换行. **agent 永远不需要知道 ADF**.

---

## 14 tool 速查

### 通用 (9)

| tool | 用途 | 必填 | 常用选填 |
|---|---|---|---|
| `jira_search` | JQL 搜索 (默认 30 条) | `jql` | `maxResults`, `fields` |
| `jira_get` | 读单 ticket 详情 (默认走白名单, 含 attachment 最新 20 个) | `issueIdOrKey` | `fields` |
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
| `jira_request_help` | 主任务卡住找人 (评论 + `wait-approval` label + 清 assignee) | `issueIdOrKey`, `question` | — |

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

**返回结构**:
```json
{
  "ok": true,
  "method": "upload_attachment",
  "request": { "issueIdOrKey": "<issue-key>", "filePath": "/tmp/screenshot.png", "size": 12345, "filename": "screenshot.png" },
  "attachments": [
    { "id": "13428", "filename": "screenshot.png", "size": 12345, "mimeType": "image/png", "content": ".../attachment/content/13428" }
  ],
  "summary": { "issueIdOrKey": "<issue-key>", "attachmentCount": 1 }
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

默认不带任何参数 → plugin **服务端** 走 `fields` query param 限定白名单:

```
summary, status, issuetype, priority, labels,
assignee, reporter, created, updated, parent, description
```

白名单**排除** `comment` / `worklog` / `attachment` 等重资源. 实测对比 `*navigable` 默认集, 一个 long-lived ticket 可以从 30+ KB 砍到 1-3 KB.

**为什么走服务端 query 而不是 client-side filter**: Atlassian wire payload 在我们 formatter 跑之前就开始烧 token 了, 客户端裁剪救不了 wire cost. 唯一靠谱的省点是 `fields` query param.

**怎么扩**:
```json
jira_get { issueIdOrKey: "<issue-key>", fields: ["*all"] }                  // 全量 (相当于 *navigable)
jira_get { issueIdOrKey: "<issue-key>", fields: ["customfield_10019"] }     // 单 custom field
jira_get { issueIdOrKey: "<issue-key>", fields: ["summary","status","customfield_10019"] }  // 混搭
```

返回结构不变: `issue.summary` / `issue.status` / `issue.description` / `issue.fields` (curated fields dict, **不含** comment/worklog).

### `jira_list_comments`

```json
jira_list_comments { issueIdOrKey: "<issue-key>", maxResults: 20, orderBy: "-created" }
jira_list_comments { issueIdOrKey: "<issue-key>", since: "2026-06-15T00:00:00.000+0800", authorAccountId: "712020:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx..." }
```

- 走 `GET /issue/{key}/comment`, 默认 `maxResults=50` 上限 100, `orderBy="-created"` (最新在前)
- **comment body 自动从 ADF 转纯文本** (heading 渲染成 `## xxx`, bulletList 渲染成 `- xxx`, mention 渲染成 `@displayName`)
- 每个 comment 带 `mentions: [{accountId, displayName}]` 列表 — 回答 "谁被 @ 了" 这个高频问题不需要回扫 ADF
- `startAt` 用于翻页 (Atlassian 默认 50 一页)
- `since` (可选, ISO date string) — **客户端 filter**: 保留 `created >= since` 的评论. 留空 / 省略 → 不过滤, 不 throw. 非法 ISO string → 软错误. 例: `"2026-06-15"` 或 `"2026-06-15T10:00:00.000+0800"`.
- `authorAccountId` (可选, string) — **客户端 filter**: 保留 `author.accountId` 匹配的评论. 留空 / 省略 → 不过滤, 不 throw. 例: `"712020:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"`.
- `rawCount` 字段返回过滤前数量, `count` 返回过滤后数量, 方便 agent 评估过滤效果.

### `jira_get_comment`

```json
jira_get_comment { issueIdOrKey: "<issue-key>", commentId: "10001" }
```

- 走 `GET /issue/{key}/comment/{id}`, 两个参数都必填 (Atlassian 的 comment id 只在 issue 内唯一)
- 输出 shape 跟 `jira_list_comments` 单条一致: `{id, author, created, body, mentions}`
- `summary` 里带 `bodyChars` 和 `mentionCount` 方便 agent 判断要不要再下钻

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

## Python Helper 模板 (ADF 构造, 用于 `jira_comment.body`)

> **用途**: 程序化构造 ADF (例如把 markdown 转 ADF、`jira_comment` 的 body). 保证 (a) `doc.content` 永远是数组 (b) `listItem` 自动包 `paragraph` (c) 不会出现 `content` 是 string/object 的情况.
>
> **`jira_create_task` / `jira_create_subtask` 不再用这套** — 3 字段 (`requirements` / `scope` / `acceptance_criteria`) 已是纯文本字符串, 不需要构造 ADF.

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

### 3. 完整使用示例 (建子任务评论)

```python
# 场景: 给 <issue-key> 加一段 Phase 总结评论
body = doc(
    heading(2, "Phase 完成总结"),
    paragraph(text("P1 修 Save 持久化 "), text("已完成"), text(" (5/5 tests pass)")),
    heading(3, "变更文件"),
    bullet_list(
        "src/services/save.py: 改用事务包装",
        "src/db/migrations/0042_add_index.sql: 新增索引",
    ),
    code_block("diff", "- save()\n+ with db.transaction(): save()"),
    panel("info", paragraph(text("已合入 main, 待 review"))),
)

mention_map = collect_mentions(body)
# → 调用 jira_comment (CLI 形式)
import json, subprocess
subprocess.run([
    "jira-tool", "comment",
    json.dumps({
        "issueIdOrKey": "<issue-key>",
        "body": body,
        "mentionMap": mention_map,
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

1. **`comment.body` 必 ADF dict**: `{version:1, type:"doc", content:[{type:"paragraph", content:[{type:"text", text:"..."}]}]}`. 字符串 body 不支持. **ADF 不会写时看上面"ADF Builder Guide"**.
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
