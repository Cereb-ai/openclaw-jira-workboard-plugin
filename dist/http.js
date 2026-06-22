/**
 * Fetch wrapper for Atlassian Cloud REST API v3.
 *
 * - Bearer auth via ATST_TOKEN (OAuth 2.0 3LO access token).
 *
 * - Proxy support via undici.ProxyAgent passed per-fetch as the `dispatcher`
 *   option. This replaces the previous process.env mutation pattern
 *   (HTTPS_PROXY/HTTP_PROXY) which had two defects:
 *     1. process.env is process-global — any fetch (not just ours) running
 *        on the same Node process saw the proxy. Hard to reason about.
 *     2. Setting/clearing those env vars across concurrent requests was
 *        racy; our save/restore only helped when requests were serialized.
 *   Per-fetch dispatcher is scope-local: only the call we wrap uses the
 *   proxy, and no global state is touched.
 *
 *   undici is a runtime dep (mirrors wecom-openclaw-plugin precedent). Node
 *   18+ global fetch is undici under the hood, so the same dispatcher
 *   powers global fetch and our explicit ProxyAgent.
 *
 * - Hostname guard: the dispatcher is attached ONLY for requests to
 *   `api.atlassian.com`. This is defensive — even if a future code change
 *   adds a non-Jira URL by accident, the proxy will not silently reroute
 *   it. Non-matching fetches go through the global pool with no proxy.
 *
 * - Empty cfg.proxy → no dispatcher at all (direct connection).
 *
 * - Throws JiraHttpError on non-2xx with body snippet so agent sees
 *   actionable error. Proxy/DNS/connect failures surface as undici's
 *   native errors (caller can catch and report).
 *
 * - No retry, no rate-limit handling. Caller's responsibility. (Per
 *   TASK.md "不要在 plugin 内做 retry / 限流".)
 */
import { ProxyAgent } from "undici";
import { atlassianApiBase } from "./auth.js";
export class JiraHttpError extends Error {
    status;
    statusText;
    body;
    constructor(status, statusText, body) {
        super(`HTTP ${status} ${statusText}: ${truncate(body, 500)}`);
        this.name = "JiraHttpError";
        this.status = status;
        this.statusText = statusText;
        this.body = body;
    }
}
function truncate(s, n) {
    return s.length > n ? `${s.slice(0, n)}…` : s;
}
/**
 * Hostname guard: only Atlassian Cloud API requests may be routed through
 * the configured proxy. Any other host falls through to the global fetch
 * pool (no dispatcher attached) so it cannot be silently proxied.
 */
const PROXIED_HOSTNAME = "api.atlassian.com";
/** Build a URL for the given REST path under the Atlassian cloud root. */
function buildUrl(cfg, path, query) {
    const base = atlassianApiBase(cfg.cloudId);
    const cleanPath = path.replace(/^\/+/, "");
    const url = new URL(`${base}/${cleanPath}`);
    if (query) {
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined)
                continue;
            url.searchParams.set(k, String(v));
        }
    }
    return url.toString();
}
function authHeaders(cfg) {
    return {
        Authorization: `Bearer ${cfg.atstToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
    };
}
/** ProxyAgent cache keyed by proxy URI to avoid per-call TCP connect storm. */
const agentCache = new Map();
/**
 * Decide whether to attach a ProxyAgent dispatcher for this request.
 *
 * - cfg.proxy must be non-empty (empty = direct).
 * - URL hostname must be the Atlassian Cloud host (guardrail).
 *
 * Returns a cached ProxyAgent (lazy-init, reused across calls).
 * Cache lifetime = process lifetime (re-create on Gateway restart).
 */
function dispatcherFor(cfg, url) {
    if (!cfg.proxy)
        return undefined;
    if (url.hostname !== PROXIED_HOSTNAME)
        return undefined;
    if (!agentCache.has(cfg.proxy)) {
        agentCache.set(cfg.proxy, new ProxyAgent({ uri: cfg.proxy }));
    }
    return agentCache.get(cfg.proxy);
}
/**
 * GET path under the Atlassian cloud REST v3 root.
 * Path may include leading slash — we strip it.
 */
export async function jiraGet(cfg, path, query) {
    const url = new URL(buildUrl(cfg, path, query));
    const dispatcher = dispatcherFor(cfg, url);
    const res = await fetch(url, {
        method: "GET",
        headers: authHeaders(cfg),
        ...(dispatcher ? { dispatcher } : {}),
    });
    return parseResponse(res);
}
/**
 * POST path with JSON body. Body is stringified via JSON.stringify — caller
 * passes the plain object.
 */
export async function jiraPost(cfg, path, body) {
    const url = new URL(buildUrl(cfg, path));
    const dispatcher = dispatcherFor(cfg, url);
    const res = await fetch(url, {
        method: "POST",
        headers: authHeaders(cfg),
        body: JSON.stringify(body),
        ...(dispatcher ? { dispatcher } : {}),
    });
    return parseResponse(res);
}
/**
 * PUT path with JSON body. For jira.update (issue edit).
 */
export async function jiraPut(cfg, path, body) {
    const url = new URL(buildUrl(cfg, path));
    const dispatcher = dispatcherFor(cfg, url);
    const res = await fetch(url, {
        method: "PUT",
        headers: authHeaders(cfg),
        body: JSON.stringify(body),
        ...(dispatcher ? { dispatcher } : {}),
    });
    return parseResponse(res);
}
async function parseResponse(res) {
    const text = await res.text();
    if (!res.ok) {
        throw new JiraHttpError(res.status, res.statusText, text);
    }
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
