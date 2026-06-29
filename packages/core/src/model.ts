/**
 * Embedding model resolution: where the model is cached, how it is loaded, and
 * how text is turned into vectors. Everything that touches transformers.js or
 * the on-disk model cache lives here.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  pipeline,
  env as transformersEnv,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import type { ModelProgress } from "./types.js";

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

/** HuggingFace ONNX repo id for the embedding model (override via env). */
export const EMBEDDING_MODEL =
  process.env.MEMORY_EMBEDDING_MODEL ?? "sirasagi62/ruri-v3-310m-ONNX";

/** Output dimension — baked into every stored vector and the vec0 schema. */
export const EMBEDDING_DIM = 768;

const EMBEDDING_DTYPE = (process.env.MEMORY_EMBEDDING_DTYPE ??
  "q8") as EmbeddingDtype;

/** Ruri requires these prefixes on documents and queries respectively. */
export const DOC_PREFIX = "検索文書: ";
export const QUERY_PREFIX = "検索クエリ: ";

// ---------------------------------------------------------------------------
// Path / cache location
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
export function ensureModelCacheDir(): void {
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

/** Lazily load (and cache) the embedding pipeline as a process singleton. */
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

/**
 * Embed a single text into a normalized vector, returned as a raw little-endian
 * Float32 buffer ready to hand to sqlite-vec.
 *
 * @param text   the text to embed
 * @param prefix Ruri prefix ({@link DOC_PREFIX} or {@link QUERY_PREFIX})
 */
export async function embed(text: string, prefix: string): Promise<Buffer> {
  const embedder = await getEmbedder();
  const output = await embedder(`${prefix}${text}`, {
    pooling: "mean",
    normalize: true,
  });
  const f32 = new Float32Array(output.tolist()[0] as number[]);
  return Buffer.from(f32.buffer);
}
