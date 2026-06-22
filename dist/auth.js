import * as fs from "node:fs";
import * as path from "node:path";
/**
 * Module-level plugin config set by index.ts register() from api.pluginConfig.
 * When set, this takes priority over process.env for atstToken/cloudId/proxy.
 * This enables token removal from environment variables — the token lives only
 * in openclaw.json plugins.entries.jira-openclaw-plugin.config.
 */
let _pluginConfig = null;
/**
 * Read plugin config from openclaw.json. Used as last-resort fallback for
 * CLI path (jira-tool) where _pluginConfig is never set by gateway registration
 * and env vars may be intentionally empty.
 */
function _readOpenClawPluginConfig() {
    try {
        const home = process.env.HOME || process.env.USERPROFILE || "/home/leoclaw";
        const cfgPath = path.join(home, ".openclaw", "openclaw.json");
        const raw = fs.readFileSync(cfgPath, "utf-8");
        const cfg = JSON.parse(raw);
        return cfg?.plugins?.entries?.["jira-openclaw-plugin"]?.config ?? {};
    }
    catch {
        return {};
    }
}
/**
 * Called once during plugin registration to capture api.pluginConfig.
 * After this call, loadConfig() will prefer pluginConfig fields over env vars.
 */
export function setPluginConfig(cfg) {
    _pluginConfig = cfg ?? null;
}
/**
 * Default proxy: empty string = no proxy, connect directly.
 *
 * The previous hardcoded "http://172.29.176.1:7890" (WSL2 host gateway IP)
 * silently routed Jira traffic through the developer's local proxy outside
 * of any explicit configuration. Empty default makes proxy opt-in: callers
 * must set JIRA_PROXY (env or openclaw.json config override) to route
 * through a proxy.
 */
const DEFAULT_PROXY = "";
export class JiraAuthError extends Error {
    constructor(message) {
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
    constructor(message) {
        super(message);
        this.name = "JiraPluginError";
    }
}
/**
 * Resolve Jira runtime config. Throws JiraAuthError if required vars missing.
 *
 * `cfg` is the openclaw plugin config (optional override surface). We accept
 * partial overrides — if a field is set in cfg it wins over env, otherwise
 * env wins. This mirrors outline-wiki 0.3.1 behavior.
 */
export function loadConfig(cfg = {}) {
    // Resolution order: explicit arg > api.pluginConfig (from openclaw.json) > env
    const effectiveCfg = {
        ...(_pluginConfig ?? {}),
        ...cfg,
    };
    // CLI path: when _pluginConfig is unset and env vars are empty, fall back
    // to reading openclaw.json plugin config directly (the token no longer
    // lives in env vars after the security migration).
    const openClawCfg = !_pluginConfig && !process.env.ATST_TOKEN
        ? _readOpenClawPluginConfig()
        : {};
    const atstToken = (typeof effectiveCfg.atstToken === "string" && effectiveCfg.atstToken.length > 0
        ? effectiveCfg.atstToken
        : typeof openClawCfg.atstToken === "string" && openClawCfg.atstToken.length > 0
            ? openClawCfg.atstToken
            : process.env.ATST_TOKEN) ?? "";
    const cloudId = (typeof effectiveCfg.cloudId === "string" && effectiveCfg.cloudId.length > 0
        ? effectiveCfg.cloudId
        : typeof openClawCfg.cloudId === "string" && openClawCfg.cloudId.length > 0
            ? openClawCfg.cloudId
            : process.env.JIRA_CLOUD_ID) ?? "";
    const proxy = (typeof effectiveCfg.proxy === "string" && effectiveCfg.proxy.length > 0
        ? effectiveCfg.proxy
        : typeof openClawCfg.proxy === "string" && openClawCfg.proxy.length > 0
            ? openClawCfg.proxy
            : process.env.JIRA_PROXY) || DEFAULT_PROXY;
    // Optional — orchestrator create_task / create_subtask implicit assignee.
    // Missing is fine: those methods simply skip the assignee field.
    const defaultAssigneeAccountId = (typeof effectiveCfg.defaultAssigneeAccountId === "string" &&
        effectiveCfg.defaultAssigneeAccountId.length > 0
        ? effectiveCfg.defaultAssigneeAccountId
        : typeof openClawCfg.defaultAssigneeAccountId === "string" &&
            openClawCfg.defaultAssigneeAccountId.length > 0
            ? openClawCfg.defaultAssigneeAccountId
            : process.env.JIRA_DEFAULT_ASSIGNEE_ACCOUNT_ID) ?? "";
    const missing = [];
    if (!atstToken)
        missing.push("ATST_TOKEN");
    if (!cloudId)
        missing.push("JIRA_CLOUD_ID");
    if (missing.length > 0) {
        throw new JiraAuthError(`Jira plugin is not configured. Missing required env var(s): ${missing.join(", ")}. ` +
            `Set them in ~/.config/environment.d/jira.conf (recommended) or ~/.bashrc, ` +
            `or pass via openclaw.json plugins.entries.jira-openclaw-plugin.config.{atstToken,cloudId}. ` +
            `See skills/jira/SKILL.md §配置.`);
    }
    return { atstToken, cloudId, proxy, defaultAssigneeAccountId };
}
/**
 * Build the Atlassian Cloud REST API v3 base URL for the given cloudId.
 * Endpoint shape: https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3
 *
 * Single source of truth — http.ts calls this, no hardcoded URLs elsewhere.
 */
export function atlassianApiBase(cloudId) {
    return `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3`;
}
