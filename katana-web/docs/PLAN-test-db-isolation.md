# 計画：専用テストDBの構築とVitest統合テストの分離

作成日: 2026-10-26
更新日: 2026-11-03（Step 3-7・3-7Bの実施結果を反映）
作業ブランチ: `chore/test-db-isolation`（`fix-dashboard` の `6168889` から作成）

## 状態

| Phase | 状態 |
|---|---|
| Phase 1：読み取り専用の調査 | **実施済み**（結果は本ファイルの1章） |
| Phase 2：安全設計 | **設計レビュー完了**（確定設計は本ファイルの2章） |
| Phase 3：実装 | **実施中**（Step 3-0〜3-7B 実施済み。Step 3-3〜3-6は `824d54b` でcommit、Step 3-7・3-7Bは**未commit**。次は **Step 3-8**。結果は3章の「3-A. 実施結果」） |
| Phase 4：検証 | **未着手** |

F-01の判定は **CONDITIONAL PASS のまま**。実DB・Cookie・HTTPでの検証は、Phase 4のE2Eで行う。

**進め方:** 1つのStepごとにセッションを `/clear` で区切る。各セッションは、末尾の「次のセッションで最初に行うこと」から始める。Stepが終わったら、3章の「3-A. 実施結果」と「次のセッションで最初に行うこと」を更新してから終える。

本ファイルでは、確認できた事実だけを「確認済み」と書く。実行して確かめていない事項は「未検証」と書く。

## 0. 背景と目的

- 開発用DB（Docker の `katana-db`、`localhost:5433`、DB名 `katana`）が1つあるだけで、テスト専用のDBがない。
- `lib/prisma.ts` は `import "dotenv/config"` で `.env` を読み込む。そのため、本物の Prisma クライアントを読み込んだテストは、開発用DBに接続する。
- 次の6ファイルは、開発用DBに一時データを作成し、`afterAll`・`finally` で削除する。2〜6は、Step 3-5で `*.test.ts` から `*.integration.test.ts` にリネームした（中身は同じ。かっこ内は旧名）。
  1. `lib/dashboard/trendPeriod.integration.test.ts`
  2. `lib/dashboard/marketFilterMasters.integration.test.ts`（旧 `marketFilterMasters.test.ts`）
  3. `lib/dashboard/recentImports.integration.test.ts`（旧 `recentImports.test.ts`）
  4. `lib/market-analytics/currentMetrics.integration.test.ts`（旧 `currentMetrics.test.ts`）
  5. `lib/market-analytics/priceTrend.integration.test.ts`（旧 `priceTrend.test.ts`）
  6. `lib/market-analytics/soldMetrics.integration.test.ts`（旧 `soldMetrics.test.ts`）
- F-01の実環境検証（実DB・Cookie・HTTP）が、専用DBがないために未完了。

目的:

1. 開発用DBとは完全に分かれた、テスト専用のDBを用意する。
2. 通常のテスト（モックのみ）と統合テスト（DBを使う）を、実行コマンドの段階で分ける。
3. 統合テストが開発用DBに接続しようとしたら、接続する前に止める。
4. その環境でF-01のE2E-01〜06を検証できるようにする。

## 全Phase共通の禁止事項

- **`npx vitest run` / `npm test` を引数なしで実行しない**（Step 3-6で承認を得て初めて実行するまで）。
- 開発用DB（`katana`）へ書き込まない。状態確認は `BEGIN READ ONLY` の中で `SELECT` だけを使い、事前に承認を得る。
- ユーザーの承認なしに、次の操作を行わない。
  - DBへの接続
  - Dockerの操作（読み取り系のコマンドを含む）
  - Prisma CLIの実行
  - migration・`db push`・seed
  - 統合テストの実行

  承認は操作ごとに個別に得る。
- `docker-compose.yml`（開発用）と、ボリューム `postgres_data` を変更しない。
- `test-data/` を変更・削除しない。
- 秘密情報（パスワード、`AUTH_SECRET`、接続文字列の全文）をドキュメント・ログ・報告に書かない。
- 既存の差分を破棄しない。ユーザーの指示なしに add・commit・push・reset・clean をしない。
- `CLAUDE.md` を変更しない（変更が必要なら提案だけにする）。
- 統合テストのガードを、テストを通すために緩めない。

---

## 1. Phase 1：調査結果（実施済み）

コードと設定を読んで確認した事実。DB・Docker・テストは操作していない。

### 1-1. 環境変数・Prisma

- `lib/prisma.ts`・`prisma.config.ts`・`prisma/seed.ts` が、`import "dotenv/config"` で `.env` を読み込む。
- dotenv は 17.2.3。すでに設定されている環境変数は上書きしない。ただし、読み込み時に `DOTENV_CONFIG_PATH`・`DOTENV_CONFIG_OVERRIDE` などの環境変数を参照し、それによって挙動が変わる。
- `DATABASE_URL` を設定し忘れると、開発用DBに接続する。
- `.env` のキーは `DATABASE_URL` だけ、`.env.local` のキーは `AUTH_SECRET` だけ。`.env.test` はなく、`.gitignore` の除外対象にも入っていない。
- 調査時点のバージョン：Node v25.9.0、Vitest 4.1.11、Prisma 7.2.0。
- `lib/prisma.ts` は `globalForPrisma.prisma` を再利用し、`PrismaPg` を通して接続する。接続は最初のクエリのときに行われる。

### 1-2. Docker・PostgreSQL

- `docker-compose.yml` にはサービスが1つだけ（`katana-db`、`postgres:15`、`5433:5432`、ボリューム `postgres_data`）。
- `name:` を指定していないので、Composeのプロジェクト名はディレクトリ名（`katana-web`）になる。同じディレクトリに置いた別のComposeファイルを `-p` なしで操作すると、開発用と同じプロジェクトとして扱われる。
- 開発用DBの認証情報が、Git管理下の `docker-compose.yml` に直接書かれている（範囲外。テスト用の設定ではこの書き方をまねない）。

### 1-3. Vitest・テストファイル

- `vitest.config.ts` には `include`・`exclude`・`setupFiles`・`globalSetup` がない。`npm test` は `vitest run`。
- Vitestが標準で拾うファイル名の規則に、`*.integration.test.ts` も当てはまる。除外を明示的に設定する必要がある。
- テストファイルは全28件。

  | 分類 | 件数 | 判断基準 |
  |---|---|---|
  | `@/lib/prisma` をモックしている | 12 | `vi.mock("@/lib/prisma")` がある |
  | DBを使わない | 10 | `proxy.test.ts` と `historyReadPaths.test.ts` を含む |
  | DBに書き込む | 6 | 0章の6ファイル |

  前のセッションの報告（13・9・6）とは1件ずれているが、分類の基準の違いによるもので、合計は一致している。
- DBを使わない10件は、間接的にも `lib/prisma.ts` を読み込まない。`lib/prisma` を `importActual` しているテストもない。
- 6ファイルは `randomUUID` で名前を一意にしたデータを作る。途中で終了すると、データが残り得る。有効な店舗や商品を作るので、開発用DBに残ると市場分析に混ざる。
- `lib/testing/historyReadPaths.test.ts` は、`\.test\.tsx?$` と `lib/market-analytics/testHelpers.ts` を検査対象から外している。`*.integration.test.ts` にリネームしても影響はない。
- VS CodeのVitest拡張機能は入っていない。`.vscode/` はGitの管理対象外。

### 1-4. DBへの接続経路

既存の統合テスト6件は、すべて `@/lib/prisma` の1つのPrisma Clientを通る。使い方は次の3通り。

- テストファイルが直接読み込む。
- `testHelpers.ts` を経由する。
- テスト対象のモジュール（`currentMetrics.ts`・`priceTrend.ts`・`soldMetrics.ts`・`recentImports.ts`・`marketFilterMasters.ts`）を経由する。

`$queryRaw` などの生SQLも、同じPrisma Clientを使う。

| # | 経路 | 現状 | 対策（2章） |
|---|---|---|---|
| P1 | `lib/prisma.ts` のシングルトン | アプリと統合テストのすべてが使う | 実行時のガード |
| P2 | `globalForPrisma.prisma` の再利用 | `global.prisma` が先に設定されていると、新しいPrisma Clientを作らない | ガードをモジュール本体の先頭で無条件に実行する |
| P3 | `vi.resetModules`・`vi.importActual("@/lib/prisma")` | 今は使われていない | モジュールが評価し直されるので、ガードも再び実行される |
| P4 | Prisma CLI（`migrate dev`/`reset`/`deploy`、`db push`/`pull`、`studio`、`migrate diff`） | `prisma.config.ts` 経由で `.env` を読み込む | テストDB向けは専用スクリプトに限る。`prisma.config.ts` にもガードを入れる（残余リスクあり。2-7） |
| P5 | `lib/generated/prisma/` | `.gitignore` の対象なのに、Gitで管理されている古いPrisma Client（Katanaなどの旧スキーマ）。どこからも読み込まれていない | 静的検査でimportを禁止する |
| P6 | `pg` の直接利用 | アプリにはない | 静的検査（許可リスト方式） |
| P7 | テストの中で `new PrismaClient`・`new PrismaPg` を書く | 今はない | 静的検査 |
| P8 | `prisma/seed.ts` | 独自にPrisma Clientを作り、`.env` を読む。手動で実行する | 範囲外。テストDBにはseedを使わない |
| P9 | `next dev`・`next start`（E2E） | `VITEST` が設定されないので、ガードは働かない | Phase 4で `KATANA_DB_TARGET=test` を条件にガードを働かせる |

### 1-5. migration

- Gitのリポジトリのルートは、1つ上の `KatanaService/`。`katana-web/.gitignore` の16行目 `prisma/migrations/` が、ディレクトリ全体を除外している（このルールは commit `92ebe85` で追加）。
- 手元のmigrationは8件。Gitで管理されているのは、最初のcommit `251c511` の `20260118115533_init_new_schema/migration.sql` と `migration_lock.toml` だけ（どちらもHEADとの差分なし）。残りの7件は一度もcommitされていない。

| migration | 内容 | 依存先 | sha256（先頭12文字） |
|---|---|---|---|
| `20260118115533_init_new_schema`（Git管理） | 旧スキーマ：User・Katana・KatanaRequest | – | `dbdf924f0aea` |
| `20260506222715_add_katana_listing` | 旧スキーマ：KatanaListing・RawListing・PriceHistory（掲載単位） | 0118 | `871b718c45b4` |
| `20260509020919_make_era_nullable` | KatanaListing.era をNULL可にする | 0506 | `22d3ac025c38` |
| `20260718054301_init` | 名前は init だが、実際は旧テーブルを削除して今の業務スキーマへ移す内容。Shop・Product・Import系・マスタを作る | 0118・0506・0509のオブジェクトが必要 | `8d20d05b2447` |
| `20260922030332_domain_model_province_swordera_import_seq` | Traditionを削除し、Province・SwordEra・`nextProductSequence`・`rawData` を追加 | 0718 | `8a72b3a4248c` |
| `20260924081921_product_price_optional` | Product.price をNULL可にする | 0718 | `d24e158446f4` |
| `20260924082945_product_maker_optional` | Product.makerId をNULL可にし、外部キーをSET NULLにする | 0718 | `d10104dadfbb` |
| `20261003010138_price_history_new_price_nullable` | PriceHistory.newPrice をNULL可にする | 0718 | `08335fab6e44` |

- 空のDBに順番に適用できる見込み（0718の警告は、テーブルが空なら問題にならない）。ただし **未検証**。
- 最終的な形は、手作業で照合した範囲では `schema.prisma` と一致している。ただし **機械的な照合は未実施**。
- 開発用DBの `_prisma_migrations` に記録されたchecksumとの照合は **未実施**。

### 1-6. Phase 1で確認したリスク

| ID | 内容 | 重大度 | 対策 |
|---|---|---|---|
| K1 | テスト用の環境変数を設定し忘れて、開発用DBに接続する | 高 | 2-2 |
| K2 | 通常のVitest実行やエディタの操作で、統合テストが実行される | 高 | 2-2・2-4 |
| K3 | テストが途中で終了して、開発用DBにテストデータが残る | 高 | 2-1・2-3 |
| K4 | Prisma CLIが開発用DBを対象にする | 中 | 2-7（残余リスクあり） |
| K5 | `.env.test` がGitで管理される | 中 | 2-1 |
| K6 | Composeの誤操作で、開発用のコンテナやボリュームが削除される | 中 | 2-5 |
| K7 | E2Eで、localhostのポートだけを変えてもCookieが混ざる | 低 | Phase 4 |
| K8 | dotenvの設定で、環境変数の優先順位が変わる | 低 | 2-2 |

---

## 2. Phase 2：確定設計（設計レビュー完了）

### 全体像

```
npm test / test:unit ─► vitest.config.ts（通常テスト）
   ・*.integration.test.* を除外
   ・DATABASE_URL に接続できないダミー値を設定
   ・本物の lib/prisma.ts を読み込んだら即 throw

npm run test:integration ─► 専用runner
   ・.env.test を読み、きれいな環境変数を作る ─► 接続前ガード
   ─► vitest --config vitest.integration.config.ts
        ├ globalSetup：接続前ガード → 接続後の照合 → データが残っていないかの読み取り確認（削除しない）
        ├ setupFiles：各ワーカーで接続後の照合
        └ lib/prisma.ts：接続前ガード（どの起動方法でも必ず通る）

テストDB：docker-compose.test.yml（プロジェクト katana-test、127.0.0.1:5434、tmpfs、名前付きボリュームなし）
操作は testdb ラッパーからのみ。操作の前後に、対象と開発用DBの状態を照合する
```

### 2-1. テストDBの隔離

| 項目 | 確定値 |
|---|---|
| Composeファイル | `docker-compose.test.yml`（開発用の `docker-compose.yml` とは別） |
| Composeプロジェクト名 | `katana-test`（ファイル内の `name:` と、`-p` の両方で指定する） |
| サービス・コンテナ | `test-db`・`katana-test-db` |
| イメージ | `postgres:15`（開発用と同じメジャーバージョン） |
| DB名・ユーザー | `katana_test`・`katana_test_user`（開発用の認証情報は流用しない） |
| 接続先 | `127.0.0.1:5434`（自分のPCからだけ接続できる） |
| データの保存先 | tmpfs（`/var/lib/postgresql/data`） |
| ボリューム | 名前付きボリュームを使わない（トップレベルに `volumes:` を書かない） |
| DBの識別 | 初期化SQL（`docker/test-db/init/`）で、DBにコメント `katana-test-db` を付ける |
| 環境変数ファイル | `.env.test`（`.gitignore` に追加する）。秘密情報を書かない `.env.test.example` をGitで管理する |

- 開発用の `docker-compose.yml` と `postgres_data` は変更しない。
- 未検証：Postgresのイメージが宣言する `VOLUME` を、tmpfsで上書きしたときに無名ボリュームが作られないか（Step 3-11で確認する）。

### 2-2. DB接続ガード

**共通の検証関数**（`lib/db/testDatabaseGuard.ts`）

- 副作用のない純粋な関数として作る。`node:` 以外のモジュールは読み込まず、`@/` のエイリアスも使わない。
- 次の条件のどれかに当てはまったら `throw` する。エラーメッセージにパスワードは含めない。
  1. `DATABASE_URL` が未定義、または空。
  2. `new URL()` で解析できない。または、スキームが `postgres:`・`postgresql:` 以外。
  3. ホストが `127.0.0.1`・`localhost` 以外（`::1` は、Step 3-2の実装で拒否する側に変更した。3-A参照）。
  4. ポートが `5434` 以外（ポートの省略も拒否する）。
  5. DB名が、正確に `katana_test` ではない。
  6. ユーザーが `katana_test_user` 以外。
  7. クエリパラメータが1つでもある（`?host=` などで接続先を上書きされるのを防ぐ）。
  8. 開発用DBと同じ接続先を指している（`.env` を `dotenv.parse` で読んで比べる。`process.env` は変えない）。
  9. `PGHOST`・`PGPORT`・`PGDATABASE`・`PGUSER`・`PGSERVICE` のどれかが設定されている。
  10. `DOTENV_CONFIG_PATH` または `DOTENV_CONFIG_OVERRIDE` が設定されている。

**`lib/prisma.ts`（第1層）**

- モジュール本体の**先頭で無条件に**ガードを実行する。`globalForPrisma.prisma` を再利用するかどうかの分岐より前に置く。
- `import "dotenv/config"` は本体より先に実行されるので、dotenvが読み込みを終えた後の最終的な値を検証できる。
- 判定:
  - `VITEST` が設定され、`KATANA_DB_TEST_MODE !== "integration"` のとき（通常テスト）→ 本物のPrisma Clientを読み込んだ時点で `throw` する。
  - `VITEST` が設定され、統合テストのモードのとき → 検証関数を実行する。
  - `VITEST` が設定されていないとき（Next.jsの開発サーバー・本番）→ 今の動作を変えない。Phase 4では、`KATANA_DB_TARGET=test` のときも検証関数を実行するように広げる。

**runner（第0層）**

- `.env.test` は `dotenv.parse` で読む（`process.env` には反映しない）。
- 子プロセスに渡す環境変数から `DOTENV_CONFIG_*`・`PG*` を取り除き、`DATABASE_URL` を `.env.test` の値で明示的に上書きする。親プロセスから渡された値は信用しない。
- 検証関数を実行してから、`KATANA_DB_TEST_MODE=integration` と `KATANA_TEST_RUNNER=script` を設定して、Vitestを起動する。

**globalSetup・setupFiles（第2層）**

- globalSetupの処理:
  1. `KATANA_TEST_RUNNER !== "script"` なら停止する（runnerを経由しない起動を拒否する）。
  2. 検証関数をもう一度実行する。
  3. `pg` で接続し、`current_database()`、`current_user`、DBのコメントがそれぞれ `katana_test`、`katana_test_user`、`katana-test-db` と**すべて一致するまで**先に進まない。
  4. 2-3のデータ残留確認を行う。
- setupFilesでは、各ワーカーで、本物のPrisma Clientを使って3と同じ照合を行う。

**Prisma migration用スクリプト**

- 検証関数の実行、接続先の表示（パスワードは表示しない）、DBのコメントの照合を通ってから、Prisma CLIを起動する（2-7）。

**起動方法ごとの安全性（設計上の想定。Phase 4で検証する）**

| 起動方法 | 想定される結果 |
|---|---|
| `npm test`・`npx vitest run` | 統合テストは除外される。万一読み込まれても `throw` する |
| 統合テストのファイルを、標準の設定で直接指定する | 除外されていて実行されない。強制しても `throw` する |
| `--config vitest.integration.config.ts` で直接実行する | globalSetupで停止する。`.env` の開発用の値は、検証関数の条件5・6・8に当たって `throw` する |
| エディタの実行ボタン | 標準の設定が使われるので、1行目と同じ |

### 2-3. テストデータの初期化

- **globalSetupでは、自動的な `TRUNCATE`・`DELETE` を行わない。** テストの実行の中で、データを削除するコードは書かない。
- **開始前の読み取り確認**（`BEGIN READ ONLY`。接続後の照合に合格した後でだけ行う）
  - `_prisma_migrations`：想定した件数のmigrationがすべて適用済みで、失敗したものがない。
  - 業務データ：`public` スキーマの全テーブルが0件であること（`_prisma_migrations` は除く）。
  - 1件でも残っていれば、「`npm run testdb:reset` を実行してください」と表示して、統合テストを始めずに停止する。
- **テーブルが将来追加されても、確認から漏れないようにする**
  - 確認の対象は、固定したテーブル名の一覧ではなく、`pg_tables`（`schemaname = 'public'`）から毎回取得する。
  - あわせて、Prisma Clientのモデル名の一覧（`Prisma.ModelName`）と照合する。DB側とスキーマ側でテーブルの数や名前が食い違えば、停止する（migrationの適用漏れを検出するため）。
- **初期化は `testdb:reset` だけで行う。** 中身は、2-5の操作前の照合 → `down` → `up` → 操作後の照合 → migration用スクリプト。データはtmpfs上にあるので、コンテナを作り直せば消える。SQLによる削除は使わない。
- **作り直しの前後に確認すること:**
  - 対象のコンテナが `katana-test-db` だけであること。
  - データの置き場所がtmpfsであること。
  - 開発用のコンテナ・ボリュームの記録が変わっていないこと。
- 既存テストの `afterAll`・`finally` による削除は維持する。runnerは終了時に件数をもう一度読み取り、残っていれば「後片付けの不具合」として警告する。データが残っていると、次の実行は開始前の確認で停止する。
- 並列実行：当面は `fileParallelism: false` にする（全件を集計するテストの結果を安定させるため）。

### 2-4. Vitestの分離

| 項目 | 内容 |
|---|---|
| `vitest.config.ts`（通常テスト） | `include: ["**/*.test.{ts,tsx}"]`、`exclude: [...configDefaults.exclude, "**/*.integration.test.{ts,tsx}"]`、`env.DATABASE_URL` に接続できないダミー値（例：`127.0.0.1:9`） |
| `vitest.integration.config.ts`（新規） | `include: ["**/*.integration.test.{ts,tsx}"]`、`globalSetup`、`setupFiles`、`fileParallelism: false`、`testTimeout` を延長 |
| `npm test` / `test:unit` | 通常テストだけ（DBに書き込むテストは含まない） |
| `test:integration` | 専用runnerを経由してだけ起動できる |
| リネームする5ファイル | `marketFilterMasters`・`recentImports`・`currentMetrics`・`priceTrend`・`soldMetrics` の `.test.ts` を `.integration.test.ts` にする（`trendPeriod.integration.test.ts` は今の名前のまま） |
| リネームの影響 | これらのテストファイルを読み込むファイルはない。`testHelpers.ts` は移動しない。`recentImports.authz.test.ts`（モックを使うテスト）は今の名前のまま |
| テストの中身 | 6ファイルのテスト内容は変更しない |
| 静的検査（新規・DBを使わない） | `new PrismaClient`・`new PrismaPg`・`from "pg"`・`generated/prisma` を、許可リスト（`lib/prisma.ts`、`prisma/seed.ts`、ガード関連のファイル、`scripts/testdb*`）以外で使っていたら失敗させる。実装は `lib/testing/dbConnectionPaths.test.ts`（規則1〜4。3章のStep 3-4参照） |
| 今後の分類ルール | 本物の `@/lib/prisma` を使うテストは、必ず `*.integration.test.ts` にする。統合テストの除外は命名規則（`**/*.integration.test.{ts,tsx}`）だけで行い、`vitest.config.ts` に明示リストを置かない（Step 3-5で削除） |

- 未検証：Vitest 4で、`test.env` が `process.env` を上書きすること。Viteが `.env.test` を読み込んでも、`VITE_` で始まる変数しか外に出さないこと（Step 3-3・3-7で確認する）。

### 2-5. Docker操作の保護

- **操作は、ラッパースクリプト（`scripts/testdb.mts`）からだけ行う。** docker composeを呼ぶときは、必ず `-p katana-test -f docker-compose.test.yml --env-file .env.test` を付ける。
- **環境変数とDockerコンテキスト**
  - 子プロセスからは `COMPOSE_PROJECT_NAME`・`COMPOSE_FILE`・`COMPOSE_PROFILES` を取り除く。
  - `DOCKER_HOST` か `DOCKER_CONTEXT` が設定されていたら停止する。
  - `docker context show` の結果が、Step 3-0で記録した値と一致しなければ停止する。
- **操作前の確認（読み取りのみ。1つでも条件を満たさなければ中止）**
  1. `config --format json` の検証：
     - プロジェクト名が `katana-test`。
     - サービスが `test-db` の1つだけ。
     - コンテナ名が `katana-test-db`。
     - トップレベルに `volumes` がなく、`type: volume` のマウントもない。
     - tmpfsが `/var/lib/postgresql/data` に設定されている。
     - ポートが `127.0.0.1:5434` だけ。
     - `POSTGRES_DB` が `katana_test`。
     - 設定全体に `katana-db`・`postgres_data`・`5433` という文字列が含まれない。
  2. `ps -a` と、ラベル `com.docker.compose.project=katana-test` で絞り込んだ一覧に、出てくるのが `katana-test-db` だけ。
  3. 開発用コンテナ `katana-db` のID・状態・マウントと、開発用ボリュームの有無を記録する。
  4. `up` の前に、5434番ポートが空いていることを `lsof` で確かめる。
- **操作後の確認**
  - `up` の後：
    - データの置き場所がtmpfsで、無名ボリュームがない。
    - ポートが `127.0.0.1:5434` である。
    - DBのコメントが一致する。
  - すべての操作の後：3で記録した開発用DBの状態が変わっていない。
- **使えるコマンド**：`config`、`ps`、`up -d --wait`、`down`、`logs` だけ。
- **禁止する操作**
  - `-p`・`-f` を付けない `docker compose`
  - `--remove-orphans`
  - `down -v`
  - `docker volume rm` と `docker volume prune`
  - `docker system prune` などのprune系
  - `katana-db` に対するすべての操作

### 2-6. migrationの扱い（M-Aを採用予定）

- **M-A**：手元の8件を、**中身を変えずに**Gitで管理する（`.gitignore` の `prisma/migrations/` を削除し、7件を追加する）。checksumは変わらないので、開発用DBにも影響しない想定。
- **Gitへの追加は、開発用DBの `_prisma_migrations` と、1-5のchecksumとの照合が完了するまで保留する。** 一致しなければ、M-Aの前提が崩れるので、設計を見直す。
- 空のテストDBへの適用と、`schema.prisma` との一致は **未検証**。Step 3-12で、テストDBに適用した後に照合する。
- migrationの再生成、履歴の書き換え（1件にまとめ直すなど）、開発用DBへの適用は行わない。
- 旧スキーマ（スクレイピング時代のテーブル）を含むmigrationは、0718で削除されるので、最終的なスキーマには残らない。履歴の整理は範囲外。

### 2-7. Prisma CLIと残余リスク

- テストDBへのmigrationは、**専用スクリプト（`scripts/testdb-migrate.mts`）を経由してだけ**行う。
  1. `.env.test` を読み込む。
  2. 検証関数を実行する。
  3. 接続先を表示する（パスワードは表示しない）。
  4. DBのコメントを照合する。
  5. `DOTENV_CONFIG_*`・`PG*` を取り除き、`KATANA_DB_TARGET=test` を設定した環境変数で、`prisma migrate deploy` を実行する。
- `prisma.config.ts` に、「`KATANA_DB_TARGET=test` が設定されているときは検証関数を実行する」ガードを追加する。
- **残余リスク：** `KATANA_DB_TARGET=test` を設定せずに、Prisma CLIを直接実行した場合（`npx prisma migrate reset`、`db push`、`studio` など）は、これまでどおり `.env` の開発用DBに接続する。このガードでは防げない。運用ルール（テストDBにはスクリプトだけを使い、Prisma CLIを直接実行しない）とCLAUDE.mdへの明記で対処する。
- テストDBでは `db push` と seed を使わない。

---

## 3. Phase 3：実装順序（実施中）

### 3-A. 実施結果（2026-11-02時点）

| Step | 状態 | commit |
|---|---|---|
| 3-0 | 実施済み（Dockerの記録は未記録。下記） | なし |
| 3-1 | 実施済み | `3dcfbb3` |
| 3-2 | 完了 | `3f0c710` |
| 3-3 | 完了（buildは未実施） | `824d54b`（Step 3-6の後処理でcommit。`test: isolate unit and integration database access`） |
| 3-4 | 静的監査完了 | 記録なし（下記） |
| 3-4B | 接続経路の静的検査（規則1・2）完了 | `824d54b` |
| 3-5 | 統合テストのリネーム完了 | `824d54b` |
| 3-5B | 規則3・4の静的検査とPLANの更新を実施 | `824d54b` |
| 3-6 | 完了（`npm test` を2回実行し、すべて成功） | `824d54b`（PLANの更新を含む） |
| 3-7 | 統合テスト用runner・専用設定の作成完了（globalSetupは意図的に必ず停止） | **未commit** |
| 3-7B | runnerの確認モードの検証・`.env.test` のGit保護の確認 | **未commit**（変更はPLANだけ） |
| 3-8 | **次に行う** | – |

**commitの状態：** Step 3-3〜3-6の変更（本ファイルを含む）は、Step 3-6の後処理で1つのcommit `824d54b`（`test: isolate unit and integration database access`）にまとめた。5ファイルのリネームもこのcommitに含む。各Stepの記録にある「未commit」「未追跡」は、記録した時点の状態。期待する `git status` は末尾の節。

**実際のDB接続による検証は、まだ1回も行っていない：** ガードの `throw`、統合テストのモードでの許可、静的検査の判定が実際の実行と一致することは、どれも静的な確認とDBを使わない単体テストだけで確かめている。

**Step 3-0**

- checksum：開発用DBの `_prisma_migrations` と手元の8件のSHA-256が一致した（`3dcfbb3` のcommitメッセージに記録）。R2は解消。
- Dockerの記録（`docker context show` の値、開発用ボリュームの正確な名前、`katana-db` の記録）：**本ファイルにもcommitにも記録が残っていない**。2-5は「Step 3-0で記録した値」との照合を前提にしているため、**Step 3-9の前に、承認を得て読み取り系コマンドで取得し直し、ここに記録する**。

**Step 3-1**

- `.gitignore` から `prisma/migrations/` を削除し、7件を中身を変えずに追加した（`3dcfbb3`）。Gitで管理されるのは、migration 8件と `migration_lock.toml`。

**Step 3-2**

- 作成：`lib/db/testDatabaseGuard.ts`、`lib/db/testDatabaseGuard.test.ts`（`3f0c710` でcommit。Step 3-3で追加したIPv6のテストも含む）。
- API：`assertTestDatabaseTarget({ databaseUrl, env, developmentDatabaseUrl })`。成功時はパスワードを含まない `{ host, port, database, user }` を返し、失敗時は `TestDatabaseGuardError`（`code` 付き）を投げる。`TEST_DATABASE_TARGET` 定数も公開する。**このAPIは以後のStepで変更しない。**
- `.env` の読み込みなどの副作用は持たず、呼び出し側が `developmentDatabaseUrl` を渡す。
- 設計（2-2）との違い（いずれも設計より厳しい側）:
  - 許可するホストは `127.0.0.1` と `localhost` だけ。**`::1` は許可しない**（構文としては有効なURLでも `HOST_NOT_ALLOWED`）。
  - エラーコード `PASSWORD_MISSING`（パスワードが空）と `DEVELOPMENT_URL_INVALID`（開発用URLを解析できない）を追加した。
  - 空白・制御文字を含むURL、フラグメント（`#`）も拒否する。
  - 環境変数の検査は、名前の列挙ではなく `PG*`・`DOTENV_*` の前方一致で行う（値が空文字でも拒否）。
- テスト：74件すべて成功（このファイルだけを指定して実行。IPv6の明示的なテストを含む）。

**Step 3-3**

- 変更：`lib/prisma.ts`、`vitest.config.ts`（どちらも未commit）。IPv6のテスト1件を `lib/db/testDatabaseGuard.test.ts` に追加した（`3f0c710` に含まれる）。
- `lib/prisma.ts`:
  - モジュール本体の先頭（`globalForPrisma` の再利用・`new PrismaPg`・`new PrismaClient` のどれよりも前）で `assertVitestDatabaseAccess()` を実行する。
  - Vitestかどうかの判定：`VITEST`・`VITEST_WORKER_ID`・`VITEST_POOL_ID` のどれかが設定されている。どれもなければ何もしない（開発サーバー・本番の動作は変わらない）。
  - Vitest実行中は、`KATANA_DB_TEST_MODE === "integration"` **かつ** `KATANA_TEST_RUNNER === "script"` でなければ、すぐに `throw` する。両方そろっていれば `assertTestDatabaseTarget()` を実行する。
  - 開発用DBのURLは、`process.cwd()` の `.env` を `dotenv.parse` で読む（`process.env` は変えない）。`.env` がなければ `undefined`。あるのに読めない・解析できない場合は `throw`。
- `vitest.config.ts`:
  - `exclude`：`configDefaults.exclude`、`**/*.integration.test.{ts,tsx}`、DBに書き込む6ファイルの明示リスト（`DB_INTEGRATION_TEST_FILES`）。**明示リストはStep 3-5で削除した。現在の `exclude` は `[...configDefaults.exclude, "**/*.integration.test.{ts,tsx}"]` だけ。**
  - `test.env`：`DATABASE_URL=postgresql://no-db@127.0.0.1:9/unit_tests_must_not_connect`、`KATANA_DB_TEST_MODE=unit`。
  - `include` は設定していない（Vitestの既定値のまま。2-4の設計とは違う）。
- 確認済み（コードとVitest 4.1.11のソースを読んで確認）:
  - ワーカーの環境変数は `{...親のprocess.env, VITEST等, ...test.env}` の順で合成され、テストのモジュールを評価する前に反映される。つまり、`test.env` は親の値を上書きする。`dotenv/config` は既存の値を上書きしない。
  - `vitest list --filesOnly` は、テストファイルを読み込まずにglobの結果だけを出す。
  - `@/lib/prisma` をモックしている12ファイルは、すべてファクトリ付きの `vi.mock` なので、本物のモジュールを評価しない。モックしていない通常テストは、間接的にも本物の `lib/prisma.ts` を読み込まない。
- 検証結果：`npx tsc --noEmit` 成功、変更した3ファイルの `eslint` 成功。`vitest list --filesOnly` は23件で、DBに書き込む6件は含まれない。
- テストファイルの内訳（29件）：`@/lib/prisma` をモックする12件、Prismaを読み込まない11件（Step 3-2のテストを含む）、DBに書き込む6件。
- **未実施・未検証:**
  - `npm run build`：プリレンダリングでページがDBを読まないことを静的に保証できなかったため、実行していない。
  - ガードが実際に `throw` すること、統合テストのモードで正しいURLが許可されることは、まだ動かして確かめていない（Step 3-6・3-7・Phase 4で確かめる）。
  - Viteの警告「ESM syntax in a file loaded as CommonJS」が `vitest list` で出る。`package.json` に `"type": "module"` がないためで、変更前から出ていたと見ているが、未確認。
- 以後のStepへの申し送り:
  - ~~**Step 3-5:** リネームの後、`vitest.config.ts` の `DB_INTEGRATION_TEST_FILES` を新しいファイル名に更新する。~~ → Step 3-5で、更新ではなく明示リストを削除した（命名規則による除外だけにした）。
  - **Step 3-7:** `test.env` は親プロセスの値より優先される。`vitest.integration.config.ts` は `vitest.config.ts` を `mergeConfig` などで**引き継がない**。引き継ぐと、ダミーURLと `KATANA_DB_TEST_MODE=unit` が runner の値を上書きする。
  - `.env` の場所は `process.cwd()` で決まる。runner はリポジトリのルート（`katana-web/`）から起動する前提にする。

**Step 3-4（静的監査）**

- 完了済みであることはユーザーの指示（Step 3-5Bの依頼）による。監査の内容・結果は、本ファイルにもcommitにも**記録が残っていない**。下のStep 3-4の節は当初の計画として残し、実装した仕様は3-4B・3-5Bの記録に書く。

**Step 3-4B（接続経路の静的検査）**

- 作成：`lib/testing/dbConnectionPaths.test.ts`（未追跡・未commit）。ソースを TypeScript Compiler API で構文解析するだけで、検査対象のモジュールはimportしない（このファイルのimportは `node:fs`・`node:path`・`typescript`・`vitest` だけ）。
- 規則1（`prisma-client-constructor`・`prisma-adapter-pg`・`pg-driver`）、規則2（`legacy-generated-prisma`）、`db-module-reexport`（`@/lib/prisma` と PrismaClient の再export）を実装した。許可リストは `lib/prisma.ts`・`prisma/seed.ts` の2件だけ（`lib/db/` のガードと `scripts/testdb*` は、今は接続を作らないので入れていない）。
- 検出できない書き方は、ファイル先頭のコメントに列挙している（文字列を組み立てたimport、宣言を経由しない取得など）。
- このStepのテストは63件（Step 3-5Bの時点で、規則1・2の部分だけを数えた件数）。実施時の実行結果は記録が残っていない。

**Step 3-5（統合テストのリネーム）**

- 5ファイルを `*.integration.test.ts` にリネームした。中身はHEADの旧ファイルとバイト単位で同じ（Step 3-5Bで `git show HEAD:… | cmp` により確認）。
- `git mv` ではなく、作業ツリーでの移動になっている（`git status` では、旧名が ` D`、新名が `??` と表示される）。add するまでGitはリネームとして扱わない。
- `vitest.config.ts` の `DB_INTEGRATION_TEST_FILES` は、設計（新しい名前に更新する）と違い、**削除した**。統合テストの除外は `**/*.integration.test.{ts,tsx}` だけで行う。
- `lib/dashboard/recentImports.authz.test.ts` の3行目のコメントが旧名のまま残っていた（Step 3-5Bで修正）。

**Step 3-5B（規則3・規則4の静的検査）**

- 変更：`lib/testing/dbConnectionPaths.test.ts`（規則3・4とテストを追加）、`lib/dashboard/recentImports.authz.test.ts`（3行目のコメントだけ）、本ファイル。
- **規則3（通常テストのPrismaモック）**：`*.integration.test.ts(x)` 以外のテストで、`@/lib/prisma`（lib/prisma に解決される相対パス・拡張子付きを含む。`vi.mock(import("…"))` の形も扱う）に対する次の書き方を違反にする。
  - `prisma-mock-without-factory`：factoryなしの `vi.mock`・`vi.doMock`
  - `prisma-import-original`：引数（importOriginal）を受け取るfactory（引数の名前は問わない）
  - `prisma-mock-unverifiable-factory`：関数式でないfactory（変数、`{ spy: true }` など）
  - `prisma-import-actual`：`vi.importActual`（factoryの中を含む）
  - `prisma-unmock`：`vi.unmock`・`vi.doUnmock`
  - `import { vi as v } from "vitest"` の別名も扱う。Prisma以外のモジュールへの `importActual`・`importOriginal` は対象外。
- **規則4（分類の整合性）**：
  - 各テストファイルから、ローカルのimport依存関係（静的import、`export … from`、文字列の `import()`・`require()`、`vi.importActual`・`vi.importMock`）をASTで辿り、DB接続モジュール（`lib/prisma.ts`、`prisma/seed.ts`、`pg`、`@prisma/adapter-pg`、`lib/generated/prisma`）に到達するかを判定する。型だけのimport・exportは辿らない。
  - テストファイルで、引数なしの関数式をfactoryにした `vi.mock` のモジュールは辿らない。`vi.importActual` は、そのモジュール自身だけ本物を辿り、その先のimportにはモックが効いたままとして扱う。自動モック、importOriginalを受け取るfactory、`vi.doMock`、`vi.unmock` したモジュールは、本物を辿る（安全側）。
  - 通常テストがDBに到達したら違反。統合テストの名前なのにDBに到達しなくても違反。既知の6ファイル（検査器の中の `KNOWN_DB_INTEGRATION_TEST_FILES`。Vitestの設定とは別）が、統合テストの名前で存在し、依存解析でもDBに到達することを確認する。
  - 件数：通常テスト24件、統合テスト6件（既知の6ファイルと一致）。
  - 静的に判定できない箇所（文字列以外の `import()`・`require()`・`vi.mock` のパス、解決できないローカルパス、`eval`・`createRequire`、テストファイル以外での `vi.mock`）は「未確認」として報告し、通常テストで1件でもあれば失敗させる。
  - 空振りの検出：`@/lib/prisma` をモックしている通常テスト（12件）は、モックを無視して解析すると、すべてDBに到達する。
  - `vitest.config.ts`：`test.exclude` が `[...configDefaults.exclude, "**/*.integration.test.{ts,tsx}"]` と完全に一致し、`DB_INTEGRATION_TEST_FILES` がなく、`setupFiles`・`globalSetup`・`projects`・`workspace` がない（依存解析の対象外になるため）。`include` は、ないか `["**/*.test.{ts,tsx}"]` だけを許可する。全テストファイルで、除外パターン（`path.posix.matchesGlob`）と命名規則による分類が一致し、`.spec.*`・`.test.js` などのファイルがない。
- **検出できない書き方:** パッケージ（node_modules）の中からローカルのファイルを読み込む経路、`@/*` 以外の別名、`/lib/prisma` のようなルートからの絶対パス（パッケージとして扱う）、規則1の検出できない書き方（ファイル先頭のコメント）。実行時に通らない分岐のimportも辿る（安全側の誤検出）。
- テスト：85件を追加し、ファイル全体で148件すべて成功（`npx vitest run lib/testing/dbConnectionPaths.test.ts` だけを実行）。内訳はリポジトリの走査13件、規則3のインメモリのテスト26件、規則4の依存解析38件、`vitest.config.ts` の検査8件。既存のファイルに違反コードを書き込む確認はしていない（インメモリのソースだけで確認した）。
- 検証結果：`npx tsc --noEmit` 成功。変更した2つのTypeScriptファイルの `eslint` 成功。`npx vitest list --filesOnly` は24件で、`*.integration.test.*` は0件。
- **未実施:** `npm test`・通常テスト全体の実行（Step 3-6）、統合テストの実行、DB・Dockerの操作、build。

**Step 3-6（最初の `npm test`）**

- `npm test` を2回実行し、2回とも成功した。通常テスト24ファイル、テスト519件が成功（失敗0件、スキップ0件）。
  - `lib/testing/dbConnectionPaths.test.ts`：148件成功。
  - `lib/db/testDatabaseGuard.test.ts`：74件成功。
- 統合テスト6ファイル（`*.integration.test.ts`）が実行対象から除外されていることを確認した。
- `npx tsc --noEmit` 成功、`eslint` 成功。
- **未実施・未検証:**
  - 実DBへの接続、Dockerの操作、統合テストの実行。
  - Prisma接続ガード（`lib/prisma.ts`）の実行時の検証（ガードが実際に `throw` すること、統合テストのモードで正しいURLが許可されること）。
  - build（R13）。
- 次のStepは **Step 3-7**。

**Step 3-7（統合テスト用runner・専用設定）**

- 作成（いずれも未追跡・未commit）:
  - `vitest.integration.config.ts`：`vitest.config.ts` を引き継がない独立した設定。`include: ["**/*.integration.test.{ts,tsx}"]`、`exclude: [...configDefaults.exclude]`、`globalSetup`、`fileParallelism: false`、`maxWorkers: 1`、`maxConcurrency: 1`、`sequence: { concurrent: false, shuffle: false }`、`passWithNoTests: false`、`testTimeout`・`hookTimeout` 30秒、`envDir: false`（Viteに `.env*` を読ませない）。`test.env` は設定しない。`@` の別名は明示的に設定した。
  - `scripts/test-integration.mts`（runner）：引数なしは通常実行モード、`--check` は確認モード。それ以外の引数は拒否する（Vitestへのオプションの受け渡しはしない）。runner自身にNodeのオプション（`process.execArgv`）があれば停止する。確認モードは、検証と設定の表示だけを行い、子プロセスを起動しない。通常実行モードは、`shell: false`・作業ディレクトリ `katana-web/` 固定で `node node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts` を起動する。
  - `lib/testing/integrationEnv.ts`：runnerとglobalSetupが共通で使う。`.env.test`・`.env` を `dotenv.parse` で読み（`process.env` は変えない）、子プロセスの環境変数を作り、`assertTestDatabaseTarget()` で検証する。設計の対象ファイル一覧にはないファイル。
  - `lib/testing/integrationGlobalSetup.ts`：runnerを経由した起動か（`KATANA_DB_TEST_MODE=integration` かつ `KATANA_TEST_RUNNER=script`）と、接続先をもう一度検証したうえで、**必ず `throw` して停止する**。接続後の照合と、データが残っていないかの読み取り確認は後続のStepで実装する。それまでは、テストファイルの読み込み・ワーカーの起動まで進まない。
- 変更（未commit）：`package.json`（`test:unit`・`test:integration`・`test:integration:check` を追加）、`tsconfig.json`（`allowImportingTsExtensions: true` を追加。Nodeが `.ts` を直接読み込むには拡張子付きのimportが必要なため。`noEmit: true` なので、TypeScriptの制約を満たす）。
- 子プロセスの環境変数：親からは許可リスト（`PATH`・`HOME`・`USER`・`LOGNAME`・`TMPDIR`・`TMP`・`TEMP`・`LANG`・`LC_*`・`TZ`・`TERM`・`COLORTERM`・`FORCE_COLOR`・`NO_COLOR`・`CI`）だけを引き継ぐ。`PG*`・`DOTENV_*`・`NODE_OPTIONS`・親の `DATABASE_URL` などはすべて落とす。`DATABASE_URL`（`.env.test` の値だけ）、`KATANA_DB_TEST_MODE=integration`、`KATANA_TEST_RUNNER=script`、`NODE_ENV=test` を設定する。親に `NODE_OPTIONS` があれば停止する。
- 表示：接続URL・パスワード・接続先は表示しない。検証に失敗したときは、エラーコード（例：`PORT_NOT_ALLOWED`）だけを表示する。
- 設計との違い:
  - globalSetupの接続後の照合（`pg` による `current_database()` などの照合）と、データ残留の読み取り確認は実装していない（後続のStepに分けた）。それまでは必ず停止する。
  - `lib/testing/integrationSetup.ts`（setupFiles）は作成していない（接続後の照合が必要なため）。ワーカーでは `lib/prisma.ts` のガードが働く。
  - runnerは接続先を表示しない（2-7のmigration用スクリプトは、パスワードなしで表示する設計）。
- 確認済み：`npx vitest list --config vitest.integration.config.ts --filesOnly` は統合テスト6件・通常テスト0件。通常の `npx vitest list --filesOnly` は24件・統合テスト0件。`--filesOnly` がglobalSetupを実行せず、テストファイルも読み込まないことは、Vitest 4.1.11のソースを読んで確かめた。`npm test` は24ファイル・519件成功。`dbConnectionPaths.test.ts` は148件成功（新しいファイルにも違反はなく、許可リストは変えていない）。`npx tsc --noEmit`・新規4ファイルの `eslint` 成功。
- Nodeが `.ts` を読み込むときに `MODULE_TYPELESS_PACKAGE_JSON` の警告が出る（`package.json` に `"type"` がないため）。動作には影響しない。

**Step 3-7B（runnerの確認モードの検証・`.env.test` のGit保護）**

- `.env.test` のGit保護：リポジトリのルート（`KatanaService/.gitignore` の36行目）の `.env*` で、すでに除外されていた（最初のcommit `251c511` から）。同等の設定があるので、`katana-web/.gitignore` には追加していない。`git check-ignore -v .env.test` で除外を確認した。
  - **Step 3-9への申し送り：** 同じ `.env*` で `.env.test.example` も除外される。Gitで管理するには、否定のパターン（`!.env.test.example`）などが必要。
- 確認モードの正常系：架空のパスワードを使った一時的な `.env.test`（`umask 077`、権限 `-rw-------`）を作り、`npm run test:integration:check` を実行した。終了コード0、接続先の検証に成功、子プロセスの環境変数（`DATABASE_URL` は伏せる）と起動コマンドを表示、統合テスト6件を表示。出力にパスワードと `postgresql://` は含まれなかった。終了後、一時的な `.env.test` だけを削除した。
- 異常系（確認モードで、`NODE_DEBUG=child_process` を付けて実行。`spawn` が呼ばれれば記録されることは、別の簡単なコマンドで確かめた）：`.env.test` がない、`DATABASE_URL` が未設定、パスワードがない、ポートが5433、DB名が `katana`、ユーザーが `katana`、`NODE_OPTIONS` を設定、runnerにNodeのオプション、未対応の引数（`--config x`・`--check --watch`・位置引数）で、すべて終了コード1で停止し、子プロセスは起動せず、パスワードやURLの全文は表示されなかった。
  - 開発用DBと同じ接続先：実際の `.env` の値をそのまま `.env.test` の値として純粋関数に渡すと拒否された（`PORT_NOT_ALLOWED`）。ホスト・ポート・DB名が開発用と同じ場合、文字列が同じ場合は、架空の値で `MATCHES_DEVELOPMENT_DATABASE` になることを確かめた。
  - 親の `PGHOST`・`DOTENV_CONFIG_PATH`・`DATABASE_URL` は、子プロセスの環境変数から取り除かれ、検証は成功する（2-2の設計どおり）。
- globalSetup：`pg`・Prisma Client を読み込まず、検証の後に無条件で `throw` し、迂回する分岐がないことをコードで確認した。Vitestでは、globalSetupが終わってから `pool.runTests` でワーカーを起動するため、テストファイルは読み込まれない（Vitestのソースを読んで確認）。
- テストファイルは追加していない。`npx tsc --noEmit`・`eslint`・`npm test`（24ファイル・519件）はすべて成功。
- **未実施・未検証:** runnerの通常実行モード（子プロセスに渡る環境変数と、globalSetupで停止することの実行時の確認）、実DBへの接続、統合テストの実行、Docker・Prisma CLI・migration・seed・build。
- 次のStepは **Step 3-8**。

全Stepに共通する事項:

- **個別の承認が必要な操作：** DBへの接続（読み取りを含む）、Dockerの操作（読み取り系を含む）、Prisma CLIの実行、migration、統合テストの実行。これらは操作ごとに承認を得る。
- **共通の停止条件：**
  - 5433番ポートや `katana` に接続しようとした形跡がある。
  - 開発用DBの記録が変わった。
  - 期待したファイル一覧と一致しない。
  - ガードや照合が失敗した。

  停止した場合は、原因を報告して指示を待つ。ガードを緩めて先へ進まない。
- 各Stepで変更するのは、記載したファイルだけにする。commitはユーザーが指示したときだけ行う。

### Step 3-0：読み取りだけの事前確認（実施済み。Dockerの記録は未記録）

- **作業内容:**
  1. 開発用DBの `_prisma_migrations`（`migration_name`・`checksum`・`finished_at`・`rolled_back_at`）を、`BEGIN READ ONLY` の中で `SELECT` し、1-5の8件のchecksumと照合する。
  2. Dockerの読み取り系コマンド（`docker context show`、`docker compose ls`、`docker volume ls`、`docker inspect katana-db`）で、Dockerのコンテキスト、開発用ボリュームの正確な名前、開発用コンテナの記録を取る。
- **変更対象ファイル:** なし（結果は報告する。PLANへの反映は別の承認を得てから行う）。
- **実施条件:** DBの読み取りとDockerの読み取りについて、それぞれ承認がある。
- **完了条件:** checksumの照合結果（一致・不一致・DBにだけある・ファイルにだけある）と、Dockerの情報が記録されている。
- **承認が必要な操作:** 開発用DBへの読み取り専用の接続、Dockerの読み取り系コマンド。
- **停止条件:** checksumが一致しない、またはDBとファイルの件数が違う → Step 3-1に進まず、報告する。

### Step 3-1：migrationをGitで管理する（M-A）（実施済み）

- **作業内容:** `.gitignore` から `prisma/migrations/` を削除し、7件を中身を変えずにaddする。
- **変更対象ファイル:** `.gitignore`、`prisma/migrations/` の7件（中身は変えない）。
- **実施条件:** Step 3-0でchecksumがすべて一致し、M-Aの実施について承認がある。
- **完了条件:** `git ls-files prisma/migrations` に8件と `migration_lock.toml` が並ぶ。中身に差分がない。
- **承認が必要な操作:** `git add`。commitは別に指示を受けてから行う。
- **停止条件:** 想定していないファイルが追加の対象になる。中身に差分が出る。

### Step 3-2：接続先の検証関数と単体テスト（実施済み）

- **作業内容:** 2-2の検証関数と、その単体テスト（DBを使わない）を作る。
- **変更対象ファイル:** `lib/db/testDatabaseGuard.ts`、`lib/db/testDatabaseGuard.test.ts`（どちらも新規）。
- **実施条件:** Phase 2の設計が承認されている。
- **完了条件:** 2-2の条件1〜10をすべて拒否し、正しいURLだけを通す。テストは、このファイルだけを指定して実行する。
- **承認が必要な操作:** なし（DBを使わない単体テストを、ファイルを指定して実行するだけ）。
- **停止条件:** テストが失敗する。

### Step 3-3：`lib/prisma.ts` へのガードの組み込みと、通常テストの設定（実施済み・未commit。buildは未実施）

- **作業内容:**
  - `lib/prisma.ts` の先頭に第1層のガードを置く。
  - `vitest.config.ts` に `include`・`exclude` とダミーの `DATABASE_URL` を設定する。
- **変更対象ファイル:** `lib/prisma.ts`、`vitest.config.ts`。
- **実施条件:** Step 3-2が完了している。
- **完了条件:**
  - `vitest list --filesOnly`（テストファイルを読み込まずに一覧だけ出す）に、DBに書き込む6件が含まれない。
  - `npx tsc --noEmit`・lint・`npm run build` が成功する。
- **承認が必要な操作:** なし（テストは実行しない）。
- **停止条件:** 一覧に6件のどれかが含まれる。buildが失敗する。

### Step 3-4：DB接続経路の静的検査（実施済み。3-4・3-4B・3-5Bに分けて実施。実装した仕様は3-Aの記録が正）

- **作業内容:** 2-4の静的検査を、DBを使わない単体テストとして作る。ソースを文字列として読むだけで、検査対象のモジュールはimportしない。
  - **検査対象:** `app/`・`actions/`・`lib/`・`data/`・`components/`・`prisma/`・`scripts/`（あれば）と、ルート直下の `*.ts`・`*.mts`。`node_modules/`・`.next/`・`lib/generated/` の中身は読まない。
  - **規則1（Prisma Client・DBドライバの生成）:** `new PrismaClient`、`new PrismaPg`、`from "pg"`・`require("pg")`、`from "@prisma/adapter-pg"` を、許可リストの外で使っていたら失敗させる。
    - 許可リスト：`lib/prisma.ts`、`prisma/seed.ts`、`lib/db/` の中のガード関連ファイル、`scripts/testdb*`（Step 3-7・3-8・3-9で作る予定。今はない）。
  - **規則2（古い生成物）:** `generated/prisma` をimportしていたら、場所に関係なく失敗させる（1-4のP5）。
  - **規則3（テストからの本物のPrisma）:** テストファイル（`*.test.ts(x)`）で次の書き方を検出したら失敗させる。
    - ファクトリなしの `vi.mock("@/lib/prisma")`（自動モックは本物のモジュールを評価する）。
    - `@/lib/prisma` に対する `importOriginal`・`vi.importActual`・`vi.unmock`・`vi.doUnmock`。
    - 例外：`*.integration.test.ts(x)`（0章の6ファイルは、Step 3-5でリネーム済み）。
    - 実装（Step 3-5B）：上記に加えて、関数式でないfactoryと `vi.doMock` も検査する。相対パス・拡張子付きのパスも扱う。詳細は3-Aの「Step 3-5B」。
  - **規則4（分類のずれ）:** 本物の `@/lib/prisma` などのDB接続モジュールに、モックされずに到達するテストファイルは、`*.integration.test.ts(x)` でなければ失敗させる。
    - 実装（Step 3-5B）：テストファイルからローカルのimport依存関係をASTで辿り、テストファイルの `vi.mock` を考慮して判定する（`testHelpers.ts` のような経由先も、依存解析で見つける）。統合テストの名前なのにDBに到達しないファイルも失敗させる。既知の6ファイルの一覧は、検査器の中だけに持つ。**`vitest.config.ts` の `DB_INTEGRATION_TEST_FILES` は使わない（Step 3-5で削除済み。復活させない）。** 静的に判定できない箇所は「未確認」として失敗させる。詳細は3-Aの「Step 3-5B」。
  - 既存の `lib/testing/historyReadPaths.test.ts` が、ファイルを走査する同じ書き方（`readdirSync` で走査し、`EXCLUDE` で除外）をしているので、それに合わせる。
  - 文字列の組み立てによるimportなどは検出できない（R6）。
  - 当初の完了条件にある「禁止した書き方を一時的に足して失敗を確かめる」は、Step 3-5Bでは、既存のファイルに書き込まず、インメモリのソースによるテストで代えた。
- **変更対象ファイル:** `lib/testing/dbConnectionPaths.test.ts`（新規。ファイル名は実装時に確定する）。ほかのファイルは変更しない（必要が判明したら報告して止まる）。
- **実施条件:** Step 3-3が完了している。
- **完了条件:**
  - 今のコードで成功する。
  - 規則ごとに、禁止した書き方を一時的に足すと失敗することを確かめる。確かめた後は元に戻し、`git status` と `git diff` で、変更対象のファイル以外に差分が残っていないことを確認する。
  - テストは、このファイルだけを指定して実行する（`npx vitest run lib/testing/dbConnectionPaths.test.ts`）。実行する前に、このファイルが `@/lib/prisma` などを読み込まないことを確かめる。
  - `npx tsc --noEmit` と、このファイルへの `eslint` が成功する。
- **承認が必要な操作:** なし（DBを使わない単体テストを、ファイルを指定して実行するだけ）。
- **停止条件:** 許可リストの外で、既存のコードが検出される → 報告して指示を待つ（検査を緩めて通さない）。

### Step 3-5：5ファイルのリネーム（実施済み・未commit）

- **作業内容:** 2-4の5ファイルを `git mv` でリネームする（中身は変えない）。`vitest.config.ts` の `DB_INTEGRATION_TEST_FILES` を新しいファイル名に更新する（3-Aの申し送り）。
  - 実施結果：`git mv` ではなく作業ツリーで移動した。`DB_INTEGRATION_TEST_FILES` は更新ではなく削除した。通常テスト24件は `vitest list --filesOnly` で確認済み（Step 3-5B）。統合テスト6件は、統合テスト用の設定がまだないので、静的検査で数えただけ。
- **変更対象ファイル:** 5ファイル、`vitest.config.ts`。
- **実施条件:** Step 3-4が完了している。
- **完了条件:** `vitest list --filesOnly` の結果が、通常テスト24件（既存22件、3-2の1件、3-4の1件）、統合テスト6件（統合テスト用の設定ができた後に確認する）になる。
- **承認が必要な操作:** なし。
- **停止条件:** 件数が一致しない。

### Step 3-6：最初の `npm test`（実施済み）

- **作業内容:** 通常テストを、ファイルを指定せずに初めて実行する。
- **変更対象ファイル:** なし。
- **実施条件:** Step 3-3〜3-5が完了し、承認がある。念のため開発用DBのコンテナを止めておくかどうかは、ユーザーが判断する。
- **完了条件:** 24件が成功し、統合テスト6件が含まれない。
- **承認が必要な操作:** `npm test` の実行。
- **停止条件:** 統合テストが実行対象に含まれている。DBに接続しようとした形跡がある。

### Step 3-7：統合テスト用の設定・globalSetup・runner

- **作業内容:** 2-2と2-3に従って、統合テスト用の設定、globalSetup（照合と読み取り確認だけで、削除はしない）、setupFiles、runnerを作る。`package.json` に `test:unit`・`test:integration` を追加する。
- **変更対象ファイル:** `vitest.integration.config.ts`、`lib/testing/integrationGlobalSetup.ts`、`lib/testing/integrationSetup.ts`、`scripts/test-integration.mts`（いずれも新規）、`package.json`。
- **実施条件:** Step 3-6が完了している。
- **完了条件:** 否定テストだけを行う：`.env.test` がない、開発用URLを設定、runnerを経由しない、の各場合に、DBへ接続する前に停止する。
- **承認が必要な操作:** 否定テストの実行（接続の前に停止することが前提）。
- **停止条件:** ガードより先に、接続を試みた形跡がある。

### Step 3-8：`prisma.config.ts` のガードとmigration用スクリプト

- **作業内容:** 2-7のガードと、`testdb-migrate` スクリプトを作る。
- **変更対象ファイル:** `prisma.config.ts`、`scripts/testdb-migrate.mts`（新規）、`package.json`。
- **実施条件:** Step 3-7が完了している。
- **完了条件:** 開発用URLを指定すると、Prisma CLIを起動する前に拒否される。Prisma CLIそのものは実行しない。
- **承認が必要な操作:** なし。
- **停止条件:** Prisma CLIが起動してしまう。

### Step 3-9：Compose定義とDockerのラッパー

- **作業内容:** 2-1・2-5に従って、Compose定義、初期化SQL、`.env.test.example`、`.gitignore` の変更、`testdb` ラッパー（`up`・`down`・`reset`）を作る。
- **変更対象ファイル:** `docker-compose.test.yml`、`docker/test-db/init/01-marker.sql`、`.env.test.example`、`scripts/testdb.mts`（いずれも新規）、`.gitignore`、`package.json`。
- **実施条件:** Step 3-8が完了している。
- **完了条件:** `config` による照合で、2-5の条件をすべて満たす。
- **承認が必要な操作:** `docker compose ... config` の実行（ファイルを解釈するだけで、コンテナは操作しない）。
- **停止条件:** プロジェクト名、ボリューム、ポート、開発用DBの文字列について、条件のどれかを満たさない。

### Step 3-10：`.env.test` の作成

- **作業内容:** ユーザーが `.env.test.example` をもとに `.env.test` を作る（パスワードはユーザーが決める）。
- **変更対象ファイル:** `.env.test`（ユーザーが作成し、Gitでは管理しない）。
- **実施条件:** Step 3-9が完了している。
- **完了条件:** runnerの事前検証を通る。`git status` に `.env.test` が出てこない。
- **承認が必要な操作:** なし（ユーザー自身が作業する）。
- **停止条件:** `.env.test` がGitの追跡対象として表示される。

### Step 3-11：テストDBの起動

