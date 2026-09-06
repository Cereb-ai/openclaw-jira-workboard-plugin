# Contributing

Thanks for your interest in contributing to `@cereb/jira-openclaw-plugin`!

## Prerequisites

- **Node.js** ≥ 18 (uses native `fetch`, `FormData`, and ESM)
- **OpenClaw** runtime installed (`openclaw` CLI available, gateway running under systemd)
- **Jira Cloud** account with an OAuth 2.0 3LO access token (for live testing)

## Development setup

```bash
# 1. Clone
git clone https://github.com/Cereb-ai/openclaw-jira-workboard-plugin.git
cd openclaw-jira-workboard-plugin

# 2. Install dependencies (peer dep `openclaw` is dev-installed automatically)
npm install

# 3. Typecheck and build
npm run typecheck
npm run build

# 4. Run tests
npm test
```

## Code structure

- `src/index.ts` — plugin manifest + tool definitions (`defineToolPlugin`)
- `src/auth.ts` — env / openclaw.json config resolution + fail-fast
- `src/http.ts` — `fetch` wrapper with proxy support via `undici.ProxyAgent`
- `src/cli.ts` — standalone `jira-tool` CLI
- `src/handlers/<tool>.ts` — one handler per named tool (1:1 with `contracts.tools` in `openclaw.plugin.json`)
- `src/handlers/<tool>.test.ts` — vitest unit tests
- `skills/jira/SKILL.md` — OpenClaw agent skill (YAML frontmatter + markdown); loaded automatically when the plugin is installed
- `openclaw.plugin.json` — plugin manifest read by OpenClaw at startup

## Adding a new tool

1. Create `src/handlers/<new_tool>.ts` exporting `async function newTool(args, cfg)`.
2. Add a tool definition in `src/index.ts`:
   ```ts
   tool({
     name: "jira_new_tool",
     label: "Jira New Tool",
     description: "...",
     parameters: Type.Object({...}),
     async execute(args, cfg) {
       return await newTool(args, cfg);
     },
   }),
   ```
3. Add `"jira_new_tool"` to `contracts.tools` in `openclaw.plugin.json`.
4. Regenerate the manifest:
   ```bash
   npm run build
   npx openclaw plugins build --entry ./dist/index.js
   npx openclaw plugins validate --entry ./dist/index.js
   ```
5. Add a vitest test in `src/handlers/new_tool.test.ts`.
6. Document the tool in `skills/jira/SKILL.md` (description + 必填 + 常用选填 + any 避坑 entry).

## Testing

- **Unit tests** — `npm test` (vitest, runs all `*.test.ts` files)
- **Live e2e** — manually invoke a tool from your agent harness against a sandbox Jira Cloud instance; the project's `scripts/e2e_*.mjs` files are the historical e2e harness pattern

## Code style

- **TypeScript strict mode** (already enabled in `tsconfig.json`).
- **TypeBox schemas** for tool parameters (declared inline in the tool block).
- **No silent fallbacks** — missing config must `throw JiraAuthError`, not return a degraded result.
- **Fail-fast with actionable error messages** — point the caller at the missing field and how to set it (env var or `openclaw.json` override).
- **Mask tokens in logs / errors** — never print raw `atstToken` values to chat, logs, or commit messages.

## Submitting a pull request

1. Fork and create a feature branch: `git checkout -b feat/<short-description>`
2. Make focused commits with descriptive messages.
3. Ensure `npm run typecheck`, `npm run build`, and `npm test` all pass.
4. Push and open a PR against `master` on the upstream repo.
5. Describe the change in the PR body: what, why, how to test.
6. Reference any related Jira issue keys (project prefix `JCP-` for plugin-specific work).

## Changing a tool's return shape

> **起源**: 2026-09 v0.5 提案 (`RRmzJTZ7Q8` §联动同步 SOP). 试点 G1-G7
> (jira_get + jira_list_comments) 落地暴露: §核心原则 5「改字段 = 改白名单
> 常量 + description + 注释三处同步」只覆盖代码内三处, 实际漏了 skill 契约表 /
> 单测 fixture / README / 下游 consumer 四类联动面. 教训: **改返回结构 = 改
> 契约**; 跨组件契约变更必须先列 consumer 清单再动手. **本仓无下游程序 API
> 依赖 ≠ 无 consumer** (dispatcher `jira_lib.py` 实为下游读取方).

适用范围: **任何改动 tool 返回结构/字段的 code 票** — 增删改字段、改默认值/
阈值/截断/翻页语义都算, 不因「小改动」豁免. PR 描述必须附九面核验表 (ⓐ-ⓘ
逐面 ✅ / NA+理由), 任一联动面缺失 = PR 不合规, 不 merge.

### 联动面 checklist (九面 ⓐ-ⓘ)

