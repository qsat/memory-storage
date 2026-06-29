# memory-storage

完全ローカルで動く LLM（Ollama 想定）向けの長期記憶 / RAG レイヤ。外部流出なし。
キーワード検索とベクトル検索を融合したハイブリッド検索を、SQLite だけで完結させます。

## 特徴

- **ハイブリッド検索** — FTS5（trigram キーワード）と sqlite-vec（ベクトル意味検索）を
  RRF（Reciprocal Rank Fusion, k=60）で順位融合。キーワード一致と意味的近さの両方をカバー。
- **slug ベースの版管理** — 概念は不変ハンドル `slug` で参照し、更新すると旧版を `stale` にして
  `superseded_by` で後継を指す（supersession）。時間経過で薄れる decay / 忘却曲線は実装しない。
- **provenance（出典追跡）** — `source` / `evidence` の多対多リンク。鮮度は `last_confirmed_at`
  と明示的な再確認で表現。
- **epistemic status** — `fact` / `inference` / `hypothesis` を区別。
- **埋め込み** — Ruri v3 310m（ONNX / Transformers.js, 768 次元, q8）。完全ローカル。

設計の背景（なぜその判断に至ったか）は設計メモ、運用上のガードレールは
[`.claude/skills/local-hybrid-search/SKILL.md`](.claude/skills/local-hybrid-search/SKILL.md)
を参照してください。

## 構成（npm workspace monorepo）

```
packages/
├─ core/     memory-storage ライブラリ本体
│  └─ src/local_hybrid_search.ts
└─ check/    実埋め込みモデルでの動作チェックツール（memory-storage-check）
   └─ src/check.ts
```

ルートは private なワークスペースルートで、`build` / `test` / `typecheck` を各ワークスペースに
委譲します。`check` はライブラリをパッケージ名 `memory-storage` で import します。

## 必要環境

- Node.js 20 以上（`better-sqlite3` のネイティブビルドにビルドツールが必要）
- SQLite 3.35 以上（`RETURNING` を使用）
- 依存: `better-sqlite3` / `sqlite-vec` / `@huggingface/transformers`

## セットアップ

```bash
npm install   # ワークスペース全体を一括インストール（初回のみ）
```

## 起動・動作確認

### 1. ユニットテスト（オフライン・推奨）

embedder をモックしているため、モデルのダウンロードもネット接続も不要です。

```bash
npm test            # vitest run（全テスト）
npm run typecheck   # 全ワークスペースの型チェック
```

### 2. 実データでの動作確認（`check` パッケージ）

実際の Ruri v3 埋め込みモデルを使い、`put → hybridSearch → supersede → 履歴/出典` の
一連の流れを実行します。**初回のみ HuggingFace からモデルをダウンロード**するため、
ネット接続と数百 MB のディスクが必要です。

```bash
npm run check                 # メモリ上の DB で実行
npm run check -- ./memory.db  # ファイルに永続化（後で中身を確認できる）
```

#### 埋め込みモデルについて（重要）

transformers.js は **ONNX 形式**のモデルが必要です。Ruri v3 の公式リポジトリ
（`cl-nagoya/ruri-v3-310m`）は PyTorch 版のため、デフォルトではコミュニティの ONNX 変換
（`sirasagi62/ruri-v3-310m-ONNX`）を使用します。環境に合わせて環境変数で差し替えられます。

```bash
# 別の ONNX リポジトリ / 量子化を使う
MEMORY_EMBEDDING_MODEL=keitokei1994/ruri-v3-310m-onnx \
MEMORY_EMBEDDING_DTYPE=fp32 \
npm run check
```

| 環境変数 | 既定値 | 説明 |
|---|---|---|
| `MEMORY_EMBEDDING_MODEL` | `sirasagi62/ruri-v3-310m-ONNX` | HuggingFace の ONNX リポジトリ ID |
| `MEMORY_EMBEDDING_DTYPE` | `q8` | 量子化（`fp32` / `fp16` / `q8` など。repo に存在するもの） |

> 出力次元は 768 に固定です（全ベクトルに焼き付くため）。モデルを変える場合も 768 次元のものを
> 選び、既存データがあるときは全件 re-embed が必要です（[SKILL.md](.claude/skills/local-hybrid-search/SKILL.md) のガードレール参照）。

### 3. ビルド（配布用 dist の生成・任意）

```bash
npm run build   # packages/core/dist に JS と型定義を出力
```

## 使い方

```ts
import { MemoryStore } from "memory-storage";

const store = new MemoryStore("./memory.db"); // 省略時は ":memory:"

// 知識を登録（同じ slug への再登録は旧版を stale にして置き換え）
const id = await store.put("typescript", {
  content: "TypeScript は JavaScript に静的型付けを加えた言語。",
  epistemic: "fact",
  sources: [{ kind: "url", uri: "https://www.typescriptlang.org/", title: "TS 公式" }],
});

// ハイブリッド検索（live のみ。score / sourceCount / lastConfirmedAt 付き）
const results = await store.hybridSearch("型システムを持つ言語", 5);

// slug を最新 live に解決（Wiki リンク解決相当）
const live = store.resolveSlug("typescript");

// 出典の追加・再裏付け（鮮度も更新）
store.addEvidence(id, { kind: "url", uri: "https://example.com/proof" });

// 出典一覧・版履歴
const evidence = store.getEvidence(id);
const history = store.getHistory("typescript");

store.close();
```

## 公開 API

| 関数 | 役割 |
|---|---|
| `put(slug, { content, sources?, epistemic? })` | 新規 or 置換（Wiki 編集相当）。版 id を返す |
| `addEvidence(knowledgeId, source)` | 出典追加 / 再裏付け（強化）。鮮度も更新 |
| `resolveSlug(slug)` | 最新 live を返す（Wiki リンク解決） |
| `hybridSearch(query, topK?)` | live のみ。`slug` / `sourceCount` / `lastConfirmedAt` 付き |
| `getEvidence(knowledgeId)` | 出典一覧 |
| `getHistory(slug)` | 版履歴（古い順、live が現行） |

## CI

`.github/workflows/test.yml` が pull request 時に Node 20.x / 22.x のマトリクスで
型チェックとテストを実行します（モデル DL 不要のオフライン構成）。
