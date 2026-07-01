/**
 * Chunk / page ordering helpers.
 *
 * The canonical reading order for a page's content is `(page, ordinal)`
 * ascending — the same order {@link chunkMarkdown} assigns and the same order
 * `getChunks` returns in. `hybridSearch` results are ranked by relevance
 * (RRF score), not reading order; {@link groupSearchResultsByPage} converts a
 * relevance-ranked result list into the reading order within each page, for
 * callers (agents) that want to reconstruct context rather than just see the
 * best-matching snippet.
 *
 * Important: `ordinal` is only meaningful within a single page version. A page
 * update re-chunks and reassigns ordinals from 0, so ordinals must never be
 * compared across different page ids (including different versions of the
 * same slug).
 */
import type { PageSearchGroup, SearchResult } from "./types.js";

/**
 * Group chunk-level search results by page, sorting each page's chunks into
 * reading order (`ordinal` ascending). Pages are ordered by the best (first,
 * since results arrive score-sorted) score among their chunks — i.e. the
 * most relevant page still comes first, but its matched chunks now read
 * top-to-bottom instead of best-match-first.
 */
export function groupSearchResultsByPage(
  results: SearchResult[]
): PageSearchGroup[] {
  const groups = new Map<string, PageSearchGroup>();
  for (const r of results) {
    let group = groups.get(r.pageId);
    if (!group) {
      group = { pageId: r.pageId, slug: r.slug, chunks: [] };
      groups.set(r.pageId, group);
    }
    group.chunks.push(r);
  }
  for (const group of groups.values()) {
    group.chunks.sort((a, b) => a.ordinal - b.ordinal);
  }
  // results is score-sorted, so the first result for each page is that page's
  // best match; Map iteration preserves insertion order, which is the order
  // pages first appeared in the (score-sorted) results.
  return [...groups.values()];
}
