/**
 * Markdown chunking: split a page into retrieval-sized chunks and derive the
 * text actually fed to the embedder. Pure functions, no I/O.
 */
import { createHash } from "node:crypto";
import type { Chunk } from "./types.js";

/**
 * Approximate per-chunk size budget (characters, a proxy for tokens — kept well
 * under the model's max sequence length to avoid silent truncation). Smaller
 * chunks improve retrieval precision. Override with MEMORY_CHUNK_MAX_CHARS.
 */
export const CHUNK_MAX_CHARS = Number(process.env.MEMORY_CHUNK_MAX_CHARS ?? 1200);

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /```[\s\S]*?```/g;

/**
 * Split markdown into chunks: first by heading sections (tracking the heading
 * path), then by a character budget so no chunk overflows the embedding model.
 * The raw section text (including Mermaid/code) is kept for display; the text
 * used for embedding is derived separately (see {@link embedInputFor}).
 *
 * @param content  the full page markdown
 * @param maxChars per-chunk character budget (defaults to {@link CHUNK_MAX_CHARS})
 * @returns ordered chunks; always at least one (even for whitespace-only input)
 */
export function chunkMarkdown(
  content: string,
  maxChars: number = CHUNK_MAX_CHARS
): Chunk[] {
  const lines = content.split(/\r?\n/);
  const sections: { headingPath: string; lines: string[] }[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: { headingPath: string; lines: string[] } = {
    headingPath: "",
    lines: [],
  };

  const flush = () => {
    if (current.lines.join("\n").trim()) sections.push(current);
  };

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      const title = m[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title });
      current = {
        headingPath: stack.map((s) => s.title).join(" > "),
        lines: [line],
      };
    } else {
      current.lines.push(line);
    }
  }
  flush();

  const chunks: Chunk[] = [];
  let ordinal = 0;
  for (const sec of sections) {
    const text = sec.lines.join("\n").trim();
    if (!text) continue;
    for (const piece of splitByBudget(text, maxChars)) {
      chunks.push({
        ordinal: ordinal++,
        headingPath: sec.headingPath || null,
        text: piece,
      });
    }
  }
  if (chunks.length === 0) {
    chunks.push({ ordinal: 0, headingPath: null, text: content.trim() });
  }
  return chunks;
}

/** Split text into pieces under maxChars, preferring paragraph boundaries. */
function splitByBudget(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let buf = "";
  for (const para of text.split(/\n{2,}/)) {
    if (para.length > maxChars) {
      if (buf) {
        pieces.push(buf);
        buf = "";
      }
      for (let i = 0; i < para.length; i += maxChars) {
        pieces.push(para.slice(i, i + maxChars));
      }
    } else if ((buf ? buf.length + 2 + para.length : para.length) > maxChars) {
      if (buf) pieces.push(buf);
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

/**
 * Derive the text actually fed to the embedder for a chunk: the heading path
 * plus the prose with code/Mermaid fences stripped (they add tokens but little
 * semantic signal). Falls back to the raw text if stripping leaves nothing.
 */
export function embedInputFor(chunk: Chunk): string {
  const stripped = chunk.text
    .replace(FENCE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const ei = [chunk.headingPath, stripped].filter(Boolean).join("\n").trim();
  return ei || chunk.text.trim();
}

/** Stable content hash used to decide whether a chunk's embedding can be reused. */
export function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
