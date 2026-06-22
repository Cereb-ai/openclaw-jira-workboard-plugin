# Task: 实施 jira-openclaw-plugin v0.1.0 MVP

> 主 session 拍板归档 + 任务交付文档。devclaw sub-agent 实施时按本文件执行。

## ⚠️ 红线清单（必读，违反任何一条立即停手并回报）

### 禁止读的文件（含 secret）

以下文件含 gateway auth token / install secret / API token 等敏感信息，**绝对禁止读取**（包括 cat / head / read / type / 任何间接读法）：

- ❌ `~/.openclaw/openclaw.json`（含 `gateway.auth.token`）
- ❌ `~/.openclaw/installs.json`（含 install 路径 hash + secret）
- ❌ `~/.openclaw/workspace/config/mcporter.json`（含 `mcpServers.atlassian.headers.Authorization`，**ATST token 就在这里**——但我们走 env var 方式，不从这里读）
- ❌ 任何 `.env` / `*.env.local` / `*secret*` / `*token*` / `*credential*` 文件
- ❌ `~/.bashrc` / `~/.zshrc` / `~/.profile`（可能含 env export）
- ❌ `~/.config/environment.d/*`（可能含 env 配置）

**如果需要 OpenClaw 配置文件结构作为参考** → 直接读 `~/dev/projects/outline-wiki-openclaw-plugin/openclaw.plugin.json`（plugin 自身就包含完整 configSchema 范式） + `outline-wiki-openclaw-plugin/package.json`，**不需要读** OpenClaw 全局配置。

### 禁止跑的 agent 级操作

- ❌ `systemctl --user restart openclaw-gateway.service` —— 此类 systemd 操作**必须由 Leo 在本地 pty 手动执行**，agent 不能跑（会超时不可控——这是 06-08 outline-wiki 0.3.0 实施时立下的硬规）
- ❌ `openclaw plugins install ...`（可以跑，但**安装完必须停**——等 Leo 重启 gateway 后再继续 7 项自检）
- ❌ `openclaw plugins uninstall ...`（破坏性操作，必须等 Leo 授权）
- ❌ `npm publish` / `npm login`（发布权限不在 agent 范围）

### 禁止写入任何地方的敏感信息

- ❌ ATST token / API token / bearer token / password / private key —— 任何文件、commit message、code comment、log、debug print、SKILL.md、README.md、报告里都**绝对不能出现 token 原文**
- ❌ 真实 issue 关键内容（某些 ticket 可能含敏感业务数据）—— 报告里只引 issue key，不引摘要
- ❌ 真实用户信息（accountId、email 等）—— 报告里只引 display name 前缀

### Fail-fast 行为（跟红线一致）

任何红线违规 → 立即停手，回报给主 session，等 Leo 拍板下一步。

## 命名（已拍板，不可改）

- npm 包名: `@cereb/jira-openclaw-plugin`
- OpenClaw tool 名: `jira`
- 版本: `0.1.0`

## 范围：MVP 6 method（只做这 6 个）

1. `search` — JQL 搜索
2. `get` — 读 issue 详情
3. `create` — 创建 issue
4. `update` — 更新字段
5. `comment` — 写评论（ADF 透传）
6. `transition` — 状态流转（内部 get transitions + post execute 两步）

**只覆盖 Jira，不做 Confluence**（YAGNI 边界反转）。

**不做** Phase B 的 6 method（`add_label` / `remove_label` / `block` / `property_get` / `property_set` / `property_del`）—— 留给 0.2.0。

## 范式参考（必读）

完全沿用 `outline-wiki 0.3.1` 范式，先把这个项目的结构吃透：

```
~/dev/projects/outline-wiki-openclaw-plugin/
├── package.json                (type: module, main: dist/index.js, files: [dist, openclaw.plugin.json, README.md, skills])
├── openclaw.plugin.json        (id/name/description/skills/configSchema/activation/contracts.tools/toolMetadata)
├── tsconfig.json
├── README.md
├── skills/
│   └── outline-wiki/
│       └── SKILL.md            (9 section 范式)
├── src/
│   ├── index.ts                (plugin 入口，registerTool('outline_wiki', ...))
│   └── ... (handlers)
```

