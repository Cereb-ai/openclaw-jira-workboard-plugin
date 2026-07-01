/**
 * Shared transition-finder used by jira_transition + jira_submit_verdict.
 *
 * Project-agnostic: matches by Jira's statusCategory (a platform-level
 * standard with 3 keys: 'new' / 'indeterminate' / 'done'). No hardcoded
 * status names — works across SSSS (已完成), CP (complete), and any
 * project regardless of language.
 *
 * Matching algorithm (3-tier, first hit wins):
 *
 *   1. LOGICAL ALIAS → statusCategory key
 *      'todo' / 'backlog'           → category 'new'         (id=1)
 *      'in_progress' / 'progress'   → category 'indeterminate' (id=4)
 *      'done' / 'closed' / 'complete' → category 'done'      (id=3)
 *
 *   2. BUSINESS-STATE NAME REGEX (multi-language fallback)
 *      'review'  → /review|审查|评审|in.review/i
 *      'blocked' → /block/i
 *      'reopen'  → /reopen|重新打开/i
 *      (also catches non-canonical project names like "Reviewing")
 *
 *   3. EXACT NAME MATCH (case-insensitive, last-resort)
 *      Used when the project has non-standard statuses that don't fit
 *      the above. The caller must know the exact name.
 *
 * Atlassian statusCategory reference:
 *   id=1, key='new'           — not started (todo)
 *   id=2, key='complete'      — legacy 'complete' (rare)
 *   id=3, key='done'          — finished (success or failure)
 *   id=4, key='indeterminate' — actively in progress
 */

export interface AtlassianTransition {
  id: string;
  name: string;
  to?: {
    name?: string;
    statusCategory?: { id?: number; key?: string };
  };
}

const LOGICAL_TO_CATEGORY: Record<string, string> = {
  todo: "new",
  backlog: "new",
  new: "new",
  open: "new",

  in_progress: "indeterminate",
  progress: "indeterminate",
  doing: "indeterminate",
  active: "indeterminate",

  done: "done",
  closed: "done",
  complete: "done",
  completed: "done",
  resolved: "done",
};

const CATEGORY_KEY_TO_ID: Record<string, number> = {
  new: 1,
  complete: 2,
  done: 3,
  indeterminate: 4,
};

const BUSINESS_STATE_PATTERNS: Record<string, RegExp> = {
  review: /review|审查|评审|reviewing|in.review/i,
  blocked: /\bblock|阻塞/i,
  reopen: /reopen|重新打开|re.open/i,
  cancelled: /cancel|取消|abort/i,
};

export interface FindResult {
  match: AtlassianTransition | null;
  /** How we matched — useful for the error hint. */
  matchedBy: "category" | "business-pattern" | "exact-name" | null;
}

/**
 * Find the transition matching the agent's logical or exact target status.
 * Returns null + matchedBy=null if no match.
 */
export function findTransition(
  transitions: AtlassianTransition[],
  targetStatus: string,
): FindResult {
  const want = targetStatus.trim().toLowerCase();
  if (!want) return { match: null, matchedBy: null };

  // Tier 1: logical alias → statusCategory
  const wantCategory = LOGICAL_TO_CATEGORY[want];
  if (wantCategory) {
    const wantId = CATEGORY_KEY_TO_ID[wantCategory];
    const m = transitions.find((t) => {
      const cat = t.to?.statusCategory;
      if (!cat) return false;
      // Match by either key (preferred) or id (belt-and-suspenders)
      if (cat.key && cat.key.toLowerCase() === wantCategory) return true;
      if (typeof cat.id === "number" && cat.id === wantId) return true;
      return false;
    });
    if (m) return { match: m, matchedBy: "category" };
  }

  // Tier 2: business-state regex
  const pattern = BUSINESS_STATE_PATTERNS[want];
  if (pattern) {
    const m = transitions.find((t) => pattern.test(t.to?.name ?? ""));
    if (m) return { match: m, matchedBy: "business-pattern" };
  }

  // Tier 3: exact name match (case-insensitive)
  const m = transitions.find(
    (t) => (t.to?.name ?? "").toLowerCase() === want,
  );
  if (m) return { match: m, matchedBy: "exact-name" };

  return { match: null, matchedBy: null };
}

/**
 * Build a human-readable hint showing available transitions with their
 * category keys. Used in error messages so the agent can pick a valid name.
 */
export function describeAvailableTransitions(
  transitions: AtlassianTransition[],
): string {
  return transitions
    .map(
      (t) =>
        `${t.to?.name ?? "?"} [cat:${t.to?.statusCategory?.key ?? "?"}]`,
    )
    .join(", ");
}