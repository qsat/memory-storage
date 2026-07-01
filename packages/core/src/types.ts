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

/**
 * Result of a write that creates/replaces a page ({@link MemoryStore.put}).
 * Any future insert-style write should return this same shape for its parent
 * page, so callers always have the id and slug to chain further calls with.
 */
export interface PutResult {
  /** The new page version's id (UUIDv7). */
  id: string;
  /** The slug the page was written under. */
  slug: string;
}

/**
 * A wiki page: the canonical full-markdown record, addressed by slug.
 * `id` is a UUIDv7 — time-ordered, so sorting by id gives chronological order.
 */
export interface PageRow {
  id: string;
  slug: string;
  content: string;
  status: "live" | "stale";
  epistemic: "fact" | "inference" | "hypothesis";
  superseded_by: string | null;
  created_at: number;
  last_confirmed_at: number;
  superseded_at: number | null;
}

/**
 * A derived chunk of a page (the unit of embedding / retrieval).
 * `id` is the integer rowid shared with the fts5 / vec0 indexes; `uuid` is the
 * stable external id (UUIDv7). `pageId` is the parent page's UUIDv7.
 */
export interface ChunkRow {
  id: number;
  uuid: string;
  pageId: string;
  ordinal: number;
  headingPath: string | null;
  text: string;
}

/**
 * A single chunk with its parent page's metadata — for direct lookup
 * ({@link MemoryStore.getChunkById} / {@link MemoryStore.getChunkNeighbors}),
 * as opposed to a search hit (no relevance score). Only resolvable for chunks
 * belonging to the current **live** page version; a superseded page's chunks
 * are deleted, so their ids no longer resolve.
 */
export interface ChunkDetail {
  chunkId: number;
  chunkUuid: string;
  pageId: string;
  slug: string;
  ordinal: number;
  headingPath: string | null;
  text: string;
  embedHash: string;
  epistemic: "fact" | "inference" | "hypothesis";
  sourceCount: number;
  lastConfirmedAt: number;
}

/** A chunk-level search hit, carrying its parent page's metadata. */
export interface SearchResult {
  chunkId: number;
  pageId: string;
  slug: string;
  ordinal: number;
  headingPath: string | null;
  text: string;
  epistemic: "fact" | "inference" | "hypothesis";
  score: number;
  sourceCount: number;
  lastConfirmedAt: number;
}

/**
 * Search results for one page, ordered for reading rather than relevance.
 * Produced by {@link groupSearchResultsByPage} — see that function for the
 * canonical-order rationale (ordinal is only comparable within one page
 * version; it is reassigned whenever a page is superseded).
 */
export interface PageSearchGroup {
  pageId: string;
  slug: string;
  /** This page's chunks, sorted by ordinal (i.e. reading order). */
  chunks: SearchResult[];
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
  id: string;
  status: "live" | "stale";
  epistemic: "fact" | "inference" | "hypothesis";
  superseded_by: string | null;
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
