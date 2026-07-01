/**
 * Public API for memory-storage.
 *
 * Internally the implementation is split into focused modules:
 * - {@link ./model}      embedding model resolution, cache location, embedder
 * - {@link ./chunk}      markdown chunking and embed-input derivation
 * - {@link ./schema}     table DDL and `applySchema`
 * - {@link ./statements} `prepareStatements(db)` — compiled queries
 * - {@link ./store}      `MemoryStore` orchestration
 */
export { MemoryStore } from "./store.js";

export {
  resolveUserPath,
  MODEL_CACHE_DIR,
  onModelProgress,
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
} from "./model.js";

export { chunkMarkdown, CHUNK_MAX_CHARS } from "./chunk.js";

export type {
  SourceInput,
  PutOptions,
  PutResult,
  PageRow,
  ChunkRow,
  SearchResult,
  EvidenceRow,
  HistoryRow,
  ModelProgress,
  Chunk,
} from "./types.js";