**"单 tool 分发"模式** —— 只暴露 1 个 tool `jira`，通过 `category.method` 形式分发：
```ts
// 调用方写法（任选其一）：
jira call search {"jql":"..."}
jira.call "search" '{"jql":"..."}'
jira.search {"jql":"..."}
```

入口函数接 `call` 字符串（如 `"search {\"jql\":\"...\"}"` 或 `{method, args}` 结构体），分发到 `handlers/search.ts` 等 6 个文件。

## 关键约束（红线）

### 1. 不依赖 mcporter

plugin **完全不依赖** mcporter daemon：
- ❌ 不读 `mcporter.json`
- ❌ 不调 `mcporter call atlassian.*`
- ✅ 直连 Atlassian Cloud REST API v3（`https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`）
- ✅ 用 Node 18+ 原生 `fetch`（不要 axios / node-fetch）

### 2. ATST token 配置（D7 = B：env var 方式）

plugin 端从 `process.env` 读：
- `ATST_TOKEN` — OAuth 2.0 3LO access token（Bearer 头）
- `JIRA_CLOUD_ID` — Atlassian Cloud ID（UUID 格式）
- `JIRA_PROXY` — 可选，代理 URL（默认 `http://172.29.176.1:7890`）

**Fail-fast 行为**（跟 outline-wiki 0.3.1 一致）：
- 启动时检查 `ATST_TOKEN` 和 `JIRA_CLOUD_ID` 必须有
- 任一未设 → 返清晰错误（"ATST_TOKEN env var is required; see SKILL.md §配置"），**不静默退到降级路径**
- `JIRA_PROXY` 未设则用默认值，不报错

### 3. ADF 处理

调方传 dict（不是 json.dumps 字符串），plugin 透传。SKILL.md 警告：
> ADF 必须传 dict，不能传 json.dumps 后的字符串。`@mention` 必须用 ADF `mention` 节点。

## 6 method 详细规范

### 1. `jira.search`
- REST: `GET /rest/api/3/search`
- 入参: `jql` (string, required), `maxResults` (number, default 30), `fields` (array, default `["summary","status","issuetype","labels","created","issuelinks","parent"]`)
- 出参: 格式化文本（人类/LLM 用）或 raw JSON（看 `--json` flag 怎么设，沿用 outline-wiki 模式）

### 2. `jira.get`
- REST: `GET /rest/api/3/issue/{issueIdOrKey}`
- 入参: `issueIdOrKey` (string, required), `fields` (array, optional)
- 出参: 格式化文本

### 3. `jira.create`
- REST: `POST /rest/api/3/issue`
- 入参: `project` (key string, required), `issuetype` (name string, required), `summary` (string, required), `description` (ADF dict, optional)
- 出参: 创建的 issue key

### 4. `jira.update`
- REST: `PUT /rest/api/3/issue/{issueIdOrKey}`
- 入参: `issueIdOrKey` (string, required), `fields` (object, e.g. `{labels: ["x"], description: ADF}`)
- 出参: 204 No Content

### 5. `jira.comment`
- REST: `POST /rest/api/3/issue/{issueIdOrKey}/comment`
- 入参: `issueIdOrKey` (string, required), `body` (ADF dict, **必须**，不接受 string)
- 出参: 创建的 comment id

### 6. `jira.transition`
- REST: `GET /rest/api/3/issue/{issueIdOrKey}/transitions`（拿可用 transition）+ `POST /rest/api/3/issue/{issueIdOrKey}/transitions`（执行）
- 入参: `issueIdOrKey` (string, required), `targetStatus` (name string, e.g. `"In Progress"` / `"Done"` / `"REVIEW"`)
- 内部行为: get transitions → 匹配 `targetStatus` 拿到 transition id → post 执行
- 出参: 204 No Content
- 错误处理: `targetStatus` 找不到 → 返清晰错误（"targetStatus 'X' not in available transitions: [..]"）

## 文件结构

