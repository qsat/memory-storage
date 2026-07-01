#!/usr/bin/env node

// src/cli.ts
import fs2 from "node:fs";
import path2 from "node:path";
import { parseArgs } from "node:util";

// ../core/dist/store.js
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

// ../../node_modules/uuidv7/dist/index.js
var DIGITS = "0123456789abcdef";
var UUID = class _UUID {
  /** @param bytes - The 16-byte byte array representation. */
  constructor(bytes) {
    this.bytes = bytes;
  }
  /**
   * Creates an object from the internal representation, a 16-byte byte array
   * containing the binary UUID representation in the big-endian byte order.
   *
   * This method does NOT shallow-copy the argument, and thus the created object
   * holds the reference to the underlying buffer.
   *
   * @throws TypeError if the length of the argument is not 16.
   */
  static ofInner(bytes) {
    if (bytes.length !== 16) {
      throw new TypeError("not 128-bit length");
    } else {
      return new _UUID(bytes);
    }
  }
  /**
   * Builds a byte array from UUIDv7 field values.
   *
   * @param unixTsMs - A 48-bit `unix_ts_ms` field value.
   * @param randA - A 12-bit `rand_a` field value.
   * @param randBHi - The higher 30 bits of 62-bit `rand_b` field value.
   * @param randBLo - The lower 32 bits of 62-bit `rand_b` field value.
   * @throws RangeError if any field value is out of the specified range.
   */
  static fromFieldsV7(unixTsMs, randA, randBHi, randBLo) {
    if (!Number.isInteger(unixTsMs) || !Number.isInteger(randA) || !Number.isInteger(randBHi) || !Number.isInteger(randBLo) || unixTsMs < 0 || randA < 0 || randBHi < 0 || randBLo < 0 || unixTsMs > 281474976710655 || randA > 4095 || randBHi > 1073741823 || randBLo > 4294967295) {
      throw new RangeError("invalid field value");
    }
    const bytes = new Uint8Array(16);
    bytes[0] = unixTsMs / 2 ** 40;
    bytes[1] = unixTsMs / 2 ** 32;
    bytes[2] = unixTsMs / 2 ** 24;
    bytes[3] = unixTsMs / 2 ** 16;
    bytes[4] = unixTsMs / 2 ** 8;
    bytes[5] = unixTsMs;
    bytes[6] = 112 | randA >>> 8;
    bytes[7] = randA;
    bytes[8] = 128 | randBHi >>> 24;
    bytes[9] = randBHi >>> 16;
    bytes[10] = randBHi >>> 8;
    bytes[11] = randBHi;
    bytes[12] = randBLo >>> 24;
    bytes[13] = randBLo >>> 16;
    bytes[14] = randBLo >>> 8;
    bytes[15] = randBLo;
    return new _UUID(bytes);
  }
  /**
   * Builds a byte array from a string representation.
   *
   * This method accepts the following formats:
   *
   * - 32-digit hexadecimal format without hyphens: `0189dcd553117d408db09496a2eef37b`
   * - 8-4-4-4-12 hyphenated format: `0189dcd5-5311-7d40-8db0-9496a2eef37b`
   * - Hyphenated format with surrounding braces: `{0189dcd5-5311-7d40-8db0-9496a2eef37b}`
   * - RFC 9562 URN format: `urn:uuid:0189dcd5-5311-7d40-8db0-9496a2eef37b`
   *
   * Leading and trailing whitespaces represents an error.
   *
   * @throws SyntaxError if the argument could not parse as a valid UUID string.
   */
  static parse(uuid) {
    var _a, _b, _c, _d;
    let hex = void 0;
    switch (uuid.length) {
      case 32:
        hex = (_a = /^[0-9a-f]{32}$/i.exec(uuid)) === null || _a === void 0 ? void 0 : _a[0];
        break;
      case 36:
        hex = (_b = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(uuid)) === null || _b === void 0 ? void 0 : _b.slice(1, 6).join("");
        break;
      case 38:
        hex = (_c = /^\{([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}$/i.exec(uuid)) === null || _c === void 0 ? void 0 : _c.slice(1, 6).join("");
        break;
      case 45:
        hex = (_d = /^urn:uuid:([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(uuid)) === null || _d === void 0 ? void 0 : _d.slice(1, 6).join("");
        break;
      default:
        break;
    }
    if (hex) {
      const inner = new Uint8Array(16);
      for (let i = 0; i < 16; i += 4) {
        const n = parseInt(hex.substring(2 * i, 2 * i + 8), 16);
        inner[i + 0] = n >>> 24;
        inner[i + 1] = n >>> 16;
        inner[i + 2] = n >>> 8;
        inner[i + 3] = n;
      }
      return new _UUID(inner);
    } else {
      throw new SyntaxError("could not parse UUID string");
    }
  }
  /**
   * @returns The 8-4-4-4-12 canonical hexadecimal string representation
   * (`0189dcd5-5311-7d40-8db0-9496a2eef37b`).
   */
  toString() {
    let text = "";
    for (let i = 0; i < this.bytes.length; i++) {
      text += DIGITS.charAt(this.bytes[i] >>> 4);
      text += DIGITS.charAt(this.bytes[i] & 15);
      if (i === 3 || i === 5 || i === 7 || i === 9) {
        text += "-";
      }
    }
    return text;
  }
  /**
   * @returns The 32-digit hexadecimal representation without hyphens
   * (`0189dcd553117d408db09496a2eef37b`).
   */
  toHex() {
    let text = "";
    for (let i = 0; i < this.bytes.length; i++) {
      text += DIGITS.charAt(this.bytes[i] >>> 4);
      text += DIGITS.charAt(this.bytes[i] & 15);
    }
    return text;
  }
  /** @returns The 8-4-4-4-12 canonical hexadecimal string representation. */
  toJSON() {
    return this.toString();
  }
  /**
   * Reports the variant field value of the UUID or, if appropriate, "NIL" or
   * "MAX".
   *
   * For convenience, this method reports "NIL" or "MAX" if `this` represents
   * the Nil or Max UUID, although the Nil and Max UUIDs are technically
   * subsumed under the variants `0b0` and `0b111`, respectively.
   */
  getVariant() {
    const n = this.bytes[8] >>> 4;
    if (n < 0) {
      throw new Error("unreachable");
    } else if (n <= 7) {
      return this.isNil() ? "NIL" : "VAR_0";
    } else if (n <= 11) {
      return "VAR_10";
    } else if (n <= 13) {
      return "VAR_110";
    } else if (n <= 15) {
      return this.isMax() ? "MAX" : "VAR_RESERVED";
    } else {
      throw new Error("unreachable");
    }
  }
  /**
   * Returns the version field value of the UUID or `undefined` if the UUID does
   * not have the variant field value of `0b10`.
   */
  getVersion() {
    return this.getVariant() === "VAR_10" ? this.bytes[6] >>> 4 : void 0;
  }
  /** Returns `true` if `this` is the Nil UUID. */
  isNil() {
    return this.bytes.every((e) => e === 0);
  }
  /** Returns `true` if `this` is the Max UUID. */
  isMax() {
    return this.bytes.every((e) => e === 255);
  }
  /** Creates an object from `this`. */
  clone() {
    return new _UUID(this.bytes.slice(0));
  }
  /** Returns true if `this` is equivalent to `other`. */
  equals(other) {
    return this.compareTo(other) === 0;
  }
  /**
   * Returns a negative integer, zero, or positive integer if `this` is less
   * than, equal to, or greater than `other`, respectively.
   */
  compareTo(other) {
    for (let i = 0; i < 16; i++) {
      const diff = this.bytes[i] - other.bytes[i];
      if (diff !== 0) {
        return Math.sign(diff);
      }
    }
    return 0;
  }
};
var V7Generator = class {
  /**
   * Creates a generator object with the default random number generator, or
   * with the specified one if passed as an argument. The specified random
   * number generator should be cryptographically strong and securely seeded.
   */
  constructor(randomNumberGenerator) {
    this.timestampBiased = 0;
    this.counter = 0;
    this.rollbackAllowance = 1e4;
    this.random = randomNumberGenerator !== null && randomNumberGenerator !== void 0 ? randomNumberGenerator : getDefaultRandom();
  }
  /**
   * Sets the `rollbackAllowance` parameter of the generator.
   *
   * The `rollbackAllowance` parameter specifies the amount of `unixTsMs`
   * rollback that is considered significant. The default value is `10_000`
   * (milliseconds). See the {@link generate} or {@link generateOrAbort}
   * documentation for the treatment of the significant rollback.
   *
   */
  setRollbackAllowance(rollbackAllowance) {
    if (rollbackAllowance < 0 || rollbackAllowance > 281474976710655) {
      throw new RangeError("`rollbackAllowance` out of reasonable range");
    }
    this.rollbackAllowance = rollbackAllowance;
  }
  /**
   * Generates a new UUIDv7 object from the current timestamp, or resets the
   * generator upon significant timestamp rollback.
   *
   * This method returns a monotonically increasing UUID by reusing the previous
   * timestamp even if the up-to-date timestamp is smaller than the immediately
   * preceding UUID's. However, when such a clock rollback is considered
   * significant (by default, more than ten seconds), this method resets the
   * generator and returns a new UUID based on the given timestamp, breaking the
   * increasing order of UUIDs.
   *
   * See {@link generateOrAbort} for the other mode of generation and
   * {@link generateOrResetWithTs} for the variant accepting a custom timestamp.
   */
  generate() {
    return this.generateOrResetWithTs(Date.now());
  }
  /**
   * Generates a new UUIDv7 object from the current timestamp, or returns
   * `undefined` upon significant timestamp rollback.
   *
   * This method returns a monotonically increasing UUID by reusing the previous
   * timestamp even if the up-to-date timestamp is smaller than the immediately
   * preceding UUID's. However, when such a clock rollback is considered
   * significant (by default, more than ten seconds), this method aborts and
   * returns `undefined` immediately.
   *
   * See {@link generate} for the other mode of generation and
   * {@link generateOrAbortWithTs} for the variant accepting a custom timestamp.
   */
  generateOrAbort() {
    return this.generateOrAbortWithTs(Date.now());
  }
  /**
   * Generates a new UUIDv7 object from the `unixTsMs` passed, or resets the
   * generator upon significant timestamp rollback.
   *
   * This method is equivalent to {@link generate} except that it takes a custom
   * timestamp.
   *
   * @throws RangeError if `unixTsMs` is not a 48-bit unsigned integer.
   */
  generateOrResetWithTs(unixTsMs) {
    let value = this.generateOrAbortWithTs(unixTsMs);
    if (value === void 0) {
      this.timestampBiased = 0;
      value = this.generateOrAbortWithTs(unixTsMs);
    }
    return value;
  }
  /**
   * Generates a new UUIDv7 object from the `unixTsMs` passed, or returns
   * `undefined` upon significant timestamp rollback.
   *
   * This method is equivalent to {@link generateOrAbort} except that it takes a
   * custom timestamp.
   *
   * @throws RangeError if `unixTsMs` is not a 48-bit unsigned integer.
   */
  generateOrAbortWithTs(unixTsMs) {
    const MAX_COUNTER = 4398046511103;
    if (!Number.isInteger(unixTsMs) || unixTsMs < 0 || unixTsMs > 281474976710655) {
      throw new RangeError("`unixTsMs` must be a 48-bit unsigned integer");
    }
    unixTsMs++;
    if (unixTsMs > this.timestampBiased) {
      this.timestampBiased = unixTsMs;
      this.resetCounter();
    } else if (unixTsMs + this.rollbackAllowance >= this.timestampBiased) {
      this.counter++;
      if (this.counter > MAX_COUNTER) {
        this.timestampBiased++;
        this.resetCounter();
      }
    } else {
      return void 0;
    }
    return UUID.fromFieldsV7(this.timestampBiased - 1, Math.trunc(this.counter / 2 ** 30), this.counter & 2 ** 30 - 1, this.random.nextUint32());
  }
  /**
   * Generates a new UUIDv7 object from the `unixTsMs` passed, or resets the
   * generator upon significant timestamp rollback.
   *
   * This method is a deprecated version of {@link generateOrResetWithTs} that
   * accepts the `rollbackAllowance` parameter as an argument, rather than using
   * the generator-level parameter.
   *
   * @param rollbackAllowance - The amount of `unixTsMs` rollback that is
   * considered significant. A suggested value is `10_000` (milliseconds).
   * @throws RangeError if `unixTsMs` is not a 48-bit unsigned integer.
   * @deprecated Since v1.2.0. Use {@link generateOrResetWithTs} instead.
   */
  generateOrResetCore(unixTsMs, rollbackAllowance) {
    const origRollbackAllowance = this.rollbackAllowance;
    try {
      this.setRollbackAllowance(rollbackAllowance);
      return this.generateOrResetWithTs(unixTsMs);
    } catch (e) {
      throw e;
    } finally {
      this.rollbackAllowance = origRollbackAllowance;
    }
  }
  /**
   * Generates a new UUIDv7 object from the `unixTsMs` passed, or returns
   * `undefined` upon significant timestamp rollback.
   *
   * This method is a deprecated version of {@link generateOrAbortWithTs} that
   * accepts the `rollbackAllowance` parameter as an argument, rather than using
   * the generator-level parameter.
   *
   * @param rollbackAllowance - The amount of `unixTsMs` rollback that is
   * considered significant. A suggested value is `10_000` (milliseconds).
   * @throws RangeError if `unixTsMs` is not a 48-bit unsigned integer.
   * @deprecated Since v1.2.0. Use {@link generateOrAbortWithTs} instead.
   */
  generateOrAbortCore(unixTsMs, rollbackAllowance) {
    const origRollbackAllowance = this.rollbackAllowance;
    try {
      this.setRollbackAllowance(rollbackAllowance);
      return this.generateOrAbortWithTs(unixTsMs);
    } catch (e) {
      throw e;
    } finally {
      this.rollbackAllowance = origRollbackAllowance;
    }
  }
  /** Initializes the counter at a 42-bit random integer. */
  resetCounter() {
    this.counter = this.random.nextUint32() * 1024 + (this.random.nextUint32() & 1023);
  }
  /**
   * Generates a new UUIDv4 object utilizing the random number generator inside.
   *
   * @internal
   */
  generateV4() {
    const bytes = new Uint8Array(Uint32Array.of(this.random.nextUint32(), this.random.nextUint32(), this.random.nextUint32(), this.random.nextUint32()).buffer);
    bytes[6] = 64 | bytes[6] >>> 4;
    bytes[8] = 128 | bytes[8] >>> 2;
    return UUID.ofInner(bytes);
  }
};
var getDefaultRandom = () => {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues !== "undefined") {
    return new BufferedCryptoRandom();
  } else {
    if (typeof UUIDV7_DENY_WEAK_RNG !== "undefined" && UUIDV7_DENY_WEAK_RNG) {
      throw new Error("no cryptographically strong RNG available");
    }
    return {
      nextUint32: () => Math.trunc(Math.random() * 65536) * 65536 + Math.trunc(Math.random() * 65536)
    };
  }
};
var BufferedCryptoRandom = class {
  constructor() {
    this.buffer = new Uint32Array(8);
    this.cursor = 65535;
  }
  nextUint32() {
    if (this.cursor >= this.buffer.length) {
      crypto.getRandomValues(this.buffer);
      this.cursor = 0;
    }
    return this.buffer[this.cursor++];
  }
};
var defaultGenerator;
var uuidv7 = () => uuidv7obj().toString();
var uuidv7obj = () => (defaultGenerator || (defaultGenerator = new V7Generator())).generate();

// ../core/dist/model.js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline, env as transformersEnv } from "@huggingface/transformers";
var EMBEDDING_MODEL = process.env.MEMORY_EMBEDDING_MODEL ?? "sirasagi62/ruri-v3-310m-ONNX";
var EMBEDDING_DIM = 768;
var EMBEDDING_DTYPE = process.env.MEMORY_EMBEDDING_DTYPE ?? "q8";
var DOC_PREFIX = "\u691C\u7D22\u6587\u66F8: ";
var QUERY_PREFIX = "\u691C\u7D22\u30AF\u30A8\u30EA: ";
function resolveUserPath(p) {
  if (p === "~")
    return os.homedir();
  if (p.startsWith("~/"))
    return path.join(os.homedir(), p.slice(2));
  if (path.isAbsolute(p))
    return p;
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), p);
}
var MODEL_CACHE_DIR = resolveUserPath(process.env.MEMORY_MODEL_CACHE ?? path.join(os.homedir(), ".cache", "memory-storage"));
transformersEnv.cacheDir = MODEL_CACHE_DIR;
function ensureModelCacheDir() {
  if (fs.existsSync(MODEL_CACHE_DIR))
    return;
  const cacheRoot = path.join(os.homedir(), ".cache");
  const underCacheRoot = MODEL_CACHE_DIR === cacheRoot || MODEL_CACHE_DIR.startsWith(cacheRoot + path.sep);
  if (underCacheRoot) {
    fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });
    return;
  }
  throw new Error(`model cache directory does not exist: ${MODEL_CACHE_DIR}
Refusing to create directories outside ~/.cache. Create it first (e.g. mkdir -p "${MODEL_CACHE_DIR}") or set MEMORY_MODEL_CACHE under ~/.cache.`);
}
var _embedder = null;
var _progressCallback;
function onModelProgress(cb) {
  _progressCallback = cb;
}
async function getEmbedder() {
  if (!_embedder) {
    ensureModelCacheDir();
    _embedder = await pipeline("feature-extraction", EMBEDDING_MODEL, {
      dtype: EMBEDDING_DTYPE,
      progress_callback: _progressCallback
    });
  }
  return _embedder;
}
async function embed(text, prefix) {
  const embedder = await getEmbedder();
  const output = await embedder(`${prefix}${text}`, {
    pooling: "mean",
    normalize: true
  });
  const f32 = new Float32Array(output.tolist()[0]);
  return Buffer.from(f32.buffer);
}

// ../core/dist/schema.js
var SCHEMA_SQL = `
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
var FTS_TABLE_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS fts_chunk
  USING fts5(text, tokenize='trigram');
`;
var VEC_TABLE_SQL = `
CREATE VIRTUAL TABLE vec_chunk
  USING vec0(rowid INTEGER PRIMARY KEY, embedding FLOAT[${EMBEDDING_DIM}]);
`;
function applySchema(db) {
  db.exec(SCHEMA_SQL);
  db.exec(FTS_TABLE_SQL);
  const hasVec = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_chunk'").get();
  if (!hasVec)
    db.exec(VEC_TABLE_SQL);
}

// ../core/dist/statements.js
function prepareStatements(db) {
  return {
    // ---- page lifecycle ----------------------------------------------------
    insertPage: db.prepare(`
      INSERT INTO page (id, slug, content, epistemic, created_at, last_confirmed_at)
      VALUES (@id, @slug, @content, @epistemic, @created_at, @last_confirmed_at)
    `),
    /** Mark the current live page for a slug as stale (frees the live slot). */
    staleLive: db.prepare(`UPDATE page SET status = 'stale', superseded_at = @now
       WHERE slug = @slug AND status = 'live'`),
    linkSupersession: db.prepare(`UPDATE page SET superseded_by = @new_id WHERE id = @old_id`),
    resolveLive: db.prepare(`SELECT * FROM page WHERE slug = @slug AND status = 'live'`),
    /** Any version by id (live or stale) — the page row itself is never deleted. */
    pageById: db.prepare(`SELECT * FROM page WHERE id = @id`),
    liveIdBySlug: db.prepare(`SELECT id FROM page WHERE slug = @slug AND status = 'live'`),
    pageExists: db.prepare(`SELECT 1 FROM page WHERE id = @id`),
    getHistory: db.prepare(`SELECT id, status, epistemic, superseded_by, created_at, superseded_at
       FROM page WHERE slug = @slug ORDER BY created_at ASC`),
    /** Every page version's identity (no content) — for enumerating all pages. */
    listPages: db.prepare(`SELECT id, slug, status FROM page ORDER BY slug ASC, created_at ASC`),
    // ---- chunks ------------------------------------------------------------
    insertChunk: db.prepare(`
      INSERT INTO chunk (uuid, page_id, ordinal, heading_path, text, embed_hash)
      VALUES (@uuid, @page_id, @ordinal, @heading_path, @text, @embed_hash)
      RETURNING id
    `),
    chunksByPage: db.prepare(`SELECT id, embed_hash FROM chunk WHERE page_id = @page_id`),
    deleteChunksByPage: db.prepare(`DELETE FROM chunk WHERE page_id = @page_id`),
    getChunks: db.prepare(`SELECT id, uuid, page_id AS pageId, ordinal, heading_path AS headingPath, text
       FROM chunk WHERE page_id = @page_id ORDER BY ordinal ASC`),
    // ---- FTS / vector indexes (rowid = chunk.id) ---------------------------
    insertFts: db.prepare(`INSERT INTO fts_chunk (rowid, text) VALUES (@rowid, @text)`),
    deleteFts: db.prepare(`DELETE FROM fts_chunk WHERE rowid = @rowid`),
    insertVec: db.prepare(`INSERT INTO vec_chunk (rowid, embedding) VALUES (?, ?)`),
    deleteVec: db.prepare(`DELETE FROM vec_chunk WHERE rowid = ?`),
    /** Read a stored embedding back (to reuse for an unchanged chunk). */
    readVec: db.prepare(`SELECT embedding FROM vec_chunk WHERE rowid = ?`),
    ftsSearch: db.prepare(`SELECT rowid FROM fts_chunk WHERE text MATCH @query
       ORDER BY rank LIMIT @limit`),
    vecSearch: db.prepare(`SELECT rowid, distance FROM vec_chunk
       WHERE embedding MATCH ? AND k = ? ORDER BY distance`),
    /** A chunk hit joined with its live page + source count, in one query. */
    liveSearchRow: db.prepare(`SELECT c.id AS chunkId, c.page_id AS pageId, p.slug, c.ordinal,
              c.heading_path AS headingPath, c.text, p.epistemic,
              p.last_confirmed_at AS lastConfirmedAt,
              (SELECT COUNT(*) FROM evidence WHERE page_id = p.id) AS sourceCount
       FROM chunk c JOIN page p ON c.page_id = p.id
       WHERE c.id = @id AND p.status = 'live'`),
    /** A single chunk with full metadata, joined with its live page (no score). */
    chunkDetail: db.prepare(`SELECT c.id AS chunkId, c.uuid AS chunkUuid, c.page_id AS pageId, p.slug,
              c.ordinal, c.heading_path AS headingPath, c.text,
              c.embed_hash AS embedHash, p.epistemic,
              p.last_confirmed_at AS lastConfirmedAt,
              (SELECT COUNT(*) FROM evidence WHERE page_id = p.id) AS sourceCount
       FROM chunk c JOIN page p ON c.page_id = p.id
       WHERE c.id = @id AND p.status = 'live'`),
    /** Chunks of a (live) page within an ordinal range, for neighbor lookup. */
    chunksInOrdinalRange: db.prepare(`SELECT c.id AS chunkId, c.uuid AS chunkUuid, c.page_id AS pageId, p.slug,
              c.ordinal, c.heading_path AS headingPath, c.text,
              c.embed_hash AS embedHash, p.epistemic,
              p.last_confirmed_at AS lastConfirmedAt,
              (SELECT COUNT(*) FROM evidence WHERE page_id = p.id) AS sourceCount
       FROM chunk c JOIN page p ON c.page_id = p.id
       WHERE c.page_id = @page_id AND p.status = 'live'
         AND c.ordinal BETWEEN @min_ordinal AND @max_ordinal
       ORDER BY c.ordinal ASC`),
    // ---- provenance --------------------------------------------------------
    upsertSource: db.prepare(`
      INSERT INTO source (kind, uri, title, ingested_at)
      VALUES (@kind, @uri, @title, @now)
      ON CONFLICT (kind, uri) DO UPDATE SET title = COALESCE(excluded.title, title)
      RETURNING id
    `),
    insertEvidence: db.prepare(`INSERT INTO evidence (page_id, source_id, locator, confirmed_at)
        VALUES (@page_id, @source_id, @locator, @confirmed_at)
        ON CONFLICT (page_id, source_id) DO UPDATE
          SET confirmed_at = excluded.confirmed_at,
              locator = COALESCE(excluded.locator, locator)`),
    /** Recompute a page's freshness cache from its evidence (or created_at). */
    refreshConfirmedAt: db.prepare(`UPDATE page SET last_confirmed_at = COALESCE(
         (SELECT MAX(confirmed_at) FROM evidence WHERE page_id = @id),
         created_at
       ) WHERE id = @id`),
    getEvidence: db.prepare(`SELECT s.id AS sourceId, s.kind, s.uri, s.title,
              e.locator, e.confirmed_at AS confirmedAt
       FROM evidence e JOIN source s ON e.source_id = s.id
       WHERE e.page_id = @id ORDER BY e.confirmed_at DESC`)
  };
}

// ../core/dist/chunk.js
import { createHash } from "node:crypto";
var CHUNK_MAX_CHARS = Number(process.env.MEMORY_CHUNK_MAX_CHARS ?? 1200);
var HEADING_RE = /^(#{1,6})\s+(.*)$/;
var FENCE_RE = /```[\s\S]*?```/g;
function chunkMarkdown(content, maxChars = CHUNK_MAX_CHARS) {
  const lines = content.split(/\r?\n/);
  const sections = [];
  const stack = [];
  let current = {
    headingPath: "",
    lines: []
  };
  const flush = () => {
    if (current.lines.join("\n").trim())
      sections.push(current);
  };
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      const title = m[2].trim();
      while (stack.length && stack[stack.length - 1].level >= level)
        stack.pop();
      stack.push({ level, title });
      current = {
        headingPath: stack.map((s) => s.title).join(" > "),
        lines: [line]
      };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  const chunks = [];
  let ordinal = 0;
  for (const sec of sections) {
    const text = sec.lines.join("\n").trim();
    if (!text)
      continue;
    for (const piece of splitByBudget(text, maxChars)) {
      chunks.push({
        ordinal: ordinal++,
        headingPath: sec.headingPath || null,
        text: piece
      });
    }
  }
  if (chunks.length === 0) {
    chunks.push({ ordinal: 0, headingPath: null, text: content.trim() });
  }
  return chunks;
}
function splitByBudget(text, maxChars) {
  if (text.length <= maxChars)
    return [text];
  const pieces = [];
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
      if (buf)
        pieces.push(buf);
      buf = para;
    } else {
      buf = buf ? `${buf}

${para}` : para;
    }
  }
  if (buf)
    pieces.push(buf);
  return pieces;
}
function embedInputFor(chunk) {
  const stripped = chunk.text.replace(FENCE_RE, " ").replace(/\s+/g, " ").trim();
  const ei = [chunk.headingPath, stripped].filter(Boolean).join("\n").trim();
  return ei || chunk.text.trim();
}
function hashOf(text) {
  return createHash("sha256").update(text).digest("hex");
}

