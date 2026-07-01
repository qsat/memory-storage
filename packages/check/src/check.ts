/**
 * Manual smoke check for the memory-storage layer.
 *
 * Unlike the unit tests (which mock the embedder), this script loads the real
 * Ruri v3 embedding model and exercises the full put -> search -> supersede
 * flow. The model is downloaded from HuggingFace on first run, so this needs
 * network access once and a few hundred MB of disk.
 *
 *   npm run check                 # in-memory DB
 *   npm run check -- ./memory.db  # persist to a file you can inspect
 *
 * transformers.js needs an ONNX build of the model. Override the repo/quant
 * if the default does not work in your environment:
 *
 *   MEMORY_EMBEDDING_MODEL=<onnx-repo> MEMORY_EMBEDDING_DTYPE=fp32 npm run check
 */
import {
  MemoryStore,
  onModelProgress,
  MODEL_CACHE_DIR,
  type ModelProgress,
} from "memory-storage";

const dbPath = process.argv[2] ?? ":memory:";

/** Section header. */
function hr(label: string): void {
  console.log(`\n=== ${label} ===`);
}

/** Log the API method that is about to run. */
function call(signature: string): void {
  console.log(`→ ${signature}`);
}

async function main(): Promise<void> {
  console.log(`DB: ${dbPath}`);
  console.log(
    `Model: ${process.env.MEMORY_EMBEDDING_MODEL ?? "(default ONNX repo)"}` +
      ` / dtype: ${process.env.MEMORY_EMBEDDING_DTYPE ?? "q8"}`
  );
  console.log(`Cache: ${MODEL_CACHE_DIR}`);
  console.log("Loading embedding model (first run downloads it)...");

  // Files download concurrently; emit one line per file at 25% milestones.
  let downloading = false;
  const lastBucket = new Map<string, number>();
  onModelProgress((p: ModelProgress) => {
    if (p.status !== "progress" || typeof p.progress !== "number" || !p.file) {
      return;
    }
    if (!downloading) {
      console.log("⏳ モデルをダウンロード中 (初回のみ)...");
      downloading = true;
    }
    const bucket = Math.min(4, Math.floor(p.progress / 25));
    if (lastBucket.get(p.file) !== bucket) {
      lastBucket.set(p.file, bucket);
      process.stderr.write(`  ${p.file}: ${bucket * 25}%\n`);
    }
  });

  const store = new MemoryStore(dbPath);

  const tsPage = `# TypeScript

TypeScript は JavaScript に静的型付けを加えた言語で、大規模開発に向く。

## 型システム

構造的部分型と型推論を備え、エディタ支援が強力。

## エコシステム

\`\`\`mermaid
graph TD; TS-->JS; TS-->DTS
\`\`\`

npm と相互運用でき、型定義 (.d.ts) で既存 JS を活用できる。`;

  hr("put — Markdown ページを登録（複数セクション）");
  call('store.put("typescript", { content: <markdown>, sources:[url] })');
  const ts = await store.put("typescript", {
    content: tsPage,
    epistemic: "fact",
    sources: [
      { kind: "url", uri: "https://www.typescriptlang.org/", title: "TS 公式" },
    ],
  });
  console.log(`  → id=${ts.id} slug=${ts.slug}`);
  call('store.put("rust", { ... })');
  await store.put("rust", {
    content:
      "# Rust\n\nRust はメモリ安全性を所有権システムで保証するシステムプログラミング言語。",
    epistemic: "fact",
    sources: [{ kind: "url", uri: "https://www.rust-lang.org/" }],
  });

  hr("getChunks — ページがどう分割されたか");
  call(`store.getChunks("${ts.id}")`);
  for (const c of store.getChunks(ts.id)) {
    console.log(`  #${c.ordinal} [${c.headingPath ?? "-"}] ${c.text.slice(0, 40)}...`);
  }

  hr("hybridSearch — 「型推論」（チャンク粒度で返る）");
  call('store.hybridSearch("型推論", 3)');
  const results = await store.hybridSearch("型推論", 3);
  for (const r of results) {
    console.log(
      `  [${r.score.toFixed(4)}] ${r.slug}#${r.ordinal} (${r.headingPath ?? "-"}, 出典${r.sourceCount}件)\n` +
        `      ${r.text.slice(0, 60)}`
    );
  }

  hr("supersede（put による置換、未変更チャンクは embedding 再利用）");
  call('store.put("typescript", { content: <1セクションだけ変更> })');
  await store.put("typescript", {
    content: tsPage.replace("エディタ支援が強力。", "エディタ支援が非常に強力。"),
    epistemic: "fact",
    sources: [
      { kind: "url", uri: "https://www.typescriptlang.org/", title: "TS 公式" },
    ],
  });
  call('store.resolveSlug("typescript")');
  const live = store.resolveSlug("typescript");
  console.log(`現行 live (id=${live?.id}, ${live?.content.length}文字)`);

  hr("getHistory — typescript の版履歴");
  call('store.getHistory("typescript")');
  for (const h of store.getHistory("typescript")) {
    console.log(
      `  id=${h.id} status=${h.status} superseded_by=${h.superseded_by ?? "-"}`
    );
  }

  hr("getEvidence — typescript の出典");
  if (live) {
    call(`store.getEvidence(${live.id})`);
    for (const e of store.getEvidence(live.id)) {
      console.log(`  ${e.kind}: ${e.uri}${e.title ? ` (${e.title})` : ""}`);
    }
  }

  store.close();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
