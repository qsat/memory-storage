import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  pipeline,
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

export interface KnowledgeRow {
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

export interface SearchResult {
  id: number;
  slug: string;
  content: string;
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

// Ruri v3 310m. transformers.js needs an ONNX build, which the canonical
// PyTorch repo (cl-nagoya/ruri-v3-310m) does not ship — so we default to a
// community ONNX conversion. Both the repo and the dtype are overridable via
// env vars because which ONNX build / quantization is available depends on the
// repo you point at. The output dimension stays 768 regardless (it is baked
// into every stored vector — see the guardrails in SKILL.md).
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

// ---------------------------------------------------------------------------
// Embedder (singleton)
// ---------------------------------------------------------------------------

let _embedder: FeatureExtractionPipeline | null = null;

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!_embedder) {
    _embedder = await pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: EMBEDDING_DTYPE,
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

CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live','stale')),
  epistemic TEXT NOT NULL DEFAULT 'fact'
    CHECK (epistemic IN ('fact','inference','hypothesis')),
  superseded_by INTEGER REFERENCES knowledge(id),
  created_at INTEGER NOT NULL,
  last_confirmed_at INTEGER NOT NULL,
  superseded_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_knowledge_slug ON knowledge(slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_live_slug
  ON knowledge(slug) WHERE status = 'live';

CREATE TABLE IF NOT EXISTS evidence (
  knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES source(id),
  locator TEXT,
  confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (knowledge_id, source_id)
);

CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence(source_id);
`;

const FTS_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS fts_knowledge
  USING fts5(content, tokenize='trigram');
`;

// vec0 does not support IF NOT EXISTS — handled separately
const VEC_TABLE_SQL = `
CREATE VIRTUAL TABLE vec_knowledge
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

  // ---- Schema bootstrap ---------------------------------------------------

  private initSchema(): void {
    this.db.exec(SCHEMA_SQL);
    this.db.exec(FTS_TABLE_SQL);

    const hasVec = this.db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_knowledge'"
      )
      .get();
    if (!hasVec) {
      this.db.exec(VEC_TABLE_SQL);
    }
  }

  // ---- Prepared statements ------------------------------------------------

  private prepareStatements() {
    return {
      insertKnowledge: this.db.prepare<{
        slug: string;
        content: string;
        epistemic: string;
        created_at: number;
        last_confirmed_at: number;
      }>(`
        INSERT INTO knowledge (slug, content, epistemic, created_at, last_confirmed_at)
        VALUES (@slug, @content, @epistemic, @created_at, @last_confirmed_at)
        RETURNING id
      `),

      staleLive: this.db.prepare<{ slug: string; now: number }>(
        `UPDATE knowledge SET status = 'stale', superseded_at = @now
         WHERE slug = @slug AND status = 'live'`
      ),

      linkSupersession: this.db.prepare<{
        old_id: number;
        new_id: number;
      }>(
        `UPDATE knowledge SET superseded_by = @new_id
         WHERE id = @old_id`
      ),

      insertFts: this.db.prepare<{ rowid: number; content: string }>(
        `INSERT INTO fts_knowledge (rowid, content) VALUES (@rowid, @content)`
      ),

      deleteFts: this.db.prepare<{ rowid: number }>(
        `DELETE FROM fts_knowledge WHERE rowid = @rowid`
      ),

      insertVec: this.db.prepare<[bigint, Buffer]>(
        `INSERT INTO vec_knowledge (rowid, embedding) VALUES (?, ?)`
      ),

      deleteVec: this.db.prepare<[bigint]>(
        `DELETE FROM vec_knowledge WHERE rowid = ?`
      ),

      upsertSource: this.db.prepare<{
        kind: string;
        uri: string;
        title: string | null;
        now: number;
      }>(`
        INSERT INTO source (kind, uri, title, ingested_at)
        VALUES (@kind, @uri, @title, @now)
        ON CONFLICT (kind, uri) DO UPDATE SET title = COALESCE(excluded.title, title)
        RETURNING id
      `),

      insertEvidence: this.db.prepare<{
        knowledge_id: number;
        source_id: number;
        locator: string | null;
        confirmed_at: number;
      }>(`INSERT INTO evidence (knowledge_id, source_id, locator, confirmed_at)
          VALUES (@knowledge_id, @source_id, @locator, @confirmed_at)
          ON CONFLICT (knowledge_id, source_id) DO UPDATE
            SET confirmed_at = excluded.confirmed_at,
                locator = COALESCE(excluded.locator, locator)`),

      refreshConfirmedAt: this.db.prepare<{ id: number }>(
        `UPDATE knowledge SET last_confirmed_at = COALESCE(
           (SELECT MAX(confirmed_at) FROM evidence WHERE knowledge_id = @id),
           created_at
         ) WHERE id = @id`
      ),

      resolveLive: this.db.prepare<{ slug: string }>(
        `SELECT * FROM knowledge WHERE slug = @slug AND status = 'live'`
      ),

      knowledgeExists: this.db.prepare<{ id: number }>(
        `SELECT 1 FROM knowledge WHERE id = @id`
      ),

      ftsSearch: this.db.prepare<{ query: string; limit: number }>(
        `SELECT rowid FROM fts_knowledge WHERE content MATCH @query
         ORDER BY rank LIMIT @limit`
      ),

      vecSearch: this.db.prepare<[Buffer, number]>(
        `SELECT rowid, distance FROM vec_knowledge
         WHERE embedding MATCH ? AND k = ?
         ORDER BY distance`
      ),

      // Fetch a live knowledge row together with its source count in one query.
      getLiveSearchRow: this.db.prepare<{ id: number }>(
        `SELECT id, slug, content, epistemic, last_confirmed_at AS lastConfirmedAt,
                (SELECT COUNT(*) FROM evidence WHERE knowledge_id = knowledge.id)
                  AS sourceCount
         FROM knowledge WHERE id = @id AND status = 'live'`
      ),

      getEvidence: this.db.prepare<{ id: number }>(
        `SELECT s.id AS sourceId, s.kind, s.uri, s.title,
                e.locator, e.confirmed_at AS confirmedAt
         FROM evidence e JOIN source s ON e.source_id = s.id
         WHERE e.knowledge_id = @id
         ORDER BY e.confirmed_at DESC`
      ),

      getHistory: this.db.prepare<{ slug: string }>(
        `SELECT id, status, epistemic, superseded_by, created_at, superseded_at
         FROM knowledge WHERE slug = @slug
         ORDER BY created_at ASC`
      ),

      getLiveIdBySlug: this.db.prepare<{ slug: string }>(
        `SELECT id FROM knowledge WHERE slug = @slug AND status = 'live'`
      ),
    };
  }

  // ---- Public API ---------------------------------------------------------

  async put(
    slug: string,
    opts: PutOptions
  ): Promise<number> {
    const { content, sources, epistemic = "fact" } = opts;

    if (!content.trim()) {
      throw new Error("put: content must not be empty");
    }

    const embedding = await embed(content, DOC_PREFIX);
    const now = Date.now();

    const existing = this.stmts.getLiveIdBySlug.get({ slug }) as
      | { id: number }
      | undefined;

    const txn = this.db.transaction(() => {
      if (existing) {
        this.stmts.staleLive.run({ slug, now });
        this.stmts.deleteFts.run({ rowid: existing.id });
        this.stmts.deleteVec.run(BigInt(existing.id));
      }

      const row = this.stmts.insertKnowledge.get({
        slug,
        content,
        epistemic,
        created_at: now,
        last_confirmed_at: now,
      }) as { id: number };
      const newId = row.id;

      if (existing) {
        this.stmts.linkSupersession.run({
          old_id: existing.id,
          new_id: newId,
        });
      }

      this.stmts.insertFts.run({ rowid: newId, content });
      this.stmts.insertVec.run(BigInt(newId), embedding);

      if (sources) {
        for (const src of sources) {
          const srcRow = this.stmts.upsertSource.get({
            kind: src.kind,
            uri: src.uri,
            title: src.title ?? null,
            now,
          }) as { id: number };
          this.stmts.insertEvidence.run({
            knowledge_id: newId,
            source_id: srcRow.id,
            locator: src.locator ?? null,
            confirmed_at: now,
          });
        }
        this.stmts.refreshConfirmedAt.run({ id: newId });
      }

      return newId;
    });

    return txn();
  }

  addEvidence(knowledgeId: number, source: SourceInput): void {
    if (!this.stmts.knowledgeExists.get({ id: knowledgeId })) {
      throw new Error(`addEvidence: knowledge id ${knowledgeId} does not exist`);
    }

    const now = Date.now();
    const txn = this.db.transaction(() => {
      const srcRow = this.stmts.upsertSource.get({
        kind: source.kind,
        uri: source.uri,
        title: source.title ?? null,
        now,
      }) as { id: number };

      this.stmts.insertEvidence.run({
        knowledge_id: knowledgeId,
        source_id: srcRow.id,
        locator: source.locator ?? null,
        confirmed_at: now,
      });

      this.stmts.refreshConfirmedAt.run({ id: knowledgeId });
    });
    txn();
  }

  resolveSlug(slug: string): KnowledgeRow | undefined {
    return this.stmts.resolveLive.get({ slug }) as KnowledgeRow | undefined;
  }

  async hybridSearch(
    query: string,
    topK: number = DEFAULT_TOP_K
  ): Promise<SearchResult[]> {
    if (topK <= 0) return [];

    const queryEmbedding = await embed(query, QUERY_PREFIX);
    const fetchN = topK * 3;

    // FTS — escape query as a trigram phrase
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

    // Vec
    const vecRows = this.stmts.vecSearch.all(queryEmbedding, fetchN) as {
      rowid: number;
      distance: number;
    }[];

    // RRF fusion
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
      const row = this.stmts.getLiveSearchRow.get({ id }) as
        | Omit<SearchResult, "score">
        | undefined;
      // Indexes only hold live rows, so a miss here means a stale/deleted entry.
      if (!row) continue;
      results.push({ ...row, score });
    }
    return results;
  }

  getEvidence(knowledgeId: number): EvidenceRow[] {
    return this.stmts.getEvidence.all({ id: knowledgeId }) as EvidenceRow[];
  }

  getHistory(slug: string): HistoryRow[] {
    return this.stmts.getHistory.all({ slug }) as HistoryRow[];
  }

  // ---- Lifecycle ----------------------------------------------------------

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
  const escaped = trimmed.replace(/"/g, '""');
  return `"${escaped}"`;
}
