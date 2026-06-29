import { describe, it, expect } from "vitest";
import { chunkMarkdown } from "./chunk.js";

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
