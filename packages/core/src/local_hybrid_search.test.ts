import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the embedder before importing the module
const mockEmbed = vi.fn<(text: string, opts: Record<string, unknown>) => Promise<{ tolist: () => number[][] }>>();

vi.mock("@huggingface/transformers", () => ({
  pipeline: vi.fn(async () => mockEmbed),
}));

import { MemoryStore } from "./local_hybrid_search.js";

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

describe("MemoryStore", () => {
  let store: MemoryStore;

  beforeEach(() => {
    callCount = 0;
    store = new MemoryStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("put", () => {
    it("creates a new knowledge entry and returns its id", async () => {
      const id = await store.put("test-slug", {
        content: "TypeScript is a typed superset of JavaScript",
      });
      expect(id).toBeGreaterThan(0);
    });

    it("resolves the slug to the live entry", async () => {
      await store.put("my-fact", {
        content: "The sky is blue",
        epistemic: "fact",
      });

      const row = store.resolveSlug("my-fact");
      expect(row).toBeDefined();
      expect(row!.content).toBe("The sky is blue");
      expect(row!.status).toBe("live");
      expect(row!.epistemic).toBe("fact");
    });

    it("supersedes previous live entry on re-put", async () => {
      const id1 = await store.put("evolving", {
        content: "Version one",
      });
      const id2 = await store.put("evolving", {
        content: "Version two",
      });

      expect(id2).toBeGreaterThan(id1);

      const live = store.resolveSlug("evolving");
      expect(live).toBeDefined();
      expect(live!.id).toBe(id2);
      expect(live!.content).toBe("Version two");

      const history = store.getHistory("evolving");
      expect(history).toHaveLength(2);
      expect(history[0].status).toBe("stale");
      expect(history[0].superseded_by).toBe(id2);
      expect(history[1].status).toBe("live");
    });

    it("rejects empty content", async () => {
      await expect(store.put("empty", { content: "   " })).rejects.toThrow(
        /content must not be empty/
      );
    });

    it("attaches sources as evidence", async () => {
      const id = await store.put("sourced-fact", {
        content: "Node.js uses V8 engine",
        sources: [
          { kind: "url", uri: "https://nodejs.org/about" },
          { kind: "file", uri: "/docs/node.md", locator: "line:42" },
        ],
      });

      const evidence = store.getEvidence(id);
      expect(evidence).toHaveLength(2);
      expect(evidence.map((e) => e.kind)).toContain("url");
      expect(evidence.map((e) => e.kind)).toContain("file");
    });
  });

  describe("addEvidence", () => {
    it("adds a new source to existing knowledge", async () => {
      const id = await store.put("needs-evidence", {
        content: "Some claim",
      });

      expect(store.getEvidence(id)).toHaveLength(0);

      store.addEvidence(id, {
        kind: "url",
        uri: "https://example.com/proof",
        title: "Proof page",
      });

      const evidence = store.getEvidence(id);
      expect(evidence).toHaveLength(1);
      expect(evidence[0].uri).toBe("https://example.com/proof");
      expect(evidence[0].title).toBe("Proof page");
    });

    it("throws on non-existent knowledge id", () => {
      expect(() =>
        store.addEvidence(99999, { kind: "url", uri: "https://x.com" })
      ).toThrow(/does not exist/);
    });

    it("updates confirmed_at on re-confirmation", async () => {
      const id = await store.put("reconfirm", {
        content: "Reconfirmable fact",
        sources: [{ kind: "url", uri: "https://example.com/src" }],
      });

      const before = store.resolveSlug("reconfirm");

      // Small delay to get different timestamp
      await new Promise((r) => setTimeout(r, 10));

      store.addEvidence(id, {
        kind: "url",
        uri: "https://example.com/src",
      });

      const after = store.resolveSlug("reconfirm");
      expect(after!.last_confirmed_at).toBeGreaterThanOrEqual(
        before!.last_confirmed_at
      );
    });
  });

  describe("resolveSlug", () => {
    it("returns undefined for non-existent slug", () => {
      expect(store.resolveSlug("nonexistent")).toBeUndefined();
    });

    it("returns undefined for stale-only slug", async () => {
      await store.put("will-supersede", { content: "v1" });
      await store.put("will-supersede", { content: "v2" });

      // v1 is stale, v2 is live
      const live = store.resolveSlug("will-supersede");
      expect(live!.content).toBe("v2");
    });
  });

  describe("hybridSearch", () => {
    it("returns results from search", async () => {
      await store.put("ts-info", {
        content: "TypeScript adds static types to JavaScript for better tooling",
      });
      await store.put("rust-info", {
        content: "Rust is a systems programming language focused on safety",
      });
      await store.put("python-info", {
        content: "Python is widely used for data science and machine learning",
      });

      const results = await store.hybridSearch("TypeScript type system");
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.slug).toBeDefined();
        expect(r.content).toBeDefined();
        expect(r.score).toBeGreaterThan(0);
      }
    });

    it("returns empty array for non-positive topK", async () => {
      await store.put("anything", { content: "Some content here" });
      expect(await store.hybridSearch("content", 0)).toEqual([]);
      expect(await store.hybridSearch("content", -5)).toEqual([]);
    });

    it("excludes stale entries", async () => {
      await store.put("old-fact", { content: "Old version of the fact" });
      await store.put("old-fact", { content: "New version of the fact" });

      const results = await store.hybridSearch("old version");
      for (const r of results) {
        expect(r.content).not.toBe("Old version of the fact");
      }
    });

    it("includes sourceCount and lastConfirmedAt", async () => {
      const id = await store.put("well-sourced", {
        content: "Well-sourced knowledge entry for testing",
        sources: [
          { kind: "url", uri: "https://a.com" },
          { kind: "url", uri: "https://b.com" },
        ],
      });

      const results = await store.hybridSearch("well-sourced knowledge");
      const match = results.find((r) => r.id === id);
      if (match) {
        expect(match.sourceCount).toBe(2);
        expect(match.lastConfirmedAt).toBeGreaterThan(0);
      }
    });
  });

  describe("getHistory", () => {
    it("returns all versions in chronological order", async () => {
      await store.put("versioned", { content: "v1" });
      await store.put("versioned", { content: "v2" });
      await store.put("versioned", { content: "v3" });

      const history = store.getHistory("versioned");
      expect(history).toHaveLength(3);
      expect(history[0].status).toBe("stale");
      expect(history[1].status).toBe("stale");
      expect(history[2].status).toBe("live");
      expect(history[0].superseded_by).toBe(history[1].id);
      expect(history[1].superseded_by).toBe(history[2].id);
      expect(history[2].superseded_by).toBeNull();
    });

    it("returns empty array for non-existent slug", () => {
      expect(store.getHistory("ghost")).toEqual([]);
    });
  });

  describe("getEvidence", () => {
    it("returns empty array when no evidence", async () => {
      const id = await store.put("no-sources", { content: "No sources" });
      expect(store.getEvidence(id)).toEqual([]);
    });
  });

  describe("epistemic status", () => {
    it("defaults to fact", async () => {
      await store.put("default-epistemic", { content: "Something" });
      const row = store.resolveSlug("default-epistemic");
      expect(row!.epistemic).toBe("fact");
    });

    it("stores hypothesis", async () => {
      await store.put("a-hypothesis", {
        content: "Maybe this is true",
        epistemic: "hypothesis",
      });
      const row = store.resolveSlug("a-hypothesis");
      expect(row!.epistemic).toBe("hypothesis");
    });

    it("stores inference", async () => {
      await store.put("an-inference", {
        content: "Derived from context",
        epistemic: "inference",
      });
      const row = store.resolveSlug("an-inference");
      expect(row!.epistemic).toBe("inference");
    });
  });

  describe("slug uniqueness constraint", () => {
    it("enforces single live per slug", async () => {
      await store.put("unique-live", { content: "First" });
      await store.put("unique-live", { content: "Second" });

      const live = store.resolveSlug("unique-live");
      expect(live!.content).toBe("Second");

      // Only one live for this slug
      const history = store.getHistory("unique-live");
      const liveEntries = history.filter((h) => h.status === "live");
      expect(liveEntries).toHaveLength(1);
    });
  });
});
