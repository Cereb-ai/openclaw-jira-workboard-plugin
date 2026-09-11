/**
 * Jira plugin env loading + fail-fast.
 *
 * Resolution order for each var (CP-2955, env-first):
 *   1. cfg.<field>           — explicit per-call argument (e.g. CLI tool call)
 *   2. process.env.<VAR>     — env var, primary path (both MCP and CLI)
 *      - token: JIRA_ATST_TOKEN preferred, ATST_TOKEN as legacy alias
 *      - cloudId: JIRA_CLOUD_ID
 *      - proxy: JIRA_PROXY
 *   3. openclaw.json config — last-resort fallback (CLI only; missing file is NOT an error)
 *
 * Required: atstToken, cloudId. Missing → fail-fast with actionable error.
 * Optional: JIRA_PROXY (default "" = direct connection, no proxy).
 *   Set to a proxy URL (e.g. "http://127.0.0.1:7890") to route api.atlassian.com
 *   calls through that proxy. The proxy is applied per-fetch via undici's
 *   ProxyAgent (see http.ts); it is NOT a process-wide env mutation.
 * Optional (orchestrator 0.3.0+): JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID.
 *   Used by create_task / create_subtask as the implicit assignee. Missing
 *   → that field is skipped (issue created unassigned). Not fail-fast.
 *
 * No retry / no silent fallback. The caller (agent) needs to know clearly
 * what's missing so it can fix the env, not papering over with a degraded
 * path that breaks later.
 *
 * Why env-first (CP-2955): the previous order (pluginConfig > env) forced a
 * secret copy from K8s Secret → env → initContainer sed → openclaw.json
 * (PVC plaintext). New order lets ops drop the initContainer and remove the
 * PVC plaintext entirely; the token lives only in env. Both MCP and CLI
 * paths resolve env first, so a single env block works for either path.
 */
import type { JiraConfig } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Module-level plugin config set by index.ts register() from api.pluginConfig.
 * Kept for backward compatibility — handlers still call setPluginConfig() to
 * bridge the OpenClaw config into a module variable. In CP-2955 env-first mode
 * this is only consulted as a last-resort fallback when env is also empty AND
 * the caller explicitly opted into "fall back to file" via the CLI path.
 */
let _pluginConfig: Partial<JiraConfig> | null = null;

/**
 * Read plugin config from openclaw.json. Used as last-resort fallback for
 * CLI path (jira-tool) where _pluginConfig is never set by gateway registration
 * and env vars may be intentionally empty.
 *
 * CP-2955: a missing config file is NOT an error — callers must work purely
 * off env. The function returns {} on any I/O / parse error so the upstream
 * error message can point the user at env (not at the file path).
 */
function _readOpenClawPluginConfig(): Partial<JiraConfig> {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || "/home/leoclaw";
    const cfgPath = path.join(home, ".openclaw", "openclaw.json");
    const raw = fs.readFileSync(cfgPath, "utf-8");
    const cfg = JSON.parse(raw);
    return cfg?.plugins?.entries?.["jira-openclaw-plugin"]?.config ?? {};
  } catch {
    return {};
  }
}

/**
 * Called once during plugin registration to capture api.pluginConfig.
 * After this call, loadConfig() will still prefer env vars over the
 * plugin config — see CP-2955 env-first semantics above.
 */
export function setPluginConfig(cfg: Partial<JiraConfig> | null): void {
  _pluginConfig = cfg ?? null;
}

/**
 * Default proxy: empty string = no proxy, connect directly.
 *
 * The previous default pointed at a developer's WSL2 host gateway proxy IP,
 * which silently routed Jira traffic through a local proxy outside of any
 * explicit configuration. Empty default makes proxy opt-in: callers must
 * set JIRA_PROXY (env or openclaw.json config override) to route through
 * a proxy.
 */
const DEFAULT_PROXY = "";

export class JiraAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraAuthError";
  }
}

/**
 * JiraPluginError — thrown by handlers when an argument is structurally
 * invalid (vs JiraAuthError for config or JiraHttpError for upstream).
 *
 * Surfaced to the agent as a hard failure so callers can fix the call
 * (missing required field, bad shape) rather than retry blindly.
 */
export class JiraPluginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraPluginError";
  }
}

/**
 * Pick the first non-empty string from a list of candidates. Empty string
 * is treated as "unset" (so an empty env var doesn't shadow a later source).
 */
function pickFirstString(...candidates: Array<string | undefined | null>): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}

/**
 * Resolve token from explicit cfg > env (JIRA_ATST_TOKEN > ATST_TOKEN) > openclaw.json > "".
 * CP-2955: env wins over openclaw.json so a single env block works for both
 * MCP and CLI paths; JIRA_ATST_TOKEN is the preferred name (matches K8s chart
 * env injection), ATST_TOKEN is the legacy alias kept for backward compat.
 */
function resolveToken(cfg: Partial<JiraConfig>, openClawCfg: Partial<JiraConfig>): string {
  return pickFirstString(
    cfg.atstToken,
    process.env.JIRA_ATST_TOKEN,
    process.env.ATST_TOKEN,
    openClawCfg.atstToken,
  );
}

/**
 * Resolve cloudId from explicit cfg > env (JIRA_CLOUD_ID) > openclaw.json > "".
 */
function resolveCloudId(cfg: Partial<JiraConfig>, openClawCfg: Partial<JiraConfig>): string {
  return pickFirstString(
    cfg.cloudId,
    process.env.JIRA_CLOUD_ID,
    openClawCfg.cloudId,
  );
}

/**
 * Resolve proxy from explicit cfg > env (JIRA_PROXY) > openclaw.json > DEFAULT_PROXY.
 */
function resolveProxy(cfg: Partial<JiraConfig>, openClawCfg: Partial<JiraConfig>): string {
  const v = pickFirstString(
    cfg.proxy,
    process.env.JIRA_PROXY,
    openClawCfg.proxy,
  );
  return v || DEFAULT_PROXY;
}

/**
 * Resolve JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID — same env-first ordering, used by
 * create_task / create_subtask as implicit assignee.
 */
function resolveDefaultAssignee(cfg: Partial<JiraConfig>, openClawCfg: Partial<JiraConfig>): string {
  return pickFirstString(
    cfg.defaultAssigneeAccountId,
    process.env.JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID,
    openClawCfg.defaultAssigneeAccountId,
  );
}

/**
 * Resolve Jira runtime config. Throws JiraAuthError if required vars missing.
 *
 * Resolution order (CP-2955, env-first):
 *   1. explicit `cfg.<field>` argument (per-call override)
 *   2. process.env (token: JIRA_ATST_TOKEN > ATST_TOKEN; cloudId: JIRA_CLOUD_ID;
 *      proxy: JIRA_PROXY; defaultAssignee: JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID)
 *   3. openclaw.json plugins.entries.jira-openclaw-plugin.config.<field> —
 *      last-resort fallback. Missing file is silently treated as empty
 *      (returns {}) so the env-only CLI path works without an openclaw.json.
 *
 * `cfg` is the per-call override surface; `effectiveCfg` (kept for clarity in
 * debugging) shows the merged candidate set before pickFirstString trims empty
 * values.
 */
export function loadConfig(cfg: Partial<JiraConfig> = {}): JiraConfig {
  // Per-call explicit args win over everything else. _pluginConfig (set by
  // OpenClaw gateway from openclaw.json) is intentionally NOT prepended to
  // effectiveCfg anymore — env now wins over it (CP-2955 env-first). The
  // openclaw.json file is read separately as the last fallback.
  const explicitCfg: Partial<JiraConfig> = { ...cfg };

  // Last-resort fallback: openclaw.json config. The gateway-bridged copy
  // (_pluginConfig) takes precedence; otherwise we re-read the file directly
  // for the CLI path. env always wins over this fallback (CP-2955 env-first).
  // Missing file is silently treated as empty so the env-only CLI path
  // stays valid — the upstream error message can then point at env instead
  // of misleadingly blaming the file path.
  const openClawCfg = _pluginConfig ?? _readOpenClawPluginConfig();

  const atstToken = resolveToken(explicitCfg, openClawCfg);
  const cloudId = resolveCloudId(explicitCfg, openClawCfg);
  const proxy = resolveProxy(explicitCfg, openClawCfg);
  const defaultAssigneeAccountId = resolveDefaultAssignee(explicitCfg, openClawCfg);

  const missing: string[] = [];
  if (!atstToken) missing.push("JIRA_ATST_TOKEN (or legacy ATST_TOKEN)");
  if (!cloudId) missing.push("JIRA_CLOUD_ID");
  if (missing.length > 0) {
    throw new JiraAuthError(
      `Jira plugin is not configured. Missing required env var(s): ${missing.join(", ")}. ` +
        `Set the env var(s) (e.g. export JIRA_ATST_TOKEN=...; export JIRA_CLOUD_ID=...) ` +
        `before starting the agent / running jira-tool. ` +
        `Optionally provide them via openclaw.json plugins.entries.jira-openclaw-plugin.config.{atstToken,cloudId} ` +
        `as a last-resort fallback (env always wins). ` +
        `See skills/jira/SKILL.md §配置 for the full list of env vars.`,
    );
  }

  return { atstToken, cloudId, proxy, defaultAssigneeAccountId };
}

/**
 * Build the Atlassian Cloud REST API v3 base URL for the given cloudId.
 * Endpoint shape: https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3
 *
 * Single source of truth — http.ts calls this, no hardcoded URLs elsewhere.
 */
export function atlassianApiBase(cloudId: string): string {
  return `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
}