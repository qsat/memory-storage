# memory-storage

完全ローカルで動く LLM（Ollama 想定）向けの長期記憶 / RAG レイヤ。外部流出なし。
キーワード検索とベクトル検索を融合したハイブリッド検索を、SQLite だけで完結させます。

## 特徴

- **ページ＋チャンク構成** — agent が書いた Markdown ページ（`page.content` が唯一の真実、slug で参照）を
  見出し＋文字数で**チャンク分割**して索引化。大きな wiki（数千行・Mermaid 入り）でも、検索は
  セクション粒度で精度を保つ。チャンクは導出索引で、ページから常に再生成できる。
- **ハイブリッド検索** — FTS5（trigram キーワード）と sqlite-vec（ベクトル意味検索）を
  RRF（Reciprocal Rank Fusion, k=60）で**チャンク単位**に順位融合。結果は該当セクションを返す。
- **slug ベースの版管理** — ページを不変ハンドル `slug` で参照し、更新すると旧版を `stale` にして
  `superseded_by` で後継を指す（supersession）。decay / 忘却曲線は実装しない。
- **embedding 再利用** — 更新時、内容ハッシュが一致する未変更チャンクは旧版のベクトルを再利用し、
  **変更されたチャンクだけ再 embed**。2000 行ページの 1 節編集でも安い。
- **provenance（出典追跡）** — `source` / `evidence` の多対多リンク（ページ単位）。鮮度は
  `last_confirmed_at` と明示的な再確認で表現。
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
├─ cli/      CLI（memory コマンド）— memory-storage-cli
│  └─ src/cli.ts
└─ check/    実埋め込みモデルでの動作チェックツール（memory-storage-check）
   └─ src/check.ts
```

ルートは private なワークスペースルートで、`build` / `test` / `typecheck` を各ワークスペースに
委譲します。`cli` / `check` はライブラリをパッケージ名 `memory-storage` で import します。

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
| `MEMORY_MODEL_CACHE` | `~/.cache/memory-storage` | モデルのダウンロード先（`~`/絶対/相対パスを解釈） |
| `MEMORY_CHUNK_MAX_CHARS` | `1200` | チャンク 1 個の最大文字数（トークン上限の近似。小さいほど精度寄り） |

> 出力次元は 768 に固定です（全ベクトルに焼き付くため）。モデルを変える場合も 768 次元のものを
> 選び、既存データがあるときは全件 re-embed が必要です（[SKILL.md](.claude/skills/local-hybrid-search/SKILL.md) のガードレール参照）。

#### モデルのキャッシュ先

埋め込みモデルは既定で **`~/.cache/memory-storage`** にダウンロードされます（`node_modules` の外なので
`npm install` や `node_modules` 削除でも消えず、再ダウンロード不要）。`MEMORY_MODEL_CACHE` で変更でき、
パスは `--db` と同じ規則で解釈されます（`~` はホーム展開、絶対パスはそのまま、相対パスは実行ディレクトリ基準）。
起動時に実際のキャッシュ先が表示されます。

**ディレクトリ作成のガード**: キャッシュ先が `~/.cache` 配下なら自動作成しますが、**それ以外の場所は
自動作成しません**。存在しない場合はエラー終了します（typo した `MEMORY_MODEL_CACHE` が任意の場所に
数百 MB をばらまくのを防ぐため）。`~/.cache` 外を使うときは事前に `mkdir -p` してください。

### 3. ビルド（配布用 dist の生成・任意）

```bash
npm run build   # packages/core/dist に JS と型定義を出力
```

## 使い方

```ts
import { MemoryStore } from "memory-storage";

const store = new MemoryStore("./memory.db"); // 省略時は ":memory:"

// Markdown ページを登録（同じ slug への再登録は旧版を stale にして置き換え。
// 見出し＋文字数でチャンク分割し、未変更チャンクの embedding は再利用）
// put は { id, slug } を返す（id は UUIDv7）。後続呼び出しをそのまま連鎖できる。
const { id, slug } = await store.put("typescript", {
  content: "# TypeScript\n\nJS に静的型付けを加えた言語。\n\n## 型システム\n\n型推論が強力。",
  epistemic: "fact",
  sources: [{ kind: "url", uri: "https://www.typescriptlang.org/", title: "TS 公式" }],
});

// ハイブリッド検索（live のみ。チャンク粒度で slug / ordinal / headingPath / text を返す）
const results = await store.hybridSearch("型推論", 5);

// slug を最新 live ページに解決（全文 = content。Wiki リンク解決・元ページ復元）
const page = store.resolveSlug(slug);

// ページのチャンク一覧（分割の確認・再構成）
const chunks = store.getChunks(id);

// 出典の追加・再裏付け（鮮度も更新）
store.addEvidence(id, { kind: "url", uri: "https://example.com/proof" });

// 出典一覧・版履歴
const evidence = store.getEvidence(id);
const history = store.getHistory(slug);

