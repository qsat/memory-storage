/**
 * Shared types for the memory-storage layer.
 *
 * Kept in one dependency-free module so every other module (model, chunk,
 * schema, statements, store) can import them without creating import cycles.
 */

/** A provenance source: where a claim came from. Unique by (kind, uri). */
export interface SourceInput {
  kind: "file" | "url" | "conversation" | "tool" | "other";
  uri: string;
  title?: string;
  locator?: string;
}

/** Arguments for creating/replacing a page via {@link MemoryStore.put}. */
export interface PutOptions {
  /** Full markdown body — the canonical source of truth for the page. */
  content: string;
  /** Optional provenance sources to attach as evidence. */
  sources?: SourceInput[];
  /** Epistemic status of the page's content (defaults to "fact"). */
  epistemic?: "fact" | "inference" | "hypothesis";
}

/** A wiki page: the canonical full-markdown record, addressed by slug. */
export interface PageRow {
  id: number;
  slug: string;
  content: string;
  status: "live" | "stale";
  epistemic: "fact" | "inference" | "hypothesis";
  superseded_by: number | null;
  created_at: number;
  last_confirmed_at: number;
  superseded_at: number | null;
}

/** A derived chunk of a page (the unit of embedding / retrieval). */
export interface ChunkRow {
  id: number;
  pageId: number;
  ordinal: number;
  headingPath: string | null;
  text: string;
}

/** A chunk-level search hit, carrying its parent page's metadata. */
export interface SearchResult {
  chunkId: number;
  pageId: number;
  slug: string;
  ordinal: number;
  headingPath: string | null;
  text: string;
  epistemic: "fact" | "inference" | "hypothesis";
  score: number;
  sourceCount: number;
  lastConfirmedAt: number;
}

/** A resolved evidence row joining a page to one of its sources. */
export interface EvidenceRow {
  sourceId: number;
  kind: string;
  uri: string;
  title: string | null;
  locator: string | null;
  confirmedAt: number;
}

/** One version of a page, as returned by the history query. */
export interface HistoryRow {
  id: number;
  status: "live" | "stale";
  epistemic: "fact" | "inference" | "hypothesis";
  superseded_by: number | null;
  created_at: number;
  superseded_at: number | null;
}

/** Progress event emitted by transformers.js while loading/downloading. */
export interface ModelProgress {
  status: string; // "initiate" | "download" | "progress" | "done" | ...
  name?: string;
  file?: string;
  progress?: number; // 0..100
  loaded?: number;
  total?: number;
}

/** A markdown chunk produced by {@link chunkMarkdown} (before persistence). */
export interface Chunk {
  ordinal: number;
  headingPath: string | null;
  text: string;
}
