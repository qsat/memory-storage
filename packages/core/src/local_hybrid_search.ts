import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  pipeline,
  env as transformersEnv,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceInput {
  kind: "file" | "url" | "conversation" | "tool" | "other";
  uri: string;
  title?: string;
  locator?: string;
}

export interface PutOptions {
  content: string;
  sources?: SourceInput[];
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

export interface EvidenceRow {
  sourceId: number;
  kind: string;
  uri: string;
  title: string | null;
  locator: string | null;
  confirmedAt: number;
}

export interface HistoryRow {
  id: number;
  status: "live" | "stale";
  epistemic: "fact" | "inference" | "hypothesis";
  superseded_by: number | null;
  created_at: number;
  superseded_at: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type EmbeddingDtype =
  | "auto"
  | "fp32"
  | "fp16"
  | "q8"
  | "int8"
  | "uint8"
  | "q4"
  | "bnb4"
  | "q4f16";

const EMBEDDING_MODEL =
  process.env.MEMORY_EMBEDDING_MODEL ?? "sirasagi62/ruri-v3-310m-ONNX";
const EMBEDDING_DIM = 768;
const EMBEDDING_DTYPE = (process.env.MEMORY_EMBEDDING_DTYPE ??
  "q8") as EmbeddingDtype;
const QUERY_PREFIX = "検索クエリ: ";
const DOC_PREFIX = "検索文書: ";
const RRF_K = 60;
const DEFAULT_TOP_K = 10;

// Approximate per-chunk size budget (characters, a proxy for tokens — kept well
// under the model's max sequence length to avoid silent truncation). Smaller
// chunks improve retrieval precision. Override with MEMORY_CHUNK_MAX_CHARS.
const CHUNK_MAX_CHARS = Number(process.env.MEMORY_CHUNK_MAX_CHARS ?? 1200);

// ---------------------------------------------------------------------------
// Path / model cache location
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied path:
 * - `~` / `~/...`  → expanded against the home directory
 * - absolute       → used as-is
 * - otherwise      → relative to the directory the command was run from
 *   (INIT_CWD, which npm sets to the invocation dir; falls back to cwd)
 */
export function resolveUserPath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
}

/**
 * Where the embedding model is cached on disk. Defaults to a stable directory
 * outside the project so it survives `npm install` / removing node_modules.
 * Override with MEMORY_MODEL_CACHE (relative values resolve like above).
 */
export const MODEL_CACHE_DIR = resolveUserPath(
  process.env.MEMORY_MODEL_CACHE ??
    path.join(os.homedir(), ".cache", "memory-storage")
);

// transformers.js has no env var for this, so set it before any model load.
transformersEnv.cacheDir = MODEL_CACHE_DIR;

/**
 * Ensure the model cache dir is usable before downloading. We only auto-create
 * directories under `~/.cache`; anywhere else the directory must already exist,
 * otherwise we error out — so a typo'd MEMORY_MODEL_CACHE can't silently
 * scatter hundreds of MB of model files into an arbitrary location.
 */
function ensureModelCacheDir(): void {
  if (fs.existsSync(MODEL_CACHE_DIR)) return;
  const cacheRoot = path.join(os.homedir(), ".cache");
  const underCacheRoot =
    MODEL_CACHE_DIR === cacheRoot ||
    MODEL_CACHE_DIR.startsWith(cacheRoot + path.sep);
  if (underCacheRoot) {
    fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });
    return;
  }
  throw new Error(
    `model cache directory does not exist: ${MODEL_CACHE_DIR}\n` +
      `Refusing to create directories outside ~/.cache. Create it first ` +
      `(e.g. mkdir -p "${MODEL_CACHE_DIR}") or set MEMORY_MODEL_CACHE under ~/.cache.`
  );
}

// ---------------------------------------------------------------------------
// Embedder (singleton)
// ---------------------------------------------------------------------------

/** Progress event emitted by transformers.js while loading/downloading. */
export interface ModelProgress {
  status: string; // "initiate" | "download" | "progress" | "done" | ...
  name?: string;
  file?: string;
  progress?: number; // 0..100
  loaded?: number;
  total?: number;
}

let _embedder: FeatureExtractionPipeline | null = null;
let _progressCallback: ((p: ModelProgress) => void) | undefined;

/**
 * Register a callback for embedding-model load/download progress. Useful for
 * surfacing "downloading model..." in a CLI. Must be set before the first
 * embedding call (the model loads lazily and is cached afterwards).
 */
export function onModelProgress(cb: (p: ModelProgress) => void): void {
  _progressCallback = cb;
}

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!_embedder) {
    ensureModelCacheDir();
    _embedder = await pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: EMBEDDING_DTYPE,
      progress_callback: _progressCallback as
        | ((p: ModelProgress) => void)
        | undefined,
    });
  }
  return _embedder;
}

async function embed(text: string, prefix: string): Promise<Buffer> {
  const embedder = await getEmbedder();
  const output = await embedder(`${prefix}${text}`, {
    pooling: "mean",
    normalize: true,
  });
  const f32 = new Float32Array(output.tolist()[0] as number[]);
  return Buffer.from(f32.buffer);
}

// ---------------------------------------------------------------------------
// Markdown chunking
// ---------------------------------------------------------------------------

export interface Chunk {
  ordinal: number;
  headingPath: string | null;
  text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const FENCE_RE = /```[\s\S]*?```/g;

/**
 * Split markdown into chunks: first by heading sections (tracking the heading
 * path), then by a character budget so no chunk overflows the embedding model.
 * The raw section text (including Mermaid/code) is kept for display; the text
 * used for embedding is derived separately (see embedInputFor).
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

/** Text actually fed to the embedder: heading path + prose, code fences stripped. */
function embedInputFor(chunk: Chunk): string {
  const stripped = chunk.text
    .replace(FENCE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  const ei = [chunk.headingPath, stripped].filter(Boolean).join("\n").trim();
  return ei || chunk.text.trim();
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

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

CREATE TABLE IF NOT EXISTS page (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','stale')),
  epistemic TEXT NOT NULL DEFAULT 'fact'
    CHECK (epistemic IN ('fact','inference','hypothesis')),
  superseded_by INTEGER REFERENCES page(id),
  created_at INTEGER NOT NULL,
  last_confirmed_at INTEGER NOT NULL,
  superseded_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_page_slug ON page(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_page_live_slug
  ON page(slug) WHERE status = 'live';

CREATE TABLE IF NOT EXISTS chunk (
  id INTEGER PRIMARY KEY,
  page_id INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  heading_path TEXT,
  text TEXT NOT NULL,
  embed_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunk_page ON chunk(page_id);

CREATE TABLE IF NOT EXISTS evidence (
  page_id INTEGER NOT NULL REFERENCES page(id) ON DELETE CASCADE,
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

const VEC_TABLE_SQL = `
CREATE VIRTUAL TABLE vec_chunk
  USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${EMBEDDING_DIM}]);
`;

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  private db: Database.Database;
  private stmts!: ReturnType<MemoryStore["prepareStatements"]>;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    this.initSchema();
    this.stmts = this.prepareStatements();
  }

  private initSchema(): void {
    this.db.exec(SCHEMA_SQL);
    this.db.exec(FTS_TABLE_SQL);
    const hasVec = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_chunk'"
      )
      .get();
    if (!hasVec) this.db.exec(VEC_TABLE_SQL);
  }

  private prepareStatements() {
    return {
      insertPage: this.db.prepare(`
        INSERT INTO page (slug, content, epistemic, created_at, last_confirmed_at)
        VALUES (@slug, @content, @epistemic, @created_at, @last_confirmed_at)
        RETURNING id
      `),

      staleLive: this.db.prepare<{ slug: string; now: number }>(
        `UPDATE page SET status = 'stale', superseded_at = @now
         WHERE slug = @slug AND status = 'live'`
      ),

      linkSupersession: this.db.prepare<{ old_id: number; new_id: number }>(
        `UPDATE page SET superseded_by = @new_id WHERE id = @old_id`
      ),

      insertChunk: this.db.prepare(`
        INSERT INTO chunk (page_id, ordinal, heading_path, text, embed_hash)
        VALUES (@page_id, @ordinal, @heading_path, @text, @embed_hash)
        RETURNING id
      `),

      chunksByPage: this.db.prepare<{ page_id: number }>(
        `SELECT id, embed_hash FROM chunk WHERE page_id = @page_id`
      ),

      deleteChunksByPage: this.db.prepare<{ page_id: number }>(
        `DELETE FROM chunk WHERE page_id = @page_id`
      ),

      insertFts: this.db.prepare<{ rowid: number; text: string }>(
        `INSERT INTO fts_chunk (rowid, text) VALUES (@rowid, @text)`
      ),
      deleteFts: this.db.prepare<{ rowid: number }>(
        `DELETE FROM fts_chunk WHERE rowid = @rowid`
      ),

      insertVec: this.db.prepare<[bigint, Buffer]>(
        `INSERT INTO vec_chunk (rowid, embedding) VALUES (?, ?)`
      ),
      deleteVec: this.db.prepare(`DELETE FROM vec_chunk WHERE rowid = ?`),
      readVec: this.db.prepare(
        `SELECT embedding FROM vec_chunk WHERE rowid = ?`
      ),

      upsertSource: this.db.prepare(`
        INSERT INTO source (kind, uri, title, ingested_at)
        VALUES (@kind, @uri, @title, @now)
        ON CONFLICT (kind, uri) DO UPDATE SET title = COALESCE(excluded.title, title)
        RETURNING id
      `),

      insertEvidence: this.db.prepare<{
        page_id: number;
        source_id: number;
        locator: string | null;
        confirmed_at: number;
      }>(`INSERT INTO evidence (page_id, source_id, locator, confirmed_at)
          VALUES (@page_id, @source_id, @locator, @confirmed_at)
          ON CONFLICT (page_id, source_id) DO UPDATE
            SET confirmed_at = excluded.confirmed_at,
                locator = COALESCE(excluded.locator, locator)`),

      refreshConfirmedAt: this.db.prepare<{ id: number }>(
        `UPDATE page SET last_confirmed_at = COALESCE(
           (SELECT MAX(confirmed_at) FROM evidence WHERE page_id = @id),
           created_at
         ) WHERE id = @id`
      ),

      resolveLive: this.db.prepare<{ slug: string }>(
        `SELECT * FROM page WHERE slug = @slug AND status = 'live'`
      ),
      liveIdBySlug: this.db.prepare<{ slug: string }>(
        `SELECT id FROM page WHERE slug = @slug AND status = 'live'`
      ),
      pageExists: this.db.prepare<{ id: number }>(
        `SELECT 1 FROM page WHERE id = @id`
      ),

      ftsSearch: this.db.prepare<{ query: string; limit: number }>(
        `SELECT rowid FROM fts_chunk WHERE text MATCH @query
         ORDER BY rank LIMIT @limit`
      ),
      vecSearch: this.db.prepare<[Buffer, number]>(
        `SELECT rowid, distance FROM vec_chunk
         WHERE embedding MATCH ? AND k = ? ORDER BY distance`
      ),

      // A chunk hit joined with its live page + source count, in one query.
      liveSearchRow: this.db.prepare<{ id: number }>(
        `SELECT c.id AS chunkId, c.page_id AS pageId, p.slug, c.ordinal,
                c.heading_path AS headingPath, c.text, p.epistemic,
                p.last_confirmed_at AS lastConfirmedAt,
                (SELECT COUNT(*) FROM evidence WHERE page_id = p.id) AS sourceCount
         FROM chunk c JOIN page p ON c.page_id = p.id
         WHERE c.id = @id AND p.status = 'live'`
      ),

      getChunks: this.db.prepare<{ page_id: number }>(
        `SELECT id, page_id AS pageId, ordinal, heading_path AS headingPath, text
         FROM chunk WHERE page_id = @page_id ORDER BY ordinal ASC`
      ),

      getEvidence: this.db.prepare<{ id: number }>(
        `SELECT s.id AS sourceId, s.kind, s.uri, s.title,
                e.locator, e.confirmed_at AS confirmedAt
         FROM evidence e JOIN source s ON e.source_id = s.id
         WHERE e.page_id = @id ORDER BY e.confirmed_at DESC`
      ),

      getHistory: this.db.prepare<{ slug: string }>(
        `SELECT id, status, epistemic, superseded_by, created_at, superseded_at
         FROM page WHERE slug = @slug ORDER BY created_at ASC`
      ),
    };
  }

  // ---- Public API ---------------------------------------------------------

  /**
   * Create or replace a wiki page. The full markdown is the source of truth;
   * it is chunked for indexing, and embeddings of unchanged chunks are reused
   * from the previous version (only changed/new chunks are re-embedded).
   */
  async put(slug: string, opts: PutOptions): Promise<number> {
    const { content, sources, epistemic = "fact" } = opts;
    if (!content.trim()) throw new Error("put: content must not be empty");

    const chunks = chunkMarkdown(content).map((c) => {
      const embedInput = embedInputFor(c);
      return { ...c, embedInput, hash: hashOf(embedInput) };
    });

    const now = Date.now();
    const existing = this.stmts.liveIdBySlug.get({ slug }) as
      | { id: number }
      | undefined;

    // Reuse embeddings from the current live version by content hash.
    const reuse = new Map<string, Buffer>();
    if (existing) {
      const old = this.stmts.chunksByPage.all({ page_id: existing.id }) as {
        id: number;
        embed_hash: string;
      }[];
      for (const oc of old) {
        if (reuse.has(oc.embed_hash)) continue;
        const v = this.stmts.readVec.get(BigInt(oc.id)) as
          | { embedding: Buffer }
          | undefined;
        if (v?.embedding) reuse.set(oc.embed_hash, v.embedding);
      }
    }

    // Embed only what we can't reuse (async, before the sync transaction).
    const vectors = new Map<string, Buffer>();
    for (const c of chunks) {
      if (vectors.has(c.hash)) continue;
      const reused = reuse.get(c.hash);
      vectors.set(c.hash, reused ?? (await embed(c.embedInput, DOC_PREFIX)));
    }

    const txn = this.db.transaction(() => {
      if (existing) {
        this.stmts.staleLive.run({ slug, now });
        const old = this.stmts.chunksByPage.all({ page_id: existing.id }) as {
          id: number;
        }[];
        for (const oc of old) {
          this.stmts.deleteFts.run({ rowid: oc.id });
          this.stmts.deleteVec.run(BigInt(oc.id));
        }
        this.stmts.deleteChunksByPage.run({ page_id: existing.id });
      }

      const newPageId = (
        this.stmts.insertPage.get({
          slug,
          content,
          epistemic,
          created_at: now,
          last_confirmed_at: now,
        }) as { id: number }
      ).id;

      if (existing) {
        this.stmts.linkSupersession.run({
          old_id: existing.id,
          new_id: newPageId,
        });
      }

      for (const c of chunks) {
        const chunkId = (
          this.stmts.insertChunk.get({
            page_id: newPageId,
            ordinal: c.ordinal,
            heading_path: c.headingPath,
            text: c.text,
            embed_hash: c.hash,
          }) as { id: number }
        ).id;
        this.stmts.insertFts.run({ rowid: chunkId, text: c.text });
        this.stmts.insertVec.run(BigInt(chunkId), vectors.get(c.hash)!);
      }

      if (sources) {
        for (const src of sources) {
          const srcId = (
            this.stmts.upsertSource.get({
              kind: src.kind,
              uri: src.uri,
              title: src.title ?? null,
              now,
            }) as { id: number }
          ).id;
          this.stmts.insertEvidence.run({
            page_id: newPageId,
            source_id: srcId,
            locator: src.locator ?? null,
            confirmed_at: now,
          });
        }
        this.stmts.refreshConfirmedAt.run({ id: newPageId });
      }

      return newPageId;
    });

    return txn();
  }

  addEvidence(pageId: number, source: SourceInput): void {
    if (!this.stmts.pageExists.get({ id: pageId })) {
      throw new Error(`addEvidence: page id ${pageId} does not exist`);
    }
    const now = Date.now();
    const txn = this.db.transaction(() => {
      const srcId = (
        this.stmts.upsertSource.get({
          kind: source.kind,
          uri: source.uri,
          title: source.title ?? null,
          now,
        }) as { id: number }
      ).id;
      this.stmts.insertEvidence.run({
        page_id: pageId,
        source_id: srcId,
        locator: source.locator ?? null,
        confirmed_at: now,
      });
      this.stmts.refreshConfirmedAt.run({ id: pageId });
    });
    txn();
  }

  /** Resolve a slug to its current live page (full markdown content). */
  resolveSlug(slug: string): PageRow | undefined {
    return this.stmts.resolveLive.get({ slug }) as PageRow | undefined;
  }

  /** The chunks of a page, in order (for inspection / reconstruction). */
  getChunks(pageId: number): ChunkRow[] {
    return this.stmts.getChunks.all({ page_id: pageId }) as ChunkRow[];
  }

  async hybridSearch(
    query: string,
    topK: number = DEFAULT_TOP_K
  ): Promise<SearchResult[]> {
    if (topK <= 0) return [];

    const queryEmbedding = await embed(query, QUERY_PREFIX);
    const fetchN = topK * 3;

    const ftsQuery = escapeFtsQuery(query);
    let ftsRows: { rowid: number }[] = [];
    if (ftsQuery) {
      try {
        ftsRows = this.stmts.ftsSearch.all({
          query: ftsQuery,
          limit: fetchN,
        }) as { rowid: number }[];
      } catch {
        // trigram may reject very short queries
      }
    }

    const vecRows = this.stmts.vecSearch.all(queryEmbedding, fetchN) as {
      rowid: number;
      distance: number;
    }[];

    const scores = new Map<number, number>();
    for (let i = 0; i < ftsRows.length; i++) {
      const id = ftsRows[i].rowid;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    }
    for (let i = 0; i < vecRows.length; i++) {
      const id = vecRows[i].rowid;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    }

    const ranked = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK);

    const results: SearchResult[] = [];
    for (const [id, score] of ranked) {
      const row = this.stmts.liveSearchRow.get({ id }) as
        | Omit<SearchResult, "score">
        | undefined;
      if (!row) continue; // stale/deleted chunk
      results.push({ ...row, score });
    }
    return results;
  }

  getEvidence(pageId: number): EvidenceRow[] {
    return this.stmts.getEvidence.all({ id: pageId }) as EvidenceRow[];
  }

  getHistory(slug: string): HistoryRow[] {
    return this.stmts.getHistory.all({ slug }) as HistoryRow[];
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeFtsQuery(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 3) return "";
  return `"${trimmed.replace(/"/g, '""')}"`;
}
