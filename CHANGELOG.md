# Changelog

All notable changes to `@cereb/jira-openclaw-plugin` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Open-source release: added `LICENSE` (MIT), `CONTRIBUTING.md`, `CHANGELOG.md`. Updated `package.json` metadata (license, author, repository, bugs, homepage) and removed `private: true`. Replaced internal proxy URL placeholder. Removed internal `TASK.md` (was a dev implementation brief, not part of OSS surface).

### Fixed
- `jira_create_task`: labels array now always includes the `"plan"` label, regardless of whether the caller passed `args.labels` (was a regression risk when caller passed `labels=[]`).

## [0.5.2] - 2026-09-09

### Changed
- `jira_submit_verdict` (FAIL branch): the escalation `PUT /issue/{key}` now adds both `"escalated"` and `"failed"` labels in one `update.labels` array (CP-2856 / planner A+E v0.11 §3 改动 C + §7.2 改动 9 + §7.3 label 语义分离). `"escalated"` remains the 瞬时派发信号 (routing / JQL / 父任务门只认这个); `"failed"` is the new 持久失败事实 label that survives `jira_abandon_task` (which keeps its `DEFAULT_LABELS_TO_REMOVE=["escalated"]` default — `failed` 天然保留, enabling the E 表 done 状态 to distinguish escalation sources). Return contract: top-level `label` (string) → `labels: [escalated, failed]` (array) on the FAIL success / FAIL-partial paths; PASS path unchanged.

## [0.5.1] - 2026-07-01

### Added
- `jira_upload_attachment` handler — replaces the legacy `curl + ATST_TOKEN` workaround; routes through the plugin's auth and proxy pipeline.

### Changed
- Tool descriptions now explicitly state atomicity (e.g. `jira_submit_verdict` posts verdict + transitions ticket in one round-trip vs two).

## [0.5.0] - 2026-06-30

### Added
- `jira_list_attachments`, `jira_get_attachment` — pull ticket attachment metadata + bytes (saves ~80% context vs `jira_get` with `fields: ['*all']`).
- `scripts/e2e_comment_list.mjs` — 7-scenario e2e harness for comment-list behavior.
- Skill triggers in `skills/jira/SKILL.md` for attachment / list-comments / get-comment patterns.

## [0.4.0] - 2026-06-12

### Changed
- **Breaking**: rewrote from `definePluginEntry` + single dispatcher tool to `defineToolPlugin` + 9 named tools. Each tool's parameters are a flat TypeBox object. The OpenClaw tool-discovery manifest reads static metadata without loading runtime code.

### Added
- Logical transitions (`done` / `in_progress` / `review` / `blocked` / `reopen` / `todo` / `cancelled`) — project-agnostic, matched via Atlassian `statusCategory`.

## [0.3.x] - 2026-06

### Changed
- `jira_create_task` / `jira_create_subtask`: `requirements`, `scope`, `acceptance_criteria` are plain-text strings (not ADF dicts, not arrays); the plugin auto-formats them into a 3-section ADF `description`.
- `jira_comment`: `body` is a plain-text string; the plugin auto-wraps it as ADF. Agents never need to construct ADF directly.

### Renamed
- `jira_complete_task` → `jira_submit_verdict` (more accurate naming).

## [0.2.x] - 2026-06

### Added
- Initial `definePluginEntry` + single-dispatcher tool shape (`atlassian.search`, `atlassian.get`, etc.).

## [0.1.0] - 2026-06-09

### Added
- Initial implementation: 6 read-only tools (`atlassian.search`, `atlassian.get`, `atlassian.list_comments`, `atlassian.get_comment`, `atlassian.transition`, `atlassian.create_task`).

[Unreleased]: https://github.com/Cereb-ai/openclaw-jira-workboard-plugin/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/Cereb-ai/openclaw-jira-workboard-plugin/releases/tag/v0.5.1
[0.5.0]: https://github.com/Cereb-ai/openclaw-jira-workboard-plugin/releases/tag/v0.5.0
[0.4.0]: https://github.com/Cereb-ai/openclaw-jira-workboard-plugin/releases/tag/v0.4.0