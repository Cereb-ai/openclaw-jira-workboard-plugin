/**
 * Jira plugin env loading + fail-fast.
 *
 * Resolution order for each var (matches outline-wiki 0.3.1 override pattern):
 *   1. cfg.<field>  (from openclaw.json plugins.entries.<id>.config — optional override)
 *   2. process.env.<VAR>  (env var — primary path)
 *
 * Required: ATST_TOKEN, JIRA_CLOUD_ID. Missing → fail-fast with actionable error.
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
 */
import type { JiraConfig } from "./types.js";
/**
 * Called once during plugin registration to capture api.pluginConfig.
 * After this call, loadConfig() will prefer pluginConfig fields over env vars.
 */
export declare function setPluginConfig(cfg: Partial<JiraConfig> | null): void;
export declare class JiraAuthError extends Error {
    constructor(message: string);
}
/**
 * JiraPluginError — thrown by handlers when an argument is structurally
 * invalid (vs JiraAuthError for config or JiraHttpError for upstream).
 *
 * Surfaced to the agent as a hard failure so callers can fix the call
 * (missing required field, bad shape) rather than retry blindly.
 */
export declare class JiraPluginError extends Error {
    constructor(message: string);
}
/**
 * Resolve Jira runtime config. Throws JiraAuthError if required vars missing.
 *
 * `cfg` is the openclaw plugin config (optional override surface). We accept
 * partial overrides — if a field is set in cfg it wins over env, otherwise
 * env wins. This mirrors outline-wiki 0.3.1 behavior.
 */
export declare function loadConfig(cfg?: Partial<JiraConfig>): JiraConfig;
/**
 * Build the Atlassian Cloud REST API v3 base URL for the given cloudId.
 * Endpoint shape: https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3
 *
 * Single source of truth — http.ts calls this, no hardcoded URLs elsewhere.
 */
export declare function atlassianApiBase(cloudId: string): string;
