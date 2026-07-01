import { describe, it, expect } from "vitest";
import { groupSearchResultsByPage } from "./ordering.js";
import type { SearchResult } from "./types.js";

function hit(
  pageId: string,
  slug: string,
  ordinal: number,
  score: number
): SearchResult {
  return {
    chunkId: Math.floor(Math.random() * 1e9),
    pageId,
    slug,
    ordinal,
    headingPath: null,
    text: `chunk ${ordinal} of ${slug}`,
    epistemic: "fact",
    score,
    sourceCount: 0,
    lastConfirmedAt: 0,
  };
}

describe("groupSearchResultsByPage", () => {
  it("groups chunks by page and sorts each group by ordinal ascending", () => {
    const results = [
      hit("p1", "a", 3, 0.9), // best match, out-of-order ordinal
      hit("p1", "a", 0, 0.5),
      hit("p1", "a", 1, 0.4),
    ];
    const groups = groupSearchResultsByPage(results);
    expect(groups).toHaveLength(1);
    expect(groups[0].pageId).toBe("p1");
    expect(groups[0].slug).toBe("a");
    expect(groups[0].chunks.map((c) => c.ordinal)).toEqual([0, 1, 3]);
  });

  it("orders pages by their best (first-seen) score, chunks stay grouped", () => {
    const results = [
      hit("p2", "b", 5, 0.95), // page b's best match comes first overall
      hit("p1", "a", 0, 0.8),
      hit("p2", "b", 1, 0.7),
    ];
    const groups = groupSearchResultsByPage(results);
    expect(groups.map((g) => g.slug)).toEqual(["b", "a"]);
    expect(groups[0].chunks.map((c) => c.ordinal)).toEqual([1, 5]);
  });

  it("returns [] for an empty result set", () => {
    expect(groupSearchResultsByPage([])).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const results = [hit("p1", "a", 2, 0.9), hit("p1", "a", 0, 0.5)];
    const copy = [...results];
    groupSearchResultsByPage(results);
    expect(results).toEqual(copy);
  });
});
