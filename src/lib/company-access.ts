/* --------------------------------------------------------------------------
 * Company isolation — the deep-link rule.
 *
 * A few screens accept an id in the URL: a resource or a project on Capacity,
 * a baseline on the margin report. Those ids are untrusted — they were pasted
 * from somewhere, possibly from a colleague in another company. A screen
 * resolves the id against the records the signed-in company actually holds
 * (never against the whole database, which it never receives), and when it does
 * not resolve the answer is one generic sentence that names nothing: no
 * company, no project, no user.
 *
 * Kept pure and apart from the screens so the rule — and the fact that the
 * notice carries no identifier — can be checked directly.
 * ------------------------------------------------------------------------ */

/** The single generic result for a deep link that is not ours. */
export const UNAVAILABLE_NOTICE = "That item isn’t available in this workspace.";

export type ScopedRefStatus = "unset" | "found" | "unavailable";

/**
 * Resolves a requested id against the ids the signed-in company holds.
 *
 * - `unset` — the URL carried no id, so there is no deep link to satisfy.
 * - `found` — the id names a record of this company.
 * - `unavailable` — anything else: another company's id, a deleted record, a
 *   typo. Callers answer this with {@link UNAVAILABLE_NOTICE} and nothing more.
 */
export function scopedRefStatus(requested: string, availableIds: Iterable<string>): ScopedRefStatus {
  const id = requested.trim();
  if (!id) return "unset";
  for (const candidate of availableIds) {
    if (candidate === id) return "found";
  }
  return "unavailable";
}
