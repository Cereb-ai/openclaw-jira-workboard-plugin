/**
 * Shared types for the Jira plugin.
 *
 * Kept in a single file so handlers/auth/dispatch don't have to chase imports
 * across multiple type-only modules. The shape is intentionally narrow: the
 * plugin only uses ~6 entry points, and over-modelling the Atlassian schema
 * (hundreds of fields) would be YAGNI.
 */
export {};
