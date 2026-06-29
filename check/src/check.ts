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
 */
import { MemoryStore } from "../../src/local_hybrid_search.js";

const dbPath = process.argv[2] ?? ":memory:";

function hr(label: string): void {
  console.log(`\n=== ${label} ===`);
}

async function main(): Promise<void> {
  console.log(`DB: ${dbPath}`);
  console.log("Loading embedding model (first run downloads it)...");

  const store = new MemoryStore(dbPath);

  hr("put: 知識を登録");
  await store.put("typescript", {
    content: "TypeScript は JavaScript に静的型付けを加えた言語で、大規模開発に向く。",
    epistemic: "fact",
    sources: [
      { kind: "url", uri: "https://www.typescriptlang.org/", title: "TS 公式" },
    ],
  });
  await store.put("rust", {
    content: "Rust はメモリ安全性を所有権システムで保証するシステムプログラミング言語。",
    epistemic: "fact",
    sources: [{ kind: "url", uri: "https://www.rust-lang.org/" }],
  });
  await store.put("python", {
    content: "Python はデータ分析や機械学習で広く使われる動的型付け言語。",
    epistemic: "fact",
  });
  console.log("3 件登録しました (typescript / rust / python)");

  hr("hybridSearch: 「型システムを持つ言語」");
  const results = await store.hybridSearch("型システムを持つ言語", 3);
  for (const r of results) {
    console.log(
      `  [${r.score.toFixed(4)}] ${r.slug} (${r.epistemic}, 出典${r.sourceCount}件)\n` +
        `      ${r.content}`
    );
  }

  hr("supersede: typescript を更新");
  await store.put("typescript", {
    content:
      "TypeScript は JavaScript のスーパーセットで、型推論とエディタ支援に優れる。",
    epistemic: "fact",
    sources: [
      { kind: "url", uri: "https://www.typescriptlang.org/", title: "TS 公式" },
    ],
  });
  const live = store.resolveSlug("typescript");
  console.log(`現行 live (id=${live?.id}): ${live?.content}`);

  hr("getHistory: typescript の版履歴");
  for (const h of store.getHistory("typescript")) {
    console.log(
      `  id=${h.id} status=${h.status} superseded_by=${h.superseded_by ?? "-"}`
    );
  }

  hr("getEvidence: typescript の出典");
  if (live) {
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
