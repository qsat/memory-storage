/**
 * Prepared statements for the store. `prepareStatements(db)` compiles every
 * query once against a connection and returns them as a named bag; the store
 * holds the result and reuses it for the connection's lifetime.
 */
import Database from "better-sqlite3";

/** The bag of prepared statements a {@link MemoryStore} holds. */
export type Statements = Record<string, Database.Statement>;

/**
 * Compile all prepared statements for a connection. The per-call `prepare<…>`
 * generics document each statement's bind shape; the return type is widened to
 * a named bag so it can be referenced from emitted declarations.
 *
 * @param db an open better-sqlite3 connection (schema already applied)
 * @returns an object of named, reusable prepared statements
 */
export function prepareStatements(db: Database.Database): Statements {
  return {
    // ---- page lifecycle ----------------------------------------------------
    insertPage: db.prepare(`
      INSERT INTO page (id, slug, content, epistemic, created_at, last_confirmed_at)
      VALUES (@id, @slug, @content, @epistemic, @created_at, @last_confirmed_at)
    `),
    /** Mark the current live page for a slug as stale (frees the live slot). */
    staleLive: db.prepare<{ slug: string; now: number }>(
      `UPDATE page SET status = 'stale', superseded_at = @now
       WHERE slug = @slug AND status = 'live'`
    ),
    linkSupersession: db.prepare<{ old_id: string; new_id: string }>(
      `UPDATE page SET superseded_by = @new_id WHERE id = @old_id`
    ),
    resolveLive: db.prepare<{ slug: string }>(
      `SELECT * FROM page WHERE slug = @slug AND status = 'live'`
    ),
    /** Any version by id (live or stale) — the page row itself is never deleted. */
    pageById: db.prepare<{ id: string }>(`SELECT * FROM page WHERE id = @id`),
    liveIdBySlug: db.prepare<{ slug: string }>(
      `SELECT id FROM page WHERE slug = @slug AND status = 'live'`
    ),
    pageExists: db.prepare<{ id: string }>(`SELECT 1 FROM page WHERE id = @id`),
    getHistory: db.prepare<{ slug: string }>(
      `SELECT id, status, epistemic, superseded_by, created_at, superseded_at
       FROM page WHERE slug = @slug ORDER BY created_at ASC`
    ),

    // ---- chunks ------------------------------------------------------------
    insertChunk: db.prepare(`
      INSERT INTO chunk (uuid, page_id, ordinal, heading_path, text, embed_hash)
      VALUES (@uuid, @page_id, @ordinal, @heading_path, @text, @embed_hash)
      RETURNING id
    `),
    chunksByPage: db.prepare<{ page_id: string }>(
      `SELECT id, embed_hash FROM chunk WHERE page_id = @page_id`
    ),
    deleteChunksByPage: db.prepare<{ page_id: string }>(
      `DELETE FROM chunk WHERE page_id = @page_id`
    ),
    getChunks: db.prepare<{ page_id: string }>(
      `SELECT id, uuid, page_id AS pageId, ordinal, heading_path AS headingPath, text
       FROM chunk WHERE page_id = @page_id ORDER BY ordinal ASC`
    ),

    // ---- FTS / vector indexes (rowid = chunk.id) ---------------------------
    insertFts: db.prepare<{ rowid: number; text: string }>(
      `INSERT INTO fts_chunk (rowid, text) VALUES (@rowid, @text)`
    ),
    deleteFts: db.prepare<{ rowid: number }>(
      `DELETE FROM fts_chunk WHERE rowid = @rowid`
    ),
    insertVec: db.prepare<[bigint, Buffer]>(
      `INSERT INTO vec_chunk (rowid, embedding) VALUES (?, ?)`
    ),
    deleteVec: db.prepare(`DELETE FROM vec_chunk WHERE rowid = ?`),
    /** Read a stored embedding back (to reuse for an unchanged chunk). */
    readVec: db.prepare(`SELECT embedding FROM vec_chunk WHERE rowid = ?`),
    ftsSearch: db.prepare<{ query: string; limit: number }>(
      `SELECT rowid FROM fts_chunk WHERE text MATCH @query
       ORDER BY rank LIMIT @limit`
    ),
    vecSearch: db.prepare<[Buffer, number]>(
      `SELECT rowid, distance FROM vec_chunk
       WHERE embedding MATCH ? AND k = ? ORDER BY distance`
    ),
    /** A chunk hit joined with its live page + source count, in one query. */
    liveSearchRow: db.prepare<{ id: number }>(
      `SELECT c.id AS chunkId, c.page_id AS pageId, p.slug, c.ordinal,
              c.heading_path AS headingPath, c.text, p.epistemic,
              p.last_confirmed_at AS lastConfirmedAt,
              (SELECT COUNT(*) FROM evidence WHERE page_id = p.id) AS sourceCount
       FROM chunk c JOIN page p ON c.page_id = p.id
       WHERE c.id = @id AND p.status = 'live'`
    ),
    /** A single chunk with full metadata, joined with its live page (no score). */
    chunkDetail: db.prepare<{ id: number }>(
      `SELECT c.id AS chunkId, c.uuid AS chunkUuid, c.page_id AS pageId, p.slug,
              c.ordinal, c.heading_path AS headingPath, c.text,
              c.embed_hash AS embedHash, p.epistemic,
              p.last_confirmed_at AS lastConfirmedAt,
              (SELECT COUNT(*) FROM evidence WHERE page_id = p.id) AS sourceCount
       FROM chunk c JOIN page p ON c.page_id = p.id
       WHERE c.id = @id AND p.status = 'live'`
    ),
    /** Chunks of a (live) page within an ordinal range, for neighbor lookup. */
    chunksInOrdinalRange: db.prepare<{
      page_id: string;
      min_ordinal: number;
      max_ordinal: number;
    }>(
      `SELECT c.id AS chunkId, c.uuid AS chunkUuid, c.page_id AS pageId, p.slug,
              c.ordinal, c.heading_path AS headingPath, c.text,
              c.embed_hash AS embedHash, p.epistemic,
              p.last_confirmed_at AS lastConfirmedAt,
              (SELECT COUNT(*) FROM evidence WHERE page_id = p.id) AS sourceCount
       FROM chunk c JOIN page p ON c.page_id = p.id
       WHERE c.page_id = @page_id AND p.status = 'live'
         AND c.ordinal BETWEEN @min_ordinal AND @max_ordinal
       ORDER BY c.ordinal ASC`
    ),

    // ---- provenance --------------------------------------------------------
    upsertSource: db.prepare(`
      INSERT INTO source (kind, uri, title, ingested_at)
      VALUES (@kind, @uri, @title, @now)
      ON CONFLICT (kind, uri) DO UPDATE SET title = COALESCE(excluded.title, title)
      RETURNING id
    `),
    insertEvidence: db.prepare<{
      page_id: string;
      source_id: number;
      locator: string | null;
      confirmed_at: number;
    }>(`INSERT INTO evidence (page_id, source_id, locator, confirmed_at)
        VALUES (@page_id, @source_id, @locator, @confirmed_at)
        ON CONFLICT (page_id, source_id) DO UPDATE
          SET confirmed_at = excluded.confirmed_at,
              locator = COALESCE(excluded.locator, locator)`),
    /** Recompute a page's freshness cache from its evidence (or created_at). */
    refreshConfirmedAt: db.prepare<{ id: string }>(
      `UPDATE page SET last_confirmed_at = COALESCE(
         (SELECT MAX(confirmed_at) FROM evidence WHERE page_id = @id),
         created_at
       ) WHERE id = @id`
    ),
    getEvidence: db.prepare<{ id: string }>(
      `SELECT s.id AS sourceId, s.kind, s.uri, s.title,
              e.locator, e.confirmed_at AS confirmedAt
       FROM evidence e JOIN source s ON e.source_id = s.id
       WHERE e.page_id = @id ORDER BY e.confirmed_at DESC`
    ),
  };
}