store.close();
```

## CLI（`memory` コマンド）

書き込みは agent からの明示的な呼び出しを想定しています。CLI の各サブコマンドは、それ自体が
監査可能な write gate になります（[SKILL.md](.claude/skills/local-hybrid-search/SKILL.md) 参照）。

### グローバルインストール（`memory-storage` コマンド）

GitHub Action が事前ビルドした単一バンドルを `release` ブランチに公開しています。**ユーザー側で
ビルドは走りません**（`postinstall` なし）。ネイティブ依存（better-sqlite3 など）だけが通常どおり
インストールされます。

```bash
npm i -g github:qsat/memory-storage#release
memory-storage --help
memory-storage put typescript -c "# TypeScript\n\nJS に型を加えた言語" --db ~/memory.db
memory-storage search "型推論" --db ~/memory.db --json
```

> 仕組み: `.github/workflows/release.yml` が `main` への push ごとに、コア込みでバンドルした
> `packages/cli/dist/cli.js` を作って `release` ブランチにコミットします。ルート `package.json` は
> `bin: { "memory-storage": "packages/cli/dist/cli.js" }` と `files` 許可リストを持つので、
> インストール時の tarball は `package.json` ＋ そのバンドルだけ（モノレポ全体は含まれません）。
> 実行時に必要なネイティブ 3 依存はルートの `dependencies` として宣言してあり、npm が自動取得します。

### リポジトリ内で実行（開発時・ビルド不要、tsx 経由）

```bash
npm run cli -- put typescript -c "TypeScript は JS に型を加えた言語" -e fact \
  -s url:https://www.typescriptlang.org/
npm run cli -- search "型システムを持つ言語" -k 5
npm run cli -- history typescript
```

ローカルでバンドルを試す場合: `npm run build` で `packages/cli/dist/cli.js` を生成し、
`node packages/cli/dist/cli.js --help`（または `npm link` で `memory-storage` をグローバルに）。

### サブコマンド

| コマンド | 説明 |
|---|---|
| `put <slug> -c <content> [-e <epistemic>] [-s <kind:uri> ...]` | ページ新規 or 置換 |
| `search <query> [-k <topK>] [--group-by-page]` | チャンク粒度のハイブリッド検索。`--group-by-page` でページ単位・読み順に整列 |
| `get <slug>` | ページの全文 Markdown を出力（復元） |
| `resolve <slug>` | ページの id / メタ情報 |
| `history <slug>` | 版履歴 |
| `chunk <chunkId> [--context <n>]` | チャンク単体表示（`--context` で前後 n 件を含める）。**live のみ**解決可能 |
| `evidence <pageId>` | 出典一覧 |
| `add-evidence <pageId> -s <kind:uri> [-s ...]` | 出典追加 |

共通オプション: `--db <path>`（既定: env `MEMORY_DB` または `memory.db`）、
`--json`（機械可読出力。agent はこちらを使用）、`-h/--help`。

`--db` の相対パスは**コマンドを実行したディレクトリ基準**で解決されます（`npm run` は cwd を
`packages/cli` に変えますが、`memory` が実行された元ディレクトリを使うため意図どおりの場所に作られます）。
解決後の DB パスは起動時に stderr に表示されます。`:memory:` はプロセス終了で消えるため CLI では非推奨です。

`-s/--source` は `kind:uri` の略記、または JSON
（`'{"kind":"url","uri":"...","title":"...","locator":"..."}'`）を受け付けます。
`kind` は `file` / `url` / `conversation` / `tool` / `other`。

> 初回実行時はモデルのダウンロードが走り、進捗が stderr に表示されます（`--json` の stdout は汚しません）。

## 公開 API

> ID 体系: `page.id` は **UUIDv7**（時系列順 = 作成順にソート可能）。`chunk.id` は fts5/vec0 の
> rowid 制約のため整数（`AUTOINCREMENT` で再利用されない）で、安定外部 ID として
> `chunk.uuid`（UUIDv7）を併記します。

| 関数 | 役割 |
|---|---|
| `put(slug, { content, sources?, epistemic? })` | ページ新規 or 置換（Wiki 編集相当）。**`{ id, slug }` を返す**（`id` は UUIDv7）。将来の insert 系書き込みも同じ形を返す規約 |
| `addEvidence(pageId, source)` | 出典追加 / 再裏付け（強化）。鮮度も更新 |
| `resolveSlug(slug)` | 最新 live ページ（全文 content）を返す |
| `getChunks(pageId)` | ページのチャンク一覧（ordinal 順） |
| `getChunkById(chunkId)` | チャンク単体＋親ページのメタ情報。**live のみ**解決可能（stale 版のチャンクは削除済みで解決しない） |
| `getChunkNeighbors(chunkId, radius?)` | 対象チャンク＋前後 `radius` 件（既定 1）を ordinal 昇順で返す。ページ境界でクランプ |
| `hybridSearch(query, topK?)` | live のみ。**チャンク粒度**で `slug`/`ordinal`/`headingPath`/`text`/`sourceCount`/`lastConfirmedAt` 付き |
| `getEvidence(pageId)` | 出典一覧 |
| `getHistory(slug)` | 版履歴（古い順、live が現行） |
| `groupSearchResultsByPage(results)` | `hybridSearch` の結果をページ単位でまとめ、各ページ内は `ordinal` 昇順（読み順）に整列する純粋関数 |

### 並び順（ordinal）について

- **正準順序は `(page, ordinal)` 昇順**。`getChunks(pageId)` は常にこの順で返します。これが
  ページの読み順であり、`page.content` から `chunkMarkdown` で再生成しても同じ順序になります。
- **`hybridSearch` はスコア順**（読み順ではありません）。同一ページの複数チャンクが当たった場合に
  読み順へ戻すには `groupSearchResultsByPage(results)` を使います（CLI では `search --group-by-page`）。
- **`ordinal` は版をまたいで比較できません**。ページを `put` で更新すると章構成に応じて
  ordinal は 0 から振り直されます。異なる `pageId`（＝異なる版）の ordinal を比べても意味を持ちません。

## CI

`.github/workflows/test.yml` が pull request 時に Node 20.x / 22.x のマトリクスで
型チェックとテストを実行します（モデル DL 不要のオフライン構成）。
