/**
 * Ownership and visibility for a workspace more than one agent reads.
 *
 * Every node the plugin writes carries provenance frontmatter:
 *
 *   agent:       who wrote it (preset id or session short id)
 *   session:     which session it came from
 *   room:        optional team-room label; empty means "the whole team"
 *   visibility:  only written when "private" — absent means team-shared
 *   status:      node lifecycle; "superseded" / "retired" means history
 *   supersedes:  path of the node this one corrects
 *
 * The layering is deliberately two-tier, not per-agent ACL:
 *
 *   team layer   no `visibility` field (digest knowledge, auto-captured daily
 *                pages, anything written before agents existed) — everyone
 *                reads it in every scope.
 *   private      `visibility: private` — the writer's tentative judgment,
 *                visible to the writer in the default scope and to everyone
 *                only under `scope=team` (an audit view, not a wall).
 *
 * The failure this prevents: one agent's working guess read by another agent
 * as an established fact. Private is the default for `daily/` writes; `digest/`
 * writes are the team layer by default. `memory_write` can override either.
 */

export type ScopeMode = "mine" | "team";

export interface ScopeMeta {
  agent?: string;
  session?: string;
  room?: string;
  visibility?: string;
  status?: string;
  supersedes?: string;
}

/** Read the scope fields out of parsed frontmatter; unknown values pass through as-is. */
export function parseScope(data: Record<string, string>): ScopeMeta {
  const meta: ScopeMeta = {};
  const agent = (data.agent ?? "").trim();
  const session = (data.session ?? "").trim();
  const room = (data.room ?? "").trim();
  const visibility = (data.visibility ?? "").trim();
  const status = (data.status ?? "").trim();
  const supersedes = (data.supersedes ?? "").trim();
  if (agent) meta.agent = agent;
  if (session) meta.session = session;
  if (room) meta.room = room;
  if (visibility) meta.visibility = visibility;
  if (status) meta.status = status;
  if (supersedes) meta.supersedes = supersedes;
  return meta;
}

export function isPrivate(meta: ScopeMeta | undefined): boolean {
  return meta?.visibility === "private";
}

/** The two statuses that mean "this node is history, not current truth". */
export const HIDDEN_STATUSES: readonly string[] = ["superseded", "retired"];

/**
 * Whether a node has been corrected away or retired.
 *
 * Corrections never delete: the old node keeps its text and gains
 * `status: superseded`, so tomorrow's agent can still explain why a fact
 * used to read differently. That is exactly why retrieval must skip it —
 * a superseded node left in the default scope would answer queries with
 * the very claim that was just corrected.
 */
export function isSuperseded(meta: ScopeMeta | undefined): boolean {
  return HIDDEN_STATUSES.includes((meta?.status ?? "").trim());
}

/**
 * Whether a node is retrievable by `viewer` under `mode`.
 *
 * `mine` (the default) is "my material plus the team layer": a private node is
 * visible only to its own writer. `team` shows everything — the audit view.
 */
export function visibleTo(
  meta: ScopeMeta | undefined,
  viewer: string,
  mode: ScopeMode = "mine",
): boolean {
  if (mode === "team") return true;
  if (!isPrivate(meta)) return true;
  return Boolean(viewer) && meta?.agent === viewer;
}

/**
 * Stamp a write with provenance. `visibility` is only recorded when private,
 * so the common (team) case leaves the frontmatter unchanged in shape from
 * what a single-agent workspace always wrote.
 */
export function stampScope(input: {
  agent: string;
  session?: string | null;
  room?: string | null;
  private: boolean;
}): ScopeMeta {
  const meta: ScopeMeta = { agent: input.agent };
  if (input.session) meta.session = input.session;
  if (input.room) meta.room = input.room;
  if (input.private) meta.visibility = "private";
  return meta;
}
