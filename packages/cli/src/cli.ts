#!/usr/bin/env node
/**
 * Command-line interface for the memory-storage layer.
 *
 * Writes are expected to come from an agent: each subcommand is an explicit,
 * auditable write gate (see the guardrails in SKILL.md). Use --json for
 * machine-readable output.
 *
 *   memory-storage put <slug> -c "<content>" [-e fact|inference|hypothesis] [-s kind:uri ...]
 *   memory-storage search "<query>" [-k 10]
 *   memory-storage get <slug>
 *   memory-storage resolve <slug>
 *   memory-storage history <slug>
 *   memory-storage evidence <pageId>
 *   memory-storage add-evidence <pageId> -s kind:uri [-s ...]
 *
 * Global: --db <path> (or env MEMORY_DB, default "memory.db"), --json, --help
 */
import { parseArgs } from "node:util";
import {
  MemoryStore,
  onModelProgress,
  resolveUserPath,
  groupSearchResultsByPage,
  MODEL_CACHE_DIR,
  type SourceInput,
  type ModelProgress,
} from "memory-storage";

const HELP = `memory-storage — local hybrid-search / RAG memory for an LLM wiki

A local knowledge store. Each "page" is a Markdown document addressed by a
stable "slug". Pages are chunked and indexed for hybrid search (keyword + vector).
Everything runs locally; nothing leaves the machine.

USAGE
  memory-storage <command> [args] [options]

FOR AGENTS (read this)
  • Pass --json on every command for stable, machine-readable output on stdout.
    Human/progress text (DB path, model download) only ever goes to stderr.
  • A page is the unit you author. To UPDATE a page: 'get' its markdown, edit it,
    then 'put' it back under the same slug — that supersedes the old version.
  • 'put' is idempotent per slug: re-running with the same slug replaces the live
    page (old version is kept as history). Choose a slug that names the concept.
  • Tag what you write: set --epistemic and attach --source. Use 'fact' only with
    a real source; use 'inference'/'hypothesis' for model-derived claims.
  • 'search' returns CHUNKS (sections), not whole pages. Use the returned slug to
    'get' the full page when you need full context.
  • Persist to a real file with --db (or env MEMORY_DB). ':memory:' is per-process
    and lost on exit — do not use it across commands.

COMMANDS
  put <slug>            Create or replace the page at <slug>.
      -c, --content <markdown>            required; the full page body
      -e, --epistemic fact|inference|hypothesis   default: fact
      -s, --source <kind:uri>             provenance; repeatable
      → prints the new page id (JSON: {"id","slug"})

  search <query>        Hybrid search over live chunks.
      -k, --top-k <n>                     default: 10
      --group-by-page                     group hits by page, sorted into
                                           reading order (ordinal ascending)
                                           within each page, instead of one
                                           flat relevance-ranked list
      → default: ranked chunks (JSON array): slug, ordinal, headingPath,
        text, epistemic, score, sourceCount, lastConfirmedAt
      → --group-by-page: JSON array of {pageId, slug, chunks}, chunks in
        reading order. NOTE: ordinal is only comparable within one page
        version — never compare it across pages or across versions of a slug.

  get <slug>            Print the live page's full Markdown (for reading/editing).
  resolve <slug>        Print the live page's id + metadata (no body).
  history <slug>        List every version of the slug (oldest first).
  evidence <pageId>     List a page's sources.
  add-evidence <pageId> -s <kind:uri> [-s ...]   Attach/refresh sources.

OPTIONS
  -c, --content <text>     page Markdown body (put)
  -e, --epistemic <value>  fact | inference | hypothesis (default: fact)
  -s, --source <spec>      "kind:uri" (repeatable), or a JSON object:
                           '{"kind":"url","uri":"…","title":"…","locator":"…"}'
                           kind ∈ file | url | conversation | tool | other
  -k, --top-k <n>          number of search results (default: 10)
      --group-by-page      search: group hits by page in reading order
      --db <path>          SQLite file; default env MEMORY_DB or "memory.db".
                           Relative paths resolve from your current directory.
      --json               machine-readable JSON on stdout
  -h, --help               show this help

EXAMPLES
  # Content is Markdown. In bash/zsh use $'…' so \\n becomes a real newline
  # (plain "…" keeps \\n literal). Calling programmatically? pass real newlines.

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

const EPISTEMIC = new Set(["fact", "inference", "hypothesis"]);
const SOURCE_KINDS = new Set(["file", "url", "conversation", "tool", "other"]);

function fail(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

/** Resolve the --db path (relative to the invocation dir); keep ":memory:". */
function resolveDbPath(raw: string): string {
  return raw === ":memory:" ? raw : resolveUserPath(raw);
}

/** Parse a --source value: "kind:uri" shorthand or a JSON object. */
function parseSource(spec: string): SourceInput {
  const trimmed = spec.trim();
  if (trimmed.startsWith("{")) {
    const obj = JSON.parse(trimmed) as SourceInput;
    if (!SOURCE_KINDS.has(obj.kind)) fail(`invalid source kind: ${obj.kind}`);
    return obj;
  }
  const i = trimmed.indexOf(":");
  if (i <= 0) fail(`invalid --source: "${spec}" (expected kind:uri or JSON)`);
  const kind = trimmed.slice(0, i);
  const uri = trimmed.slice(i + 1);
  if (!SOURCE_KINDS.has(kind)) fail(`invalid source kind: "${kind}"`);
  return { kind: kind as SourceInput["kind"], uri };
}

/**
 * Print model download progress to stderr (keeps stdout clean for --json).
 * Files download concurrently, so we emit one line per file at 25% milestones
 * instead of overwriting a single line (which garbles with parallel downloads).
 */
function installProgressReporter(): void {
  let announced = false;
  const lastBucket = new Map<string, number>(); // file -> last 25%-bucket shown
  onModelProgress((p: ModelProgress) => {
    if (p.status !== "progress" || typeof p.progress !== "number" || !p.file) {
      return;
    }
    if (!announced) {
      process.stderr.write(
        `⏳ 埋め込みモデルをダウンロード中 (初回のみ) → ${MODEL_CACHE_DIR}\n`
      );
      announced = true;
    }
    const bucket = Math.min(4, Math.floor(p.progress / 25)); // 0,25,50,75,100
    if (lastBucket.get(p.file) !== bucket) {
      lastBucket.set(p.file, bucket);
      process.stderr.write(`  ${p.file}: ${bucket * 25}%\n`);
    }
  });
}

function main(): Promise<void> | void {
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
        db: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail((err as Error).message);
  }

  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }

  const dbPath = resolveDbPath(
    (values.db as string) ?? process.env.MEMORY_DB ?? "memory.db"
  );
  const asJson = Boolean(values.json);
  process.stderr.write(`DB: ${dbPath}\n`); // stderr keeps --json stdout clean

  const emit = (human: string, data: unknown): void => {
    process.stdout.write(asJson ? JSON.stringify(data) + "\n" : human + "\n");
  };

  installProgressReporter();
  const store = new MemoryStore(dbPath);

  return (async () => {
    switch (command) {
      case "put": {
        const slug = rest[0];
        if (!slug) fail("put: missing <slug>");
        const content = values.content as string | undefined;
        if (!content) fail("put: missing --content");
        const epistemic = (values.epistemic as string | undefined) ?? "fact";
        if (!EPISTEMIC.has(epistemic)) fail(`put: invalid --epistemic "${epistemic}"`);
        const sources = ((values.source as string[]) ?? []).map(parseSource);
        const result = await store.put(slug, {
          content,
          epistemic: epistemic as "fact" | "inference" | "hypothesis",
          sources: sources.length ? sources : undefined,
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
          // Reading order within each page, not relevance order. ordinal is
          // only meaningful within one page version — never compare it
          // across pages or across versions of the same slug.
          const groups = groupSearchResultsByPage(results);
          emit(
            groups
              .map(
                (g) =>
                  `## ${g.slug}\n` +
                  g.chunks
                    .map(
                      (c) =>
                        `  #${c.ordinal}${c.headingPath ? ` (${c.headingPath})` : ""} [${c.score.toFixed(4)}]\n    ${c.text}`
                    )
                    .join("\n")
              )
              .join("\n\n") || "(no results)",
            groups
          );
          break;
        }

        emit(
          results
            .map(
              (r) =>
                `[${r.score.toFixed(4)}] ${r.slug}#${r.ordinal}` +
                `${r.headingPath ? ` (${r.headingPath})` : ""}` +
                ` [${r.epistemic}, 出典${r.sourceCount}件]\n  ${r.text}`
            )
            .join("\n\n") || "(no results)",
          results
        );
        break;
      }

      case "get": {
        const slug = rest[0];
        if (!slug) fail("get: missing <slug>");
        const row = store.resolveSlug(slug);
        emit(row ? row.content : "(not found)", row ?? null);
        break;
      }

      case "resolve": {
        const slug = rest[0];
        if (!slug) fail("resolve: missing <slug>");
        const row = store.resolveSlug(slug);
        emit(
          row
            ? `id=${row.id} slug=${row.slug} epistemic=${row.epistemic} status=${row.status}`
            : "(not found)",
          row ?? null
        );
        break;
      }

      case "history": {
        const slug = rest[0];
        if (!slug) fail("history: missing <slug>");
        const rows = store.getHistory(slug);
        emit(
          rows
            .map(
              (h) =>
                `id=${h.id} status=${h.status} superseded_by=${h.superseded_by ?? "-"}`
            )
            .join("\n") || "(no history)",
          rows
        );
        break;
      }

      case "evidence": {
        const id = rest[0];
        if (!id) fail("evidence: missing <pageId>");
        const rows = store.getEvidence(id);
        emit(
          rows
            .map((e) => `${e.kind}: ${e.uri}${e.title ? ` (${e.title})` : ""}`)
            .join("\n") || "(no evidence)",
          rows
        );
        break;
      }

      case "add-evidence": {
        const id = rest[0];
        if (!id) fail("add-evidence: missing <pageId>");
        const specs = (values.source as string[]) ?? [];
        if (!specs.length) fail("add-evidence: at least one --source is required");
        for (const spec of specs) store.addEvidence(id, parseSource(spec));
        emit(`add-evidence ok: id=${id} (+${specs.length})`, {
          id,
          added: specs.length,
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
  process.stderr.write(`${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