```
~/dev/projects/jira-openclaw-plugin/
├── package.json
├── openclaw.plugin.json
├── tsconfig.json
├── README.md
├── TASK.md                   (本文件)
├── skills/
│   └── jira/
│       └── SKILL.md
├── src/
│   ├── index.ts              (plugin 入口，registerTool('jira', ...))
│   ├── auth.ts               (ATST_TOKEN / CLOUD_ID / PROXY 加载 + fail-fast)
│   ├── http.ts               (fetch wrapper + proxy + 错误处理)
│   ├── dispatch.ts           (单 tool 分发：jira.{method} → handler)
│   └── handlers/
│       ├── search.ts
│       ├── get.ts
│       ├── create.ts
│       ├── update.ts
│       ├── comment.ts
│       └── transition.ts
└── tests/                    (可选，smoke test)
```

## `openclaw.plugin.json` 关键字段

```json
{
  "id": "jira-openclaw-plugin",
  "name": "Jira",
  "description": "OpenClaw native plugin for Jira Cloud REST API v3. Single dispatcher tool `jira` exposes search/get/create/update/comment/transition methods. Reads ATST_TOKEN / JIRA_CLOUD_ID / JIRA_PROXY from env (independent from mcporter).",
  "version": "0.1.0",
  "skills": ["./skills"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "atstToken": { "type": "string", "description": "(optional) Override ATST_TOKEN env var" },
      "cloudId": { "type": "string", "description": "(optional) Override JIRA_CLOUD_ID env var" },
      "proxy": { "type": "string", "description": "(optional) Override JIRA_PROXY env var" }
    }
  },
  "activation": { "onStartup": true },
  "contracts": { "tools": ["jira"] },
  "toolMetadata": { "jira": { "optional": true } }
}
```

## `package.json` 关键字段（参考 outline-wiki 0.3.1）

```json
{
  "name": "@cereb/jira-openclaw-plugin",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist", "openclaw.plugin.json", "README.md", "skills"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "clean": "rm -rf dist",
    "dev": "tsc --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "keywords": ["jira", "atlassian", "openclaw"],
  "description": "OpenClaw native plugin for Jira Cloud REST API v3 (replaces mcporter atlassian channel)",
  "peerDependencies": { "openclaw": ">=2026.3.24-beta.2" },
  "peerDependenciesMeta": { "openclaw": { "optional": true } },
  "devDependencies": {
    "@types/node": "^25.9.2",
    "openclaw": "latest",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0"
  }
}
```

## `skills/jira/SKILL.md` 9 section 范式

参考 `outline-wiki/SKILL.md` 写 9 个 section：

1. **调用形态三态** — `jira call search {...}` / `jira.call "search" '{...}'` / `jira.search {...}` 三种写法
2. **6 method 速查表** — 表格列 method / 用途 / REST endpoint / 必填参数
3. **4 个常见场景** — 例如："创建 WTO ticket 并加 label"、"给 ticket 加 In Progress 状态"、"读 ticket 详情"、"搜索我的未完成 ticket"
4. **7 条避坑清单** — 至少包含：
   - ADF 必须传 dict 不能传 string
   - `@mention` 必须用 ADF mention 节点（不是纯文本 @ 名字）
   - `description` 中的 @mention 不触发通知，只有 comment 中的才触发
   - transition 找不到 targetStatus → 返清晰错误（不是 silent 失败）
   - `cloudId` / `ATST_TOKEN` env 未设 → 返清晰错误（不是 silent 退化）
   - 代理未设 → 用默认 `http://172.29.176.1:7890`
   - **禁止 mcporter call atlassian.\***（统一路径原则）
5. **配置** — `ATST_TOKEN` / `JIRA_CLOUD_ID` / `JIRA_PROXY` env 怎么设（写进 `~/.bashrc` / `~/.config/environment.d/jira.conf` / systemd service 环境文件，三选一给推荐）
6. **MVP 范围** — 已实现 6 method（表格）+ 未实现 6 method（留 0.2.0）
7. **统一路径原则** — 显式声明"所有 agent 默认调 `jira` native tool，禁止 `mcporter call atlassian.*`"
8. **相关链接** — Atlassian 官方 REST API v3 文档（https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/）+ ADF playground
9. **贡献指南** — 怎么加新 method / 怎么跑 typecheck / 怎么 pack

## 实施 5 步闭环

