import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Same embedder mock as store.test.ts — dump itself doesn't embed, but
// exercising it via a real put() keeps this test close to what the CLI does.
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
mockEmbed.mockImplementation(async () => ({
  tolist: () => [new Array(768).fill(0.01)],
}));

import { MemoryStore } from "./store.js";
import { dumpFileName, formatDumpFile } from "./dump.js";

/** Mirrors what the CLI's `dump` command does for one page: write, read back. */
function writeDump(outDir: string, store: MemoryStore, pageId: string): string {
  const page = store.getPageById(pageId)!;
  const evidence = store.getEvidence(pageId);
  const filePath = path.join(outDir, dumpFileName(page.slug, page.id));
  fs.writeFileSync(filePath, formatDumpFile(page, evidence));
  return filePath;
}

describe("dump integration (real fs writes)", () => {
  let store: MemoryStore;
  let outDir: string;

  beforeEach(() => {
    store = new MemoryStore(":memory:");
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "memstore-dump-"));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  it("writes a live page to doc-{slug}-{id}.md with front matter + content", async () => {
    const { id } = await store.put("ddd-aggregates", {
      content: "# Aggregates\n\nA consistency boundary.",
      epistemic: "fact",
      sources: [{ kind: "url", uri: "https://martinfowler.com/bliki/DDD_Aggregate.html" }],
    });

    const filePath = writeDump(outDir, store, id);
    expect(path.basename(filePath)).toBe(`doc-ddd-aggregates-${id}.md`);

    const written = fs.readFileSync(filePath, "utf8");
    expect(written).toContain(`id: "${id}"`);
    expect(written).toContain('slug: "ddd-aggregates"');
    expect(written).toContain("status: live");
    expect(written).toContain(
      'uri: "https://martinfowler.com/bliki/DDD_Aggregate.html"'
    );
    expect(written).toContain("# Aggregates\n\nA consistency boundary.");
  });

  it("sanitizes a slug containing / in the file name", async () => {
    const { id } = await store.put("hunch/cache-key", {
      content: "# Cache key\n\nLikely collides on tenant id.",
      epistemic: "hypothesis",
    });
    const filePath = writeDump(outDir, store, id);
    expect(path.basename(filePath)).toBe(`doc-hunch__cache-key-${id}.md`);
  });

  it("dumps a stale version distinctly from the live one (different file names)", async () => {
    const v1 = await store.put("doc", { content: "# Doc\n\nold body" });
    const v2 = await store.put("doc", { content: "# Doc\n\nnew body" });

    const oldPath = writeDump(outDir, store, v1.id);
    const newPath = writeDump(outDir, store, v2.id);
    expect(oldPath).not.toBe(newPath);

    const oldContent = fs.readFileSync(oldPath, "utf8");
    const newContent = fs.readFileSync(newPath, "utf8");
    expect(oldContent).toContain("status: stale");
    expect(oldContent).toContain("old body");
    expect(newContent).toContain("status: live");
    expect(newContent).toContain("new body");
    // both files coexist on disk
    expect(fs.readdirSync(outDir)).toHaveLength(2);
  });

  it("round-trips the exact content through a real write + read", async () => {
    const md = "# Multi\n\n## Section\n\nSome body with unicode: 日本語 and `code`.";
    const { id } = await store.put("multi", { content: md });
    const filePath = writeDump(outDir, store, id);
    const written = fs.readFileSync(filePath, "utf8");
    expect(written.endsWith(md + "\n")).toBe(true);
  });
});
