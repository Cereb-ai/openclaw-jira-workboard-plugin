import { MVP_METHODS } from "./dispatch.js";
declare const _default: {
    id: string;
    name: string;
    description: string;
    configSchema: import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginConfigSchema;
    register: NonNullable<import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginDefinition["register"]>;
} & Pick<import("openclaw/plugin-sdk/plugin-entry").OpenClawPluginDefinition, "kind" | "reload" | "nodeHostCommands" | "securityAuditCollectors">;
export default _default;
/**
 * Re-export MVP method list for any host that wants to introspect the
 * plugin (e.g. openclaw skills check, doc generation).
 */
export { MVP_METHODS };