- **作業内容:** `testdb:up` を実行し、2-5の操作前・操作後の確認を行う。
- **変更対象ファイル:** なし。
- **実施条件:** Step 3-10が完了し、承認がある。
- **完了条件:**
  - データの置き場所がtmpfsで、無名ボリュームがない。
  - ポートが `127.0.0.1:5434` である。
  - DBのコメントが一致する。
  - 開発用DBの記録が変わっていない。
- **承認が必要な操作:** Dockerの起動。
- **停止条件:** 操作前・操作後の確認のどれかが失敗する。5434番ポートが使われている。

### Step 3-12：テストDBへのmigrationの適用と、スキーマの照合

- **作業内容:** `testdb:migrate` を実行する。続けて、テストDBと `schema.prisma` の差分を `prisma migrate diff` で照合する（Prisma 7のオプションは、実施時に確認する）。
- **変更対象ファイル:** なし。
- **実施条件:** Step 3-1とStep 3-11が完了し、migrationの実行と `migrate diff` について、それぞれ承認がある。
- **完了条件:** 8件が適用済みで、差分がない。
- **承認が必要な操作:** migrationの実行、Prisma CLI（`migrate diff`）の実行。
- **停止条件:** 適用に失敗する。差分がある。接続先の表示が `127.0.0.1:5434/katana_test` ではない。

### Step 3-13：ドキュメント

- **作業内容:** `docs/TESTING.md` を作る（テストの実行方法、テストDBの用意、禁止事項）。本ファイルを更新する。CLAUDE.mdへの追記案を作る。
- **変更対象ファイル:** `docs/TESTING.md`（新規）、`docs/PLAN-test-db-isolation.md`。`CLAUDE.md` は提案だけにする。
- **実施条件:** Step 3-12が完了している。
- **完了条件:** ドキュメントの内容が、実装と一致している。
- **承認が必要な操作:** `CLAUDE.md` の変更。
- **停止条件:** なし。

統合テストを実際に動かすのは、Phase 4で行う。

---

## 4. Phase 4：検証（未着手）

**実施条件:** Phase 3が完了していること。統合テストの実行とE2Eの実行には、それぞれ承認を得ること。

**作業内容:**

1. **開発用DBに影響がないことの確認：** Phase 4の開始時と終了時に、開発用DBの件数を `BEGIN READ ONLY` で取得し、一致することを確かめる（承認が必要）。
   - 最後に確認した値（2026-10-23）：Product 21（ACTIVE 20・SOLD 1）、PriceHistory 26、ProductHistory 32、ImportJob 3、ImportRow 36、Shop 2、User 2、TEST-001はSOLD・13500000。
2. **ガードの確認：** 2-2の起動方法ごとの安全性の表を、実際に確かめる。
3. **通常テストの確認：** `npm test` が、統合テスト6件を含まずに成功する。
4. **専用DBでの統合テスト：** `test:integration` で6件が成功し、終了後にデータが残っていない。
5. **F-01のE2E：**
   - 次の条件で行う。
     - Next.jsの開発サーバーを、`127.0.0.1:3100`、テスト用の `DATABASE_URL`、テスト専用の `AUTH_SECRET`、`KATANA_DB_TARGET=test` で起動する。
     - テストごとに新しいブラウザのコンテキストを使う（K7への対策）。
     - データの用意と変更は、ガードを通したスクリプトで行う。
     - Playwrightを導入するには、事前に承認を得る。
   - 確認するシナリオ:

| ID | 流れ | 期待結果 |
|---|---|---|
| E2E-01 | 有効な店舗とユーザーでログインし、ダッシュボードを表示する → 専用DBで店舗を無効化 → 再アクセスする | 停止画面へ転送される。SOLD変更・CSV確定は「認証が必要です。」 |
| E2E-02 | E2E-01のセッションのまま店舗を再有効化 → ダッシュボードへアクセスする | 再ログインせずに表示できる |
| E2E-03 | 取り込み履歴のないユーザーでログイン → ユーザーを削除 → 再アクセスする | 停止画面へ転送され、手動ログアウトでログイン画面へ戻る（FKの `RESTRICT` のため、取り込み履歴のあるユーザーは削除できない） |
| E2E-04 | 店舗Aでログイン → DB上で所属を店舗Bへ変更 → 再アクセスする | 店舗Bのデータだけが表示される |
| E2E-05 | ADMINでログイン → DB上でSTOREへ変更する | 3つのActionとページはロールを参照していないので、確認できるのは「動作が変わらないこと」だけ |
| E2E-06 | ja・enそれぞれでログイン → 店舗無効化 → 停止画面 → 手動ログアウト | その言語のログイン画面へ着き、転送が無限に繰り返されない。共通ヘッダー・停止画面にユーザー名が出ない |

**完了条件:**

- 開発用DBの件数が、開始時と一致している。
- 結果が、成功・失敗・未実施を区別して報告されている。
- F-01の判定を、実環境での検証結果に基づいて更新できる状態になっている。

**禁止事項:** 開発用DBへの書き込み、ガードの回避、検証していない項目を検証済みと報告すること。

---

## 5. 未解決事項・残余リスク

| ID | 内容 | 状態・対応 |
|---|---|---|
| R1 | migrationを空のDBに適用できるか、`schema.prisma` と一致するか | 未検証（Step 3-12） |
| R2 | 開発用DBの `_prisma_migrations` と、手元のファイルのchecksumが一致するか | 解消（Step 3-0で一致を確認） |
| R3 | `KATANA_DB_TARGET=test` を設定せずにPrisma CLIを直接実行すると、開発用DBに接続する | 残余リスク（2-7）。運用ルールとCLAUDE.mdで対処する |
| R4 | `prisma/seed.ts` と Prisma Studio はガードの外にある | 範囲外 |
| R5 | `lib/generated/prisma/` が、Gitの除外対象なのに管理されたまま残っている | importは静的検査で防ぐ。整理は別タスク |
| R6 | 静的検査はASTの解析だが、文字列を組み立てたimport、パッケージ経由の読み込み、`@/*` 以外の別名などはすり抜けられる（3-Aの3-4B・3-5Bに一覧）。判定できない動的importなどは、規則4で「未確認」として失敗させる | 低。レビューで補う |
| R7 | tmpfsとイメージの `VOLUME` 宣言の関係 | 未検証（Step 3-11） |
| R8 | Node 25で `.mts` のスクリプトを動かせるか。Vitest 4の `test.env` と `.env.test` の扱い | `test.env` が親プロセスの値を上書きすることは、Step 3-3でソースを読んで確認済み。`.mts` のrunnerがNode 25でそのまま動くことは、Step 3-7Bの確認モードで確認済み。統合テスト用の設定は `envDir: false` でViteに `.env*` を読ませない（通常実行モードでの確認は未実施） |
| R12 | Step 3-0で取得したDockerの記録（コンテキスト・ボリューム名・`katana-db`）が残っていない | Step 3-9の前に、承認を得て取得し直す（3-A） |
| R13 | Step 3-3の完了条件の `npm run build` を実施していない | DBに接続しないことを確認できる方法が見つかるまで保留。Phase 4までに実施する |
| R9 | テストが途中で落ちた後は、`testdb:reset` が必要になる | 利便性の問題であり、安全性の問題ではない |
| R10 | ガードのコードそのものを書き換えられると防げない | CLAUDE.mdとレビューで対処する |
| R11 | 開発用DBの認証情報が `docker-compose.yml` に直接書かれている | 範囲外 |

---

## 次のセッションで最初に行うこと

1. `CLAUDE.md` と本ファイルを読む。特に「全Phase共通の禁止事項」、3章の「3-A. 実施結果」、これから行うStepの節を読む。
2. `git branch --show-current`、`git status --short`、`git log -1 --oneline` で状態を確認し、次の想定と一致するかを確かめる。一致しなければ、作業を始めずに報告する。
   - ブランチ：`chore/test-db-isolation`
   - HEAD：`824d54b`（`test: isolate unit and integration database access`。Step 3-3〜3-6の変更をまとめたもの）
   - 変更済み（Step 3-7・3-7B。未commit）：`docs/PLAN-test-db-isolation.md`、`package.json`、`tsconfig.json`
   - 未追跡（Step 3-7。未commit）：`vitest.integration.config.ts`、`scripts/test-integration.mts`、`lib/testing/integrationEnv.ts`、`lib/testing/integrationGlobalSetup.ts`
   - 未追跡（commitの対象外）：`docs/presentations/KatanaService_プロジェクト構成.pptx`、`test-data/`
   - `.env.test` は存在しない（Step 3-7Bの一時ファイルは削除済み）
3. 次は **Step 3-8（`prisma.config.ts` のガードとmigration用スクリプト）**。Step 3-7の変更を先にcommitするかを、始める前にユーザーに確認する。指示されたStep以外には着手しない。
4. Stepが終わったら報告し、ユーザーの確認を得たうえで、次の2つを更新してからセッションを終える。
   - 3章の「3-A. 実施結果」（結果、設計との違い、未検証の事項、次のStepへの申し送り）
   - 本節の手順2の想定と、手順3の次のStep