// ../core/dist/store.js
var RRF_K = 60;
var DEFAULT_TOP_K = 10;
var MemoryStore = class {
  db;
  stmts;
  /**
   * Open (or create) a store. Loads sqlite-vec, applies the schema, and
   * compiles the prepared statements for the connection.
   *
   * @param dbPath SQLite file path, or ":memory:" (default) for an ephemeral DB
   */
  constructor(dbPath = ":memory:") {
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
   * @returns the new page version's id and slug
   */
  async put(slug, opts) {
    const { content, sources, epistemic = "fact" } = opts;
    if (!content.trim())
      throw new Error("put: content must not be empty");
    const chunks = chunkMarkdown(content).map((c) => {
      const embedInput = embedInputFor(c);
      return { ...c, embedInput, hash: hashOf(embedInput) };
    });
    const now = Date.now();
    const existing = this.stmts.liveIdBySlug.get({ slug });
    const reuse = /* @__PURE__ */ new Map();
    if (existing) {
      const old = this.stmts.chunksByPage.all({ page_id: existing.id });
      for (const oc of old) {
        if (reuse.has(oc.embed_hash))
          continue;
        const v = this.stmts.readVec.get(BigInt(oc.id));
        if (v?.embedding)
          reuse.set(oc.embed_hash, v.embedding);
      }
    }
    const vectors = /* @__PURE__ */ new Map();
    for (const c of chunks) {
      if (vectors.has(c.hash))
        continue;
      const reused = reuse.get(c.hash);
      vectors.set(c.hash, reused ?? await embed(c.embedInput, DOC_PREFIX));
    }
    const txn = this.db.transaction(() => {
      if (existing) {
        this.stmts.staleLive.run({ slug, now });
        const old = this.stmts.chunksByPage.all({ page_id: existing.id });
        for (const oc of old) {
          this.stmts.deleteFts.run({ rowid: oc.id });
          this.stmts.deleteVec.run(BigInt(oc.id));
        }
        this.stmts.deleteChunksByPage.run({ page_id: existing.id });
      }
      const newPageId = uuidv7();
      this.stmts.insertPage.run({
        id: newPageId,
        slug,
        content,
        epistemic,
        created_at: now,
        last_confirmed_at: now
      });
      if (existing) {
        this.stmts.linkSupersession.run({
          old_id: existing.id,
          new_id: newPageId
        });
      }
      for (const c of chunks) {
        const chunkId = this.stmts.insertChunk.get({
          uuid: uuidv7(),
          page_id: newPageId,
          ordinal: c.ordinal,
          heading_path: c.headingPath,
          text: c.text,
          embed_hash: c.hash
        }).id;
        this.stmts.insertFts.run({ rowid: chunkId, text: c.text });
        this.stmts.insertVec.run(BigInt(chunkId), vectors.get(c.hash));
      }
      if (sources) {
        for (const src of sources) {
          const srcId = this.stmts.upsertSource.get({
            kind: src.kind,
            uri: src.uri,
            title: src.title ?? null,
            now
          }).id;
          this.stmts.insertEvidence.run({
            page_id: newPageId,
            source_id: srcId,
            locator: src.locator ?? null,
            confirmed_at: now
          });
        }
        this.stmts.refreshConfirmedAt.run({ id: newPageId });
      }
      return newPageId;
    });
    const id = txn();
    return { id, slug };
  }
  /**
   * Attach (or re-confirm) a provenance source on an existing page, refreshing
   * its freshness timestamp. Throws if the page id does not exist.
   */
  addEvidence(pageId, source) {
    if (!this.stmts.pageExists.get({ id: pageId })) {
      throw new Error(`addEvidence: page id ${pageId} does not exist`);
    }
    const now = Date.now();
    const txn = this.db.transaction(() => {
      const srcId = this.stmts.upsertSource.get({
        kind: source.kind,
        uri: source.uri,
        title: source.title ?? null,
        now
      }).id;
      this.stmts.insertEvidence.run({
        page_id: pageId,
        source_id: srcId,
        locator: source.locator ?? null,
        confirmed_at: now
      });
      this.stmts.refreshConfirmedAt.run({ id: pageId });
    });
    txn();
  }
  /** Resolve a slug to its current live page (full markdown content). */
  resolveSlug(slug) {
    return this.stmts.resolveLive.get({ slug });
  }
  /**
   * Look up a specific page version by id — live or stale. Unlike
   * {@link resolveSlug}, this can return a superseded version (the page row
   * itself is kept forever; only its chunks are deleted on supersession), so
   * it's the right lookup for ids captured from `put()`, `getHistory()`, or a
   * dump file name.
   */
  getPageById(pageId) {
    return this.stmts.pageById.get({ id: pageId });
  }
  /** The chunks of a page, in order (for inspection / reconstruction). */
  getChunks(pageId) {
    return this.stmts.getChunks.all({ page_id: pageId });
  }
  /**
   * Look up a single chunk by id, with its parent page's metadata attached.
   * Only resolves chunks belonging to the current live page version — a
   * superseded page's chunks are deleted, so their ids stop resolving.
   */
  getChunkById(chunkId) {
    return this.stmts.chunkDetail.get({ id: chunkId });
  }
  /**
   * A chunk and its neighbors within the same (live) page, for context around
   * a single hit. Returns chunks with `ordinal` in
   * `[target.ordinal - radius, target.ordinal + radius]`, ordinal ascending,
   * including the target itself. Returns `[]` if the chunk doesn't resolve
   * (see {@link getChunkById}).
   *
   * @param radius how many chunks before/after to include (default 1)
   */
  getChunkNeighbors(chunkId, radius = 1) {
    const target = this.getChunkById(chunkId);
    if (!target)
      return [];
    return this.stmts.chunksInOrdinalRange.all({
      page_id: target.pageId,
      min_ordinal: Math.max(0, target.ordinal - radius),
      max_ordinal: target.ordinal + radius
    });
  }
  /**
   * Hybrid search over live chunks: FTS5 (keyword) and sqlite-vec (semantic)
   * results fused with Reciprocal Rank Fusion. Returns chunk-level hits.
   *
   * @param topK number of results (≤ 0 returns an empty array)
   */
  async hybridSearch(query, topK = DEFAULT_TOP_K) {
    if (topK <= 0)
      return [];
    const queryEmbedding = await embed(query, QUERY_PREFIX);
    const fetchN = topK * 3;
    const ftsQuery = escapeFtsQuery(query);
    let ftsRows = [];
    if (ftsQuery) {
      try {
        ftsRows = this.stmts.ftsSearch.all({
          query: ftsQuery,
          limit: fetchN
        });
      } catch {
      }
    }
    const vecRows = this.stmts.vecSearch.all(queryEmbedding, fetchN);
    const scores = /* @__PURE__ */ new Map();
    for (let i = 0; i < ftsRows.length; i++) {
      const id = ftsRows[i].rowid;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    }
    for (let i = 0; i < vecRows.length; i++) {
      const id = vecRows[i].rowid;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1));
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);
    const results = [];
    for (const [id, score] of ranked) {
      const row = this.stmts.liveSearchRow.get({ id });
      if (!row)
        continue;
      results.push({ ...row, score });
    }
    return results;
  }
  /** List a page's evidence (sources), most-recently-confirmed first. */
  getEvidence(pageId) {
    return this.stmts.getEvidence.all({ id: pageId });
  }
  /** Version history for a slug, oldest first (the live version is current). */
  getHistory(slug) {
    return this.stmts.getHistory.all({ slug });
  }
  /**
   * Every page version's identity (id, slug, status) with no content —
   * for enumerating all pages (e.g. a bulk dump), sorted by slug then age.
   */
  listPages() {
    return this.stmts.listPages.all();
  }
  /** Close the underlying database connection. */
  close() {
    this.db.close();
  }
};
function escapeFtsQuery(raw) {
  const trimmed = raw.trim();
  if (trimmed.length < 3)
    return "";
  return `"${trimmed.replace(/"/g, '""')}"`;
}

