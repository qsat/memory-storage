/**
 * Database schema: table DDL and a single entry point to apply it.
 *
 * `page.content` is the source of truth; `chunk` / `fts_chunk` / `vec_chunk`
 * are derived indexes keyed by `chunk.id`.
 */
import type Database from "better-sqlite3";
import { EMBEDDING_DIM } from "./model.js";

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS source (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('file','url','conversation','tool','other')),
  uri TEXT NOT NULL,
  title TEXT,
  ingested_at INTEGER NOT NULL,
  UNIQUE (kind, uri)
);

-- page.id is a UUIDv7 (time-ordered): ORDER BY id == chronological (new/old).
CREATE TABLE IF NOT EXISTS page (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','stale')),
  epistemic TEXT NOT NULL DEFAULT 'fact'
    CHECK (epistemic IN ('fact','inference','hypothesis')),
  superseded_by TEXT REFERENCES page(id),
  created_at INTEGER NOT NULL,
  last_confirmed_at INTEGER NOT NULL,
  superseded_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_page_slug ON page(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_live_slug
  ON page(slug) WHERE status = 'live';

-- chunk.id stays an INTEGER rowid because the fts5 / vec0 indexes require an
-- integer rowid (= chunk.id). chunk.uuid is the stable external id (UUIDv7).
-- AUTOINCREMENT is required here: without it, SQLite reuses the lowest free
-- rowid once the table is emptied (e.g. a page's only chunks get deleted on
-- supersession), so a stale/cached chunk id could silently resolve to an
-- unrelated new chunk instead of correctly failing to resolve.
CREATE TABLE IF NOT EXISTS chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  page_id TEXT NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  heading_path TEXT,
  text TEXT NOT NULL,
  embed_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunk_page ON chunk(page_id);

CREATE TABLE IF NOT EXISTS evidence (
  page_id TEXT NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES source(id),
  locator TEXT,
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence(source_id);
`;

const FTS_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunk
  USING fts5(text, tokenize='trigram');
`;

// vec0 does not support IF NOT EXISTS, so it is created conditionally below.
const VEC_TABLE_SQL = `
CREATE VIRTUAL TABLE vec_chunk
  USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${EMBEDDING_DIM}]);
`;

/**
 * Create all tables/indexes if missing. Idempotent: safe to call on every open.
 * Requires sqlite-vec to already be loaded on the connection (for vec_chunk).
 */
export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  db.exec(FTS_TABLE_SQL);
  const hasVec = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_chunk'"
    )
    .get();
  if (!hasVec) db.exec(VEC_TABLE_SQL);
}
