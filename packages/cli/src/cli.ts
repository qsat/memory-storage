#!/usr/bin/env node
/**
 * Command-line interface for the memory-storage layer.
 *
 * Writes are expected to come from an agent: each subcommand is an explicit,
 * auditable write gate (see the guardrails in SKILL.md). Use --json for
 * machine-readable output.
 *
 *   memory put <slug> -c "<content>" [-e fact|inference|hypothesis] [-s kind:uri ...]
 *   memory search "<query>" [-k 10]
 *   memory resolve <slug>
 *   memory history <slug>
 *   memory evidence <knowledgeId>
 *   memory add-evidence <knowledgeId> -s kind:uri [-s ...]
 *
 * Global: --db <path> (or env MEMORY_DB, default "memory.db"), --json, --help
 */
import { parseArgs } from "node:util";
import {
  MemoryStore,
  onModelProgress,
  resolveUserPath,
  MODEL_CACHE_DIR,
  type SourceInput,
  type ModelProgress,
} from "memory-storage";

const HELP = `memory — local hybrid-search / RAG memory CLI

Usage:
  memory put <slug> -c <content> [-e <epistemic>] [-s <kind:uri> ...]
  memory search <query> [-k <topK>]
  memory resolve <slug>
  memory history <slug>
  memory evidence <knowledgeId>
  memory add-evidence <knowledgeId> -s <kind:uri> [-s ...]

Options:
  -c, --content <text>       knowledge body (put)
  -e, --epistemic <value>    fact | inference | hypothesis (default: fact)
  -s, --source <kind:uri>    source spec; repeatable. Also accepts JSON:
                             '{"kind":"url","uri":"...","title":"...","locator":"..."}'
  -k, --top-k <n>            number of search results (default: 10)
      --db <path>            SQLite file (default: env MEMORY_DB or "memory.db")
      --json                 machine-readable JSON output
  -h, --help                 show this help

Embedding model (transformers.js, ONNX) is overridable via env:
  MEMORY_EMBEDDING_MODEL, MEMORY_EMBEDDING_DTYPE
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
        const id = await store.put(slug, {
          content,
          epistemic: epistemic as "fact" | "inference" | "hypothesis",
          sources: sources.length ? sources : undefined,
        });
        emit(`put ok: id=${id} slug=${slug}`, { id, slug });
        break;
      }

      case "search": {
        const query = rest.join(" ").trim();
        if (!query) fail("search: missing <query>");
        const topK = values["top-k"] ? Number(values["top-k"]) : 10;
        const results = await store.hybridSearch(query, topK);
        emit(
          results
            .map(
              (r) =>
                `[${r.score.toFixed(4)}] ${r.slug} (${r.epistemic}, 出典${r.sourceCount}件)\n  ${r.content}`
            )
            .join("\n") || "(no results)",
          results
        );
        break;
      }

      case "resolve": {
        const slug = rest[0];
        if (!slug) fail("resolve: missing <slug>");
        const row = store.resolveSlug(slug);
        emit(row ? `id=${row.id} ${row.content}` : "(not found)", row ?? null);
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
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) fail("evidence: <knowledgeId> must be an integer");
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
        const id = Number(rest[0]);
        if (!Number.isInteger(id)) fail("add-evidence: <knowledgeId> must be an integer");
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
