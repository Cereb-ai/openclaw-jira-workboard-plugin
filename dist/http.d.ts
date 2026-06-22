import type { JiraConfig } from "./types.js";
export declare class JiraHttpError extends Error {
    status: number;
    statusText: string;
    body: string;
    constructor(status: number, statusText: string, body: string);
}
/**
 * GET path under the Atlassian cloud REST v3 root.
 * Path may include leading slash — we strip it.
 */
export declare function jiraGet(cfg: JiraConfig, path: string, query?: Record<string, string | number | boolean | undefined>): Promise<unknown>;
/**
 * POST path with JSON body. Body is stringified via JSON.stringify — caller
 * passes the plain object.
 */
export declare function jiraPost(cfg: JiraConfig, path: string, body: unknown): Promise<unknown>;
/**
 * PUT path with JSON body. For jira.update (issue edit).
 */
export declare function jiraPut(cfg: JiraConfig, path: string, body: unknown): Promise<unknown>;
