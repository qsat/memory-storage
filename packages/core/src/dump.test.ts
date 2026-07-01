import { describe, it, expect } from "vitest";
import {
  sanitizeSlugForFilename,
  dumpFileName,
  formatDumpFile,
} from "./dump.js";
import type { EvidenceRow, PageRow } from "./types.js";

function page(overrides: Partial<PageRow> = {}): PageRow {
  return {
    id: "018f5a1c-0000-7000-8000-000000000001",
    slug: "typescript",
    content: "# TypeScript\n\nA typed superset of JavaScript.",
    status: "live",
    epistemic: "fact",
    superseded_by: null,
    created_at: 1_700_000_000_000,
    last_confirmed_at: 1_700_000_000_000,
    superseded_at: null,
    ...overrides,
  };
}

describe("sanitizeSlugForFilename", () => {
  it("replaces / with __", () => {
    expect(sanitizeSlugForFilename("hunch/cache-key")).toBe("hunch__cache-key");
  });

  it("replaces filesystem-reserved characters with _", () => {
    expect(sanitizeSlugForFilename('a:b*c?d"e<f>g|h')).toBe("a_b_c_d_e_f_g_h");
  });

  it("leaves an already-safe slug unchanged", () => {
    expect(sanitizeSlugForFilename("ddd-aggregates")).toBe("ddd-aggregates");
  });
});

describe("dumpFileName", () => {
  it("builds doc-{slug}-{id}.md", () => {
    expect(dumpFileName("typescript", "abc-123")).toBe(
      "doc-typescript-abc-123.md"
    );
  });

  it("sanitizes the slug portion", () => {
    expect(dumpFileName("hunch/cache-key", "abc-123")).toBe(
      "doc-hunch__cache-key-abc-123.md"
    );
  });
});

describe("formatDumpFile", () => {
  it("renders YAML front matter followed by the page content", () => {
    const out = formatDumpFile(page(), []);
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain('id: "018f5a1c-0000-7000-8000-000000000001"');
    expect(out).toContain('slug: "typescript"');
    expect(out).toContain("status: live");
    expect(out).toContain("epistemic: fact");
    expect(out).toContain("created_at: 1700000000000");
    expect(out).toContain("last_confirmed_at: 1700000000000");
    expect(out).toContain("superseded_at: null");
    expect(out).toContain("superseded_by: null");
    expect(out).toContain("evidence: []");
    // front matter closed, then a blank line, then the content verbatim
    expect(out).toContain(
      "---\n\n# TypeScript\n\nA typed superset of JavaScript.\n"
    );
  });

  it("includes evidence entries as a YAML list", () => {
    const evidence: EvidenceRow[] = [
      {
        sourceId: 1,
        kind: "url",
        uri: "https://www.typescriptlang.org/",
        title: "TS 公式",
        locator: null,
        confirmedAt: 1_700_000_000_000,
      },
      {
        sourceId: 2,
        kind: "file",
        uri: "/docs/node.md",
        title: null,
        locator: "line:42",
        confirmedAt: 1_700_000_001_000,
      },
    ];
    const out = formatDumpFile(page(), evidence);
    expect(out).toContain("evidence:\n");
    expect(out).toContain("- kind: url");
    expect(out).toContain('uri: "https://www.typescriptlang.org/"');
    expect(out).toContain('title: "TS 公式"');
    expect(out).toContain("- kind: file");
    expect(out).toContain('locator: "line:42"');
  });

  it("safely embeds quotes, colons, and newlines via JSON-string escaping", () => {
    const tricky = page({
      slug: 'weird"slug: with\nnewline',
      superseded_by: "018f5a1c-0000-7000-8000-000000000002",
    });
    const out = formatDumpFile(tricky, []);
    // JSON.stringify escapes these; parsing the value back out should
    // round-trip exactly.
    const slugLine = out.split("\n").find((l) => l.startsWith("slug: "))!;
    const parsed = JSON.parse(slugLine.slice("slug: ".length));
    expect(parsed).toBe('weird"slug: with\nnewline');
    expect(out).toContain(
      'superseded_by: "018f5a1c-0000-7000-8000-000000000002"'
    );
  });

  it("renders a horizontal-rule-containing body verbatim after the closing fence", () => {
    // Known limitation: a naive "scan for next ---" reader would misparse
    // this; a real reader must parse YAML properly. Writing is unaffected.
    const withRule = page({ content: "# A\n\n---\n\nmore text" });
    const out = formatDumpFile(withRule, []);
    expect(out.endsWith("# A\n\n---\n\nmore text\n")).toBe(true);
  });
});