// ../core/dist/ordering.js
function groupSearchResultsByPage(results) {
  const groups = /* @__PURE__ */ new Map();
  for (const r of results) {
    let group = groups.get(r.pageId);
    if (!group) {
      group = { pageId: r.pageId, slug: r.slug, chunks: [] };
      groups.set(r.pageId, group);
    }
    group.chunks.push(r);
  }
  for (const group of groups.values()) {
    group.chunks.sort((a, b) => a.ordinal - b.ordinal);
  }
  return [...groups.values()];
}

// ../core/dist/dump.js
var UNSAFE_FILENAME_CHARS = /[\\:*?"<>|\x00-\x1f]/g;
function sanitizeSlugForFilename(slug) {
  return slug.replace(/\//g, "__").replace(UNSAFE_FILENAME_CHARS, "_");
}
function dumpFileName(slug, id) {
  return `doc-${sanitizeSlugForFilename(slug)}-${id}.md`;
}
function yamlString(value) {
  return JSON.stringify(value);
}
function yamlStringOrNull(value) {
  return value === null ? "null" : yamlString(value);
}
function formatDumpFile(page, evidence) {
  const lines = [
    "---",
    `id: ${yamlString(page.id)}`,
    `slug: ${yamlString(page.slug)}`,
    `status: ${page.status}`,
    `epistemic: ${page.epistemic}`,
    `created_at: ${page.created_at}`,
    `last_confirmed_at: ${page.last_confirmed_at}`,
    `superseded_at: ${page.superseded_at ?? "null"}`,
    `superseded_by: ${yamlStringOrNull(page.superseded_by)}`
  ];
  if (evidence.length === 0) {
    lines.push("evidence: []");
  } else {
    lines.push("evidence:");
    for (const e of evidence) {
      lines.push(`  - kind: ${e.kind}`, `    uri: ${yamlString(e.uri)}`, `    title: ${yamlStringOrNull(e.title)}`, `    locator: ${yamlStringOrNull(e.locator)}`, `    confirmed_at: ${e.confirmedAt}`);
    }
  }
  lines.push("---", "", page.content);
  return lines.join("\n") + "\n";
}

// src/cli.ts
var HELP = `memory-storage \u2014 local hybrid-search / RAG memory for an LLM wiki

A local knowledge store. Each "page" is a Markdown document addressed by a
stable "slug". Pages are chunked and indexed for hybrid search (keyword + vector).
Everything runs locally; nothing leaves the machine.

USAGE
  memory-storage <command> [args] [options]

FOR AGENTS (read this)
  \u2022 Pass --json on every command for stable, machine-readable output on stdout.
    Human/progress text (DB path, model download) only ever goes to stderr.
  \u2022 A page is the unit you author. To UPDATE a page: 'get' its markdown, edit it,
    then 'put' it back under the same slug \u2014 that supersedes the old version.
  \u2022 'put' is idempotent per slug: re-running with the same slug replaces the live
    page (old version is kept as history). Choose a slug that names the concept.
  \u2022 Tag what you write: set --epistemic and attach --source. Use 'fact' only with
    a real source; use 'inference'/'hypothesis' for model-derived claims.
  \u2022 'search' returns CHUNKS (sections), not whole pages. Use the returned slug to
    'get' the full page when you need full context.
  \u2022 Persist to a real file with --db (or env MEMORY_DB). ':memory:' is per-process
    and lost on exit \u2014 do not use it across commands.

COMMANDS
  put <slug>            Create or replace the page at <slug>.
      -c, --content <markdown>            required; the full page body
      -e, --epistemic fact|inference|hypothesis   default: fact
      -s, --source <kind:uri>             provenance; repeatable
      \u2192 prints the new page id (JSON: {"id","slug"})

  search <query>        Hybrid search over live chunks.
      -k, --top-k <n>                     default: 10
      --group-by-page                     group hits by page, sorted into
                                           reading order (ordinal ascending)
                                           within each page, instead of one
                                           flat relevance-ranked list
      \u2192 default: ranked chunks (JSON array): slug, ordinal, headingPath,
        text, epistemic, score, sourceCount, lastConfirmedAt
      \u2192 --group-by-page: JSON array of {pageId, slug, chunks}, chunks in
        reading order. NOTE: ordinal is only comparable within one page
        version \u2014 never compare it across pages or across versions of a slug.

  get <slug> | get --id <pageId>
                        Print a page's full Markdown (for reading/editing).
                        <slug>  \u2192 the current LIVE page.
                        --id    \u2192 that exact version, live OR stale (e.g. an
                                  id from getHistory, a search hit's pageId,
                                  or a dump file name). Mutually exclusive
                                  with <slug>.
  resolve <slug> | resolve --id <pageId>
                        Same targeting as 'get', but prints id/slug/epistemic/
                        status metadata only (no body).
  history <slug>        List every version of the slug (oldest first).
  chunk <chunkId>        Print one chunk (by the integer id from a search hit),
                          with its parent page's metadata.
      --context <n>                       also include \xB1n neighboring chunks
                                           from the same page (default: 0)
      \u2192 only resolves chunks of the CURRENT LIVE page version; a superseded
        page's chunks are gone, so old chunkIds stop resolving.
  evidence <pageId>     List a page's sources.
  add-evidence <pageId> -s <kind:uri> [-s ...]   Attach/refresh sources.

  dump (<slug> | --id <pageId> | --all) --out <dir> [--include-stale]
                        Write page(s) to Markdown files as
                        doc-{slug}-{id}.md, each with a YAML front-matter
                        header (id, slug, status, epistemic, created_at,
                        last_confirmed_at, superseded_at, superseded_by,
                        evidence) followed by the full content. Creates
                        --out if missing. Exactly one of <slug>/--id/--all
                        is required.
                        <slug>          \u2192 that slug's current live page
                        --id <pageId>   \u2192 that exact version (live or stale)
                        --all           \u2192 every page's current live version
                        --include-stale \u2192 with <slug> or --all, also dump
                                          every stale (superseded) version
      \u2192 writing only; there is no re-import command yet. A naive reader that
        scans for the next literal "---" rather than parsing YAML could be
        confused by a "---" inside the page content (e.g. a Markdown rule).

OPTIONS
  -c, --content <text>     page Markdown body (put)
  -e, --epistemic <value>  fact | inference | hypothesis (default: fact)
  -s, --source <spec>      "kind:uri" (repeatable), or a JSON object:
                           '{"kind":"url","uri":"\u2026","title":"\u2026","locator":"\u2026"}'
                           kind \u2208 file | url | conversation | tool | other
  -k, --top-k <n>          number of search results (default: 10)
      --group-by-page      search: group hits by page in reading order
      --context <n>        chunk: include \xB1n neighboring chunks (default: 0)
      --id <pageId>        get/resolve/dump: target a specific version (live
                           or stale) instead of <slug>'s current live page
      --all                dump: every page's current live version
      --include-stale      dump: also include superseded versions
      --out <dir>          dump: output directory (created if missing).
                           Resolved like --db (relative to your current dir).
      --db <path>          SQLite file; default env MEMORY_DB or "memory.db".
                           Relative paths resolve from your current directory.
      --json               machine-readable JSON on stdout
  -h, --help               show this help

EXAMPLES
  # Content is Markdown. In bash/zsh use $'\u2026' so \\n becomes a real newline
  # (plain "\u2026" keeps \\n literal). Calling programmatically? pass real newlines.

  # Author a page with provenance, persisting to a file
  memory-storage put ddd-aggregates \\
    -c $'# Aggregates\\n\\nAn aggregate is a consistency boundary.' \\
    -e fact -s url:https://martinfowler.com/bliki/DDD_Aggregate.html \\
    --db ./memory.db

  # Search (machine-readable), then open the matching page
  memory-storage search "consistency boundary" --json --db ./memory.db
  memory-storage get ddd-aggregates --db ./memory.db

  # Record a model-derived claim, clearly marked
  memory-storage put hunch/cache-key \\
    -c $'# Cache key\\n\\nLikely collides on tenant id.' \\
    -e hypothesis -s conversation:session-2026-06-29 --db ./memory.db

EXIT CODES
  0 success   1 error (message on stderr)

ENVIRONMENT
  MEMORY_DB                SQLite path (overridden by --db)
  MEMORY_MODEL_CACHE       model download dir (default ~/.cache/memory-storage)
  MEMORY_EMBEDDING_MODEL   ONNX repo id (default sirasagi62/ruri-v3-310m-ONNX)
  MEMORY_EMBEDDING_DTYPE   quantization (default q8)
  MEMORY_CHUNK_MAX_CHARS   chunk size budget (default 1200)

The embedding model downloads once on first use (a few hundred MB).
`;
var EPISTEMIC = /* @__PURE__ */ new Set(["fact", "inference", "hypothesis"]);
var SOURCE_KINDS = /* @__PURE__ */ new Set(["file", "url", "conversation", "tool", "other"]);
function fail(msg) {
  process.stderr.write(`error: ${msg}
`);
  process.exit(1);
}
function resolveDbPath(raw) {
  return raw === ":memory:" ? raw : resolveUserPath(raw);
}
function parseSource(spec) {
  const trimmed = spec.trim();
  if (trimmed.startsWith("{")) {
    const obj = JSON.parse(trimmed);
    if (!SOURCE_KINDS.has(obj.kind)) fail(`invalid source kind: ${obj.kind}`);
    return obj;
  }
  const i = trimmed.indexOf(":");
  if (i <= 0) fail(`invalid --source: "${spec}" (expected kind:uri or JSON)`);
  const kind = trimmed.slice(0, i);
  const uri = trimmed.slice(i + 1);
  if (!SOURCE_KINDS.has(kind)) fail(`invalid source kind: "${kind}"`);
  return { kind, uri };
}
function resolvePageArg(command, rest, values, store) {
  const idFlag = values.id;
  const slug = rest[0];
  if (idFlag && slug) {
    fail(`${command}: specify either <slug> or --id, not both`);
  }
  if (!idFlag && !slug) {
    fail(`${command}: missing <slug> (or use --id <pageId>)`);
  }
  return idFlag ? store.getPageById(idFlag) : store.resolveSlug(slug);
}
function installProgressReporter() {
  let announced = false;
  const lastBucket = /* @__PURE__ */ new Map();
  onModelProgress((p) => {
    if (p.status !== "progress" || typeof p.progress !== "number" || !p.file) {
      return;
    }
    if (!announced) {
      process.stderr.write(
        `\u23F3 \u57CB\u3081\u8FBC\u307F\u30E2\u30C7\u30EB\u3092\u30C0\u30A6\u30F3\u30ED\u30FC\u30C9\u4E2D (\u521D\u56DE\u306E\u307F) \u2192 ${MODEL_CACHE_DIR}
`
      );
      announced = true;
    }
    const bucket = Math.min(4, Math.floor(p.progress / 25));
    if (lastBucket.get(p.file) !== bucket) {
      lastBucket.set(p.file, bucket);
      process.stderr.write(`  ${p.file}: ${bucket * 25}%
`);
    }
  });
}
function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        content: { type: "string", short: "c" },
        epistemic: { type: "string", short: "e" },
        source: { type: "string", short: "s", multiple: true },
        "top-k": { type: "string", short: "k" },
        "group-by-page": { type: "boolean" },
        context: { type: "string" },
        id: { type: "string" },
        all: { type: "boolean" },
        "include-stale": { type: "boolean" },
        out: { type: "string" },
        db: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" }
      }
    });
  } catch (err) {
    fail(err.message);
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }
  const dbPath = resolveDbPath(
    values.db ?? process.env.MEMORY_DB ?? "memory.db"
  );
  const asJson = Boolean(values.json);
  process.stderr.write(`DB: ${dbPath}
`);
  const emit = (human, data) => {
    process.stdout.write(asJson ? JSON.stringify(data) + "\n" : human + "\n");
  };
  installProgressReporter();
  const store = new MemoryStore(dbPath);
  return (async () => {
    switch (command) {
      case "put": {
        const slug = rest[0];
        if (!slug) fail("put: missing <slug>");
        const content = values.content;
        if (!content) fail("put: missing --content");
        const epistemic = values.epistemic ?? "fact";
        if (!EPISTEMIC.has(epistemic)) fail(`put: invalid --epistemic "${epistemic}"`);
        const sources = (values.source ?? []).map(parseSource);
        const result = await store.put(slug, {
          content,
          epistemic,
          sources: sources.length ? sources : void 0
        });
        emit(`put ok: id=${result.id} slug=${result.slug}`, result);
        break;
      }
      case "search": {
        const query = rest.join(" ").trim();
        if (!query) fail("search: missing <query>");
        const topK = values["top-k"] ? Number(values["top-k"]) : 10;
        const results = await store.hybridSearch(query, topK);
        if (values["group-by-page"]) {
          const groups = groupSearchResultsByPage(results);
          emit(
            groups.map(
              (g) => `## ${g.slug}
` + g.chunks.map(
                (c) => `  #${c.ordinal}${c.headingPath ? ` (${c.headingPath})` : ""} [${c.score.toFixed(4)}]
    ${c.text}`
              ).join("\n")
            ).join("\n\n") || "(no results)",
            groups
          );
          break;
        }
        emit(
          results.map(
            (r) => `[${r.score.toFixed(4)}] ${r.slug}#${r.ordinal}${r.headingPath ? ` (${r.headingPath})` : ""} [${r.epistemic}, \u51FA\u5178${r.sourceCount}\u4EF6]
  ${r.text}`
          ).join("\n\n") || "(no results)",
          results
        );
        break;
      }
      case "get": {
        const row = resolvePageArg("get", rest, values, store);
        emit(row ? row.content : "(not found)", row ?? null);
        break;
      }
      case "resolve": {
        const row = resolvePageArg("resolve", rest, values, store);
        emit(
          row ? `id=${row.id} slug=${row.slug} epistemic=${row.epistemic} status=${row.status}` : "(not found)",
          row ?? null
        );
        break;
      }
      case "history": {
        const slug = rest[0];
        if (!slug) fail("history: missing <slug>");
        const rows = store.getHistory(slug);
        emit(
          rows.map(
            (h) => `id=${h.id} status=${h.status} superseded_by=${h.superseded_by ?? "-"}`
          ).join("\n") || "(no history)",
          rows
        );
        break;
      }
      case "chunk": {
        const chunkIdRaw = rest[0];
        const chunkId = Number(chunkIdRaw);
        if (!chunkIdRaw || !Number.isInteger(chunkId)) {
          fail("chunk: <chunkId> must be an integer");
        }
        const context = values.context ? Number(values.context) : 0;
        if (!Number.isInteger(context) || context < 0) {
          fail("chunk: --context must be a non-negative integer");
        }
        const chunks = context > 0 ? store.getChunkNeighbors(chunkId, context) : (() => {
          const detail = store.getChunkById(chunkId);
          return detail ? [detail] : [];
        })();
        emit(
          chunks.length ? chunks.map(
            (c) => `${c.chunkId === chunkId ? "\u2192 " : "  "}#${c.ordinal}${c.headingPath ? ` (${c.headingPath})` : ""} [${c.slug}, ${c.epistemic}]
    ${c.text}`
          ).join("\n\n") : "(not found \u2014 chunk id must belong to the current live page version)",
          chunks
        );
        break;
      }
      case "dump": {
        const idFlag = values.id;
        const allFlag = Boolean(values.all);
        const slug = rest[0];
        const includeStale = Boolean(values["include-stale"]);
        const outRaw = values.out;
        const selectorCount = [Boolean(idFlag), allFlag, Boolean(slug)].filter(
          Boolean
        ).length;
        if (selectorCount !== 1) {
          fail("dump: specify exactly one of <slug>, --id <pageId>, or --all");
        }
        if (!outRaw) fail("dump: missing --out <dir>");
        const outDir = resolveUserPath(outRaw);
        const targets = [];
        if (idFlag) {
          const p = store.getPageById(idFlag);
          if (!p) fail(`dump: no such page id: ${idFlag}`);
          targets.push(p);
        } else if (slug) {
          const live = store.resolveSlug(slug);
          if (!live) fail(`dump: no such slug: ${slug}`);
          targets.push(live);
          if (includeStale) {
            for (const h of store.getHistory(slug)) {
              if (h.status !== "stale") continue;
              const p = store.getPageById(h.id);
              if (p) targets.push(p);
            }
          }
        } else {
          const summaries = store.listPages().filter((p) => includeStale || p.status === "live");
          for (const s of summaries) {
            const p = store.getPageById(s.id);
            if (p) targets.push(p);
          }
        }
        fs2.mkdirSync(outDir, { recursive: true });
        const written = targets.map((p) => {
          const filePath = path2.join(outDir, dumpFileName(p.slug, p.id));
          fs2.writeFileSync(filePath, formatDumpFile(p, store.getEvidence(p.id)));
          return { id: p.id, slug: p.slug, status: p.status, path: filePath };
        });
        emit(
          written.length ? written.map((w) => w.path).join("\n") : "(nothing to dump)",
          written
        );
        break;
      }
      case "evidence": {
        const id = rest[0];
        if (!id) fail("evidence: missing <pageId>");
        const rows = store.getEvidence(id);
        emit(
          rows.map((e) => `${e.kind}: ${e.uri}${e.title ? ` (${e.title})` : ""}`).join("\n") || "(no evidence)",
          rows
        );
        break;
      }
      case "add-evidence": {
        const id = rest[0];
        if (!id) fail("add-evidence: missing <pageId>");
        const specs = values.source ?? [];
        if (!specs.length) fail("add-evidence: at least one --source is required");
        for (const spec of specs) store.addEvidence(id, parseSource(spec));
        emit(`add-evidence ok: id=${id} (+${specs.length})`, {
          id,
          added: specs.length
        });
        break;
      }
      default:
        store.close();
        fail(`unknown command: "${command}" (try --help)`);
    }
    store.close();
  })();
}
Promise.resolve(main()).catch((err) => {
  process.stderr.write(`${err.stack ?? err}
`);
  process.exit(1);
});
/*! Bundled license information:

uuidv7/dist/index.js:
  (**
   * uuidv7: A JavaScript implementation of UUID version 7
   *
   * Copyright 2021-2026 LiosK
   *
   * @license Apache-2.0
   * @packageDocumentation
   *)
*/
