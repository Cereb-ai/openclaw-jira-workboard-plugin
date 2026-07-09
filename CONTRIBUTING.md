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