/**
 * MemoryStore: the orchestration layer that ties the model, chunking, schema,
 * and prepared statements together into the public store API.
 */
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { applySchema } from "./schema.js";
import { prepareStatements, type Statements } from "./statements.js";
import { embed, DOC_PREFIX, QUERY_PREFIX } from "./model.js";
import { chunkMarkdown, embedInputFor, hashOf } from "./chunk.js";
import type {
  ChunkRow,
  EvidenceRow,
  HistoryRow,
  PageRow,
  PutOptions,
  SearchResult,
  SourceInput,
} from "./types.js";

const RRF_K = 60;
const DEFAULT_TOP_K = 10;

export class MemoryStore {
  private db: Database.Database;
  private stmts: Statements;

  /**
   * Open (or create) a store. Loads sqlite-vec, applies the schema, and
   * compiles the prepared statements for the connection.
   *
   * @param dbPath SQLite file path, or ":memory:" (default) for an ephemeral DB
   */
  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    sqliteVec.load(this.db);
    applySchema(this.db);
    this.stmts = prepareStatements(this.db);
  }

  /**
   * Create or replace a wiki page. The full markdown is the source of truth;
   * it is chunked for indexing, and embeddings of unchanged chunks are reused
   * from the previous version (only changed/new chunks are re-embedded).
   *
   * @returns the new page version's id
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

  /**
   * Attach (or re-confirm) a provenance source on an existing page, refreshing
   * its freshness timestamp. Throws if the page id does not exist.
   */
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

  /**
   * Hybrid search over live chunks: FTS5 (keyword) and sqlite-vec (semantic)
   * results fused with Reciprocal Rank Fusion. Returns chunk-level hits.
   *
   * @param topK number of results (≤ 0 returns an empty array)
   */
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

  /** List a page's evidence (sources), most-recently-confirmed first. */
  getEvidence(pageId: number): EvidenceRow[] {
    return this.stmts.getEvidence.all({ id: pageId }) as EvidenceRow[];
  }

  /** Version history for a slug, oldest first (the live version is current). */
  getHistory(slug: string): HistoryRow[] {
    return this.stmts.getHistory.all({ slug }) as HistoryRow[];
  }

  /** Close the underlying database connection. */
  close(): void {
    this.db.close();
  }
}

/** Escape a raw query into a single FTS5 phrase; "" if too short for trigram. */
function escapeFtsQuery(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length < 3) return "";
  return `"${trimmed.replace(/"/g, '""')}"`;
}