| 面 | 同步对象 | 校验方式 / 触发时机 |
|---|---|---|
| ⓐ | `src/handlers/*.ts`: 字段白名单常量 (get.ts DEFAULT_FIELDS / formatXxx 输出字段集) + 截断/阈值常量 (ATTACHMENT_CAP / body 500 / DEFAULT_MAX_RESULTS) + 返回对象构造处 | 触发: 任何返回结构/字段/阈值改动. 校验: `git diff` 字段名出现点全查 + `npm run typecheck`; 字段删除后全仓 grep 确认 0 残留引用 |
| ⓑ | `src/index.ts` 每 tool `description` 文本 (agent 可见契约: 白名单字段 + 截断/翻页/附件策略 + details 摘要) | 触发: 同 ⓐ. 校验: description 与 handler 实现逐字段对照; v0.5 §description 草稿池为可粘贴源, 改结构 → 草稿池同改 |
| ⓒ | `src/handlers/<tool>.ts` 文件顶部契约注释 (返回结构示例 + 字段说明, 维护者可见) | 触发: 文件有结构改动即同步. 校验: 与 ⓐ/ⓑ 三方一致 |
| ⓓ | `skills/jira/SKILL.md` 返回字段契约段 (仓库 SKILL.md 契约表/返回字段段; 字段名与白名单建议/草稿池一致) | 触发: 本批工具结构定稿即补齐契约表行. 校验: grep SKILL.md 字段名 vs handler 实现, 防「文档承诺 ≠ 实现」 |
| ⓔ | `README.md` Tools 表 / 行为说明 | 触发: **行为变化时** (默认值/截断/翻页/逃生舱引导变化); 纯内部瘦身不改行为可不动, 但 README 引用到的被删字段须清理. 校验: README 相关段与 description 对照 |
| ⓕ | `src/handlers/<tool>.test.ts` fixture 数据 + 断言 (返回字段存在性/计数/阈值/**details 结构**) | 触发: 结构改动必跑 `npm test` 全绿. 校验: 断言逐条对照新结构; `details=content` 的旧断言会挂, 与附件数量断言重点排查 |
| ⓖ | `CHANGELOG.md` 条目 (结构/行为变更); 版本发布记录 | 触发: PR 合并/发布前补条目. 校验: 与 tag bump 同步 (部署 = 镜像 bake + 4 处 tag bump) |
| ⓗ | **下游 consumer 扫描**: 仓外读取方清单 — dispatcher `jira_lib.py` (agent pipeline 读取层) 等 | 触发: **任何结构变更 PR 开写前**先列 consumer 清单. 校验: 逐 consumer 核对受影响字段 (改名/删除/语义变化), 适配或显式排期. 见下方扫描指引 |
| ⓘ | Cereb 知识库「返回结构/契约」类文档 (outline) | 触发: **如有**描述本结构的 KB 文档且行为/结构变化影响描述. 校验: outline 检索定位 → 描述同步 |

NA 判定仅限 ⓔ / ⓘ 的「行为变化 / 如有」触发判断; 其余 7 面均必填.

### 下游 consumer 扫描指引 (ⓗ 展开)

1. **先列清单再动手**: 结构变更 PR 开写前, 先 grep 本工具返回字段名
   (如 `rawCount` / `nextStartAt` / `attachments` / `summary`) 在相邻组件 /
   仓外的引用点; 已知固定 consumer = dispatcher `jira_lib.py` (agent pipeline
   读取层) — **本仓无下游程序 API 依赖 ≠ 无 consumer**.
2. **区分结构变化类型**: ① 字段删除 / 改名 / 语义变化 → consumer 侧逐点
   核对, 需适配的同步改或显式排适配票, 禁止静默; ② 纯新增字段 / 纯瘦身
   (去重、details 摘要化) → 低风险, 但 ⓑ / ⓓ description 与 SKILL.md 承诺
   必须同步.
3. **双入口自检**: MCP named tool 与 jira-tool CLI 共用同一 handler (共享
   `src/handlers/*.ts`) → 插件内无二次同步面; 但 CLI 输出被脚本 / 测试引用
   时按 consumer 对待.
4. **验证闭环**: 每批推广对 dispatcher 跑一次真实流程冒烟 (create task →
   list comments → submit verdict), 防「结构对但语义假设破」类卡死.

> 历史事故: 试点 jira_list_comments 部署后 dispatcher `jira_lib.py` 未适配
> 新返回结构 (total / returned / nextStartAt 替代旧 rawCount / count /
> summary), 卡死 \~20min. 任何跨仓契约变更前必须先核 ⓗ.

## Reporting issues

Open an issue at https://github.com/Cereb-ai/openclaw-jira-workboard-plugin/issues with:

- OpenClaw version (`openclaw --version`)
- Plugin version (`cat package.json | grep version`)
- Minimal reproduction (the tool call + the error response)
- Relevant logs (mask any tokens!)

## Security

For vulnerabilities, please **do not** open a public issue. Email `wanglingsong@gmail.com` with subject `SECURITY: jira-openclaw-plugin` instead. See [SECURITY.md](SECURITY.md) (if present) for the full disclosure policy.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).