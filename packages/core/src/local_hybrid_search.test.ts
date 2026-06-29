import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the embedder before importing the module
const mockEmbed =
  vi.fn<
    (text: string, opts: Record<string, unknown>) => Promise<{
      tolist: () => number[][];
    }>
  >();

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => mockEmbed),
  env: {},
}));

import { MemoryStore, chunkMarkdown } from "./local_hybrid_search.js";

function makeFakeEmbedding(seed: number): number[][] {
  const vec = new Array(768).fill(0).map((_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return [vec.map((v) => v / norm)];
}

let callCount = 0;
mockEmbed.mockImplementation(async () => {
  callCount++;
  return { tolist: () => makeFakeEmbedding(callCount) };
});

describe("chunkMarkdown", () => {
  it("splits by heading sections and tracks the heading path", () => {
    const md = "# Top\n\nintro\n\n## Sub\n\ndetail body";
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBe(2);
    expect(chunks[0].headingPath).toBe("Top");
    expect(chunks[1].headingPath).toBe("Top > Sub");
    expect(chunks[1].text).toContain("detail body");
  });

  it("splits oversized sections by a character budget", () => {
    const big = "# H\n\n" + "あ".repeat(5000);
    const chunks = chunkMarkdown(big, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1000);
  });

  it("falls back to a single chunk when there are no headings", () => {
    const chunks = chunkMarkdown("just some prose with no heading");
    expect(chunks.length).toBe(1);
    expect(chunks[0].headingPath).toBeNull();
  });

  it("packs multiple paragraphs and flushes at the budget", () => {
    const para = "x".repeat(400);
    const md = `# H\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkMarkdown(md, 1000);
    expect(chunks.length).toBe(2); // first two paras packed, third flushed
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1000);
  });

  it("returns one (empty) chunk for whitespace-only content", () => {
    const chunks = chunkMarkdown("\n\n  \n");
    expect(chunks.length).toBe(1);
  });
});

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    callCount = 0;
    store = new MemoryStore(":memory:");
  });
  afterEach(() => store.close());

  describe("put", () => {
    it("creates a page and returns its id", async () => {
      const id = await store.put("ts", { content: "# TS\n\ncontent" });
      expect(id).toBeGreaterThan(0);
    });

    it("rejects empty content", async () => {
      await expect(store.put("e", { content: "   " })).rejects.toThrow(
        /content must not be empty/
      );
    });

    it("resolves the slug to the live page with full content", async () => {
      const md = "# Sky\n\nThe sky is blue\n\n## Note\n\nmore";
      await store.put("sky", { content: md, epistemic: "fact" });
      const page = store.resolveSlug("sky");
      expect(page).toBeDefined();
      expect(page!.content).toBe(md); // full markdown preserved (reconstruction)
      expect(page!.status).toBe("live");
      expect(page!.epistemic).toBe("fact");
    });

    it("stores multiple chunks for a multi-section page", async () => {
      const id = await store.put("multi", {
        content: "# A\n\naaa\n\n# B\n\nbbb\n\n# C\n\nccc",
      });
      const chunks = store.getChunks(id);
      expect(chunks.length).toBe(3);
      expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    });

    it("supersedes the previous live page on re-put", async () => {
      const id1 = await store.put("doc", { content: "# T\n\nVersion one" });
      const id2 = await store.put("doc", { content: "# T\n\nVersion two" });
      expect(id2).toBeGreaterThan(id1);

      const live = store.resolveSlug("doc");
      expect(live!.id).toBe(id2);
      expect(live!.content).toContain("Version two");

      const history = store.getHistory("doc");
      expect(history).toHaveLength(2);
      expect(history[0].status).toBe("stale");
      expect(history[0].superseded_by).toBe(id2);
      expect(history[1].status).toBe("live");
    });

    it("deletes the superseded version's chunks", async () => {
      const id1 = await store.put("doc", { content: "# A\n\nold" });
      await store.put("doc", { content: "# A\n\nnew" });
      expect(store.getChunks(id1)).toHaveLength(0); // old chunks removed
    });

    it("reuses embeddings for unchanged chunks on re-put", async () => {
      await store.put("doc", {
        content: "# A\n\nsection a body\n\n# B\n\nsection b body",
      });
      const afterFirst = callCount; // two chunks embedded
      await store.put("doc", {
        content: "# A\n\nsection a body\n\n# B\n\nsection b CHANGED",
      });
      // Only the changed chunk (B) is re-embedded; A is reused.
      expect(callCount - afterFirst).toBe(1);
    });

    it("handles content that is only a code/mermaid block", async () => {
      // embedInputFor strips fences → empty → falls back to the raw text.
      const id = await store.put("diagram", {
        content: "```mermaid\ngraph TD; A-->B\n```",
      });
      expect(store.getChunks(id)).toHaveLength(1);
      expect(store.resolveSlug("diagram")).toBeDefined();
    });

    it("attaches sources as evidence at the page level", async () => {
      const id = await store.put("n", {
        content: "# N\n\nNode uses V8",
        sources: [
          { kind: "url", uri: "https://nodejs.org" },
          { kind: "file", uri: "/docs/node.md", locator: "line:42" },
        ],
      });
      const evidence = store.getEvidence(id);
      expect(evidence).toHaveLength(2);
      expect(evidence.map((e) => e.kind).sort()).toEqual(["file", "url"]);
    });
  });

  describe("addEvidence", () => {
    it("adds a source to an existing page", async () => {
      const id = await store.put("p", { content: "# P\n\nclaim" });
      expect(store.getEvidence(id)).toHaveLength(0);
      store.addEvidence(id, {
        kind: "url",
        uri: "https://example.com/proof",
        title: "Proof",
      });
      const ev = store.getEvidence(id);
      expect(ev).toHaveLength(1);
      expect(ev[0].uri).toBe("https://example.com/proof");
    });

    it("throws on a non-existent page id", () => {
      expect(() =>
        store.addEvidence(99999, { kind: "url", uri: "https://x.com" })
      ).toThrow(/does not exist/);
    });
  });

  describe("resolveSlug", () => {
    it("returns undefined for an unknown slug", () => {
      expect(store.resolveSlug("nope")).toBeUndefined();
    });
  });

  describe("hybridSearch", () => {
    it("returns chunk-level results carrying page metadata", async () => {
      await store.put("ts", {
        content: "# TypeScript\n\nTypeScript adds static types to JavaScript.",
        sources: [{ kind: "url", uri: "https://ts.org" }],
      });
      const results = await store.hybridSearch("TypeScript types");
      expect(results.length).toBeGreaterThan(0);
      const r = results[0];
      expect(r.slug).toBe("ts");
      expect(r.chunkId).toBeGreaterThan(0);
      expect(r.pageId).toBeGreaterThan(0);
      expect(r.text).toContain("TypeScript");
      expect(r.score).toBeGreaterThan(0);
      expect(r.sourceCount).toBe(1);
      expect(r.lastConfirmedAt).toBeGreaterThan(0);
    });

    it("returns [] for non-positive topK", async () => {
      await store.put("x", { content: "# X\n\nbody" });
      expect(await store.hybridSearch("body", 0)).toEqual([]);
    });

    it("handles very short queries without throwing (FTS skipped)", async () => {
      await store.put("a", { content: "# A\n\n短いクエリ耐性のテスト" });
      const results = await store.hybridSearch("あ", 5);
      expect(Array.isArray(results)).toBe(true);
    });

    it("excludes chunks of superseded pages", async () => {
      await store.put("d", { content: "# D\n\nOld unique marker text" });
      await store.put("d", { content: "# D\n\nNew unique marker text" });
      const results = await store.hybridSearch("unique marker", 10);
      for (const r of results) expect(r.text).not.toContain("Old");
    });
  });

  describe("getHistory", () => {
    it("returns all versions oldest-first", async () => {
      await store.put("v", { content: "# V\n\n1" });
      await store.put("v", { content: "# V\n\n2" });
      await store.put("v", { content: "# V\n\n3" });
      const h = store.getHistory("v");
      expect(h.map((r) => r.status)).toEqual(["stale", "stale", "live"]);
      expect(h[2].superseded_by).toBeNull();
    });

    it("returns [] for an unknown slug", () => {
      expect(store.getHistory("ghost")).toEqual([]);
    });
  });

  describe("epistemic status", () => {
    it("defaults to fact and stores other values", async () => {
      await store.put("f", { content: "# F\n\nx" });
      expect(store.resolveSlug("f")!.epistemic).toBe("fact");
      await store.put("h", { content: "# H\n\ny", epistemic: "hypothesis" });
      expect(store.resolveSlug("h")!.epistemic).toBe("hypothesis");
    });
  });

  describe("slug uniqueness", () => {
    it("keeps a single live page per slug", async () => {
      await store.put("u", { content: "# U\n\nfirst" });
      await store.put("u", { content: "# U\n\nsecond" });
      const live = store.getHistory("u").filter((h) => h.status === "live");
      expect(live).toHaveLength(1);
    });
  });
});