1. **typecheck** — `npm run typecheck`（tsc --noEmit）零错误
2. **build** — `npm run build`（tsc）产出 `dist/`
3. **pack** — `npm pack` 产出 `cereb-jira-openclaw-plugin-0.1.0.tgz`
4. **install** — `openclaw plugins install npm-pack:./cereb-jira-openclaw-plugin-0.1.0.tgz`
5. **7 项自检**：
   - ① SKILL.md 在 plugin 包内（`npm pack --dry-run` 验证 files 包含 `skills/jira/SKILL.md`）
   - ② openclaw.plugin.json 声明（id=`jira-openclaw-plugin` / skills=`./skills` / contracts.tools=`["jira"]`）
   - ③ package.json files 字段包含 dist / openclaw.plugin.json / README.md / skills
   - ④ npm pack 重装（步骤 3-4 跑通）
   - ⑤ 用户本地 pty `systemctl --user restart openclaw-gateway.service`（**这一步不能 agent 自行做**，要等用户手动做——实施报告里要明确说"请 Leo 在本地 pty 执行 step 5"）
   - ⑥ `openclaw skills check` 全绿
   - ⑦ 端到端验证 — 用一个真实 issue 跑通 search → get → comment → transition 完整链路

## 端到端验收（dev 环境测试用）

**只读测试**（安全）：
- `jira search "project = WTO AND status != Done ORDER BY updated DESC" 5`
- `jira get WTO-70`（假设这个 issue 存在；不知道存在就用最近 updated 的某个 issue）

**写入测试**（要小心）：
- `jira comment <some-issue> {"body": {"version": 1, "type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "[plugin smoke test] jira-openclaw-plugin 0.1.0 端到端验证"}]}]}}`
- **不要跑** create / update / transition 在生产票上（先在报告里问 Leo 要一个测试票或确认在哪个票上跑写入测试）

**不写入** create / update / transition —— 报告里要明确列"已跑 X，未跑 Y（待 Leo 拍板在哪个票上跑）"。

## ⚠️ 关键安全约束

**ATST token 处理**：
- ❌ 不要把 ATST_TOKEN 写进任何文件（代码 / 配置文件 / commit message / 报告）
- ❌ 不要在 echo / log / debug print 里打印 token
- ✅ 只从 `process.env.ATST_TOKEN` 读
- ✅ 报告里只说"ATST_TOKEN 已从 env 读取并验证有效"，**不要展示 token 本身**
- ✅ 如果 token 调试需要，只显示前 8 字符 + `...`（如 `ATSTT3xF...`）

## 不要做的事

- ❌ 不要做 Confluence method
- ❌ 不要做 Phase B 的 6 method（add_label/remove_label/block/property_get/set/del）
- ❌ 不要读 mcporter.json
- ❌ 不要做 OAuth 3LO token refresh 流程（Leo 用的是 long-lived ATST_TOKEN，refresh 不在本期）
- ❌ 不要引入 axios/node-fetch 依赖（用 Node 18+ 原生 fetch）
- ❌ 不要在 plugin 内做 retry / 限流（留给调用方）
- ❌ 不要写 `~/.bashrc` 修改指南里的"永久"步骤（用户自己决定）

## 完成报告（必给）

实施完成后返回时**必须**给出：

1. **6 method 端到端验证结果**（pass/fail per method）—— 跑过的写入测试要附 ticket key 和 comment id
2. **7 项自检 checklist** —— ①~⑦ 每项 ✅/❌
3. **branch 状态** —— 建议 main 直 commit？还是 feature branch？等 Leo 拍板
4. **待 Leo 拍板的下一步** —— 例如"step ⑤ 需 Leo 在本地 pty 重启 gateway"、"写入测试需要 Leo 指定一个测试票"
5. **任何偏差** —— 如果实施过程中偏离了本任务描述（例如发现 ADF 实际只接受 string、或者 transition 需要额外参数），明确列出偏差并说明原因

## 协作上下文（背景信息，不需要回报）

- 主 session 协调者: devclaw (current)
- 用户: Leo（王凌松 / wanglinson）
- 关联 plugin: outline-wiki-openclaw-plugin 0.3.1（范式参考）
- 相关 skill: ~/.openclaw/skills/atlassian-tools/（老的 jira.sh 脚本，会保留作为降级路径）
- 主 session 拍板历史: 见 memory/2026-06-09.md（如果你能读到的话）

## 实施开始

请按本文件执行。**先读 outline-wiki 0.3.1 项目作为范式参考**，再开始写代码。
