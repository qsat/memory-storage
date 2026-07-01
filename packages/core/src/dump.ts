/**
 * Dump formatting: render a page (+ its evidence) as a Markdown file with a
 * YAML front-matter header carrying the page's stored fields, followed by the
 * page's full content. Pure formatting only — no file I/O and no DB access
 * (the CLI does the lookups and writes the files).
 *
 * Writing only, for now. Re-importing a dump is not implemented: a naive
 * front-matter reader that scans for the next literal `---` line (rather than
 * parsing YAML properly) could be confused by a `---` inside the page content
 * itself (e.g. a Markdown horizontal rule). A correct reader must parse the
 * YAML block, not string-search for the closing fence.
 */
import type { EvidenceRow, PageRow } from "./types.js";

// Unix forbids only "/" and NUL in file names; Windows also forbids these.
// We fold both sets down to "_" (except "/", which becomes "__" per spec) so
// the same dump works if copied onto either OS.
const UNSAFE_FILENAME_CHARS = /[\\:*?"<>|\x00-\x1f]/g;

/**
 * Sanitize a slug for embedding in a file name. Slugs may contain `/`
 * (e.g. `hunch/cache-key`), which isn't valid in a single path segment, so it
 * becomes `__`; other filesystem-reserved characters become `_`.
 */
export function sanitizeSlugForFilename(slug: string): string {
  return slug.replace(/\//g, "__").replace(UNSAFE_FILENAME_CHARS, "_");
}

/** The dump file name for a page version: `doc-{slug}-{id}.md`. */
export function dumpFileName(slug: string, id: string): string {
  return `doc-${sanitizeSlugForFilename(slug)}-${id}.md`;
}

/**
 * A JSON string literal is also a valid YAML double-quoted scalar, so this is
 * enough to safely embed arbitrary text (quotes, colons, newlines, unicode)
 * in the front matter without pulling in a YAML serializer.
 */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlStringOrNull(value: string | null): string {
  return value === null ? "null" : yamlString(value);
}

/**
 * Render a page and its evidence as a dump file: YAML front matter (all of
 * the page's stored fields, plus its evidence) followed by the page content.
 */
export function formatDumpFile(page: PageRow, evidence: EvidenceRow[]): string {
  const lines: string[] = [
    "---",
    `id: ${yamlString(page.id)}`,
    `slug: ${yamlString(page.slug)}`,
    `status: ${page.status}`,
    `epistemic: ${page.epistemic}`,
    `created_at: ${page.created_at}`,
    `last_confirmed_at: ${page.last_confirmed_at}`,
    `superseded_at: ${page.superseded_at ?? "null"}`,
    `superseded_by: ${yamlStringOrNull(page.superseded_by)}`,
  ];

  if (evidence.length === 0) {
    lines.push("evidence: []");
  } else {
    lines.push("evidence:");
    for (const e of evidence) {
      lines.push(
        `  - kind: ${e.kind}`,
        `    uri: ${yamlString(e.uri)}`,
        `    title: ${yamlStringOrNull(e.title)}`,
        `    locator: ${yamlStringOrNull(e.locator)}`,
        `    confirmed_at: ${e.confirmedAt}`
      );
    }
  }

  lines.push("---", "", page.content);
  return lines.join("\n") + "\n";
}
