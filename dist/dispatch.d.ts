/**
 * jira-openclaw-plugin — single dispatcher removed (0.4.0).
 *
 * The plugin now uses 9 named tools (one per Jira method) via api.registerTool
 * in src/index.ts. Handlers call textResult() directly. This file remains
 * as the canonical home for the textResult helper so existing imports in
 * src/handlers/*.ts keep working without churn.
 */
import type { ToolResult } from "./types.js";
export declare function textResult(data: unknown): ToolResult;
