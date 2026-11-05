# 計画：専用テストDBの構築とVitest統合テストの分離

作成日: 2026-10-26
更新日: 2026-11-04（Step 3-8Bのcommit `d56c8e4`、R12のDockerの読み取り調査、Step 3-9・3-9B（テストDBの構成ファイルとDockerのラッパー。`docker compose config` による照合まで）の実施結果と、そのcommit `61f8105`、Step 3-9C（R14のパスワード検証の共通化）の実施結果とcommit `4553f2f`、Step 3-9D（ラッパーの `up`・`down` の実装と、障害時の down のレビュー。実際の起動・停止は未実施）の実施結果とcommit `5fcc259`、Step 3-10の実施前レビュー、Step 3-10A（tmpfs の判定の修正と、migration の前後の検査の設計判断）の結果とcommit `8471705`、Step 3-10B（migration の前後のDBの状態の判定の実装。単体テストのみ）の結果とcommit `daf5c8b`、Step 3-10C（`testdb-migrate` への状態の判定の組み込み。単体テストのみ。強制停止は維持）の結果とcommit `92ba359`、Step 3-11の実施前レビュー（初回の Docker 起動の前の安全性レビュー。Docker は読み取りだけで、デーモンは停止中）の結果、Step 3-11A（Docker Desktop の起動後の読み取り専用の確認と、初期化スクリプトのパスワード漏洩の対策）の結果を反映）
作業ブランチ: `chore/test-db-isolation`（`fix-dashboard` の `6168889` から作成）

## 状態

| Phase | 状態 |
|---|---|
| Phase 1：読み取り専用の調査 | **実施済み**（結果は本ファイルの1章） |
| Phase 2：安全設計 | **設計レビュー完了**（確定設計は本ファイルの2章） |
| Phase 3：実装 | **実施中**（Step 3-0〜3-8B 実施済み。Step 3-3〜3-6は `824d54b`、Step 3-7・3-7Bは `d087712`、Step 3-8A（接続後の本人確認と空DB検査）は `4b788e7` でcommit。Step 3-8B（当初の3-8：`prisma.config.ts` のガードとmigration用スクリプト）は `d56c8e4` でcommit。Step 3-9（テストDBの構成ファイル）とStep 3-9B（Dockerのラッパー `scripts/testdb.mts` の `--check`・`--status`と、`docker compose config` による照合。架空の一時的な `.env.test` で、全項目が一致）は実施済みで、`61f8105` でcommit。Step 3-9C（R14のパスワード検証を共通の関数にまとめ、4つの経路に適用）は実施済みで、`4553f2f` でcommit。Step 3-9D（ラッパーの `--up`・`--down`。`--apply` があるときだけ変更操作を行う）は、実装・単体テスト・静的検証と障害時の down のレビューまで実施し、`5fcc259` でcommit。Step 3-10の実施前レビュー（Dockerの読み取り専用の調査を含む）と、Step 3-10A（tmpfs の判定の修正と、migration の前後の検査の設計判断）を実施し、`8471705` でcommit。Step 3-10B（DBの状態 A・B・C の読み取り専用の判定と、`pg` の許可リストの追加。単体テストのみ）を実装し、`daf5c8b` でcommit。Step 3-10C（`testdb-migrate` への組み込み。実DBへの接続の許可は固定で無効のまま）を実装し、最終の安全性レビューの後に `92ba359` でcommit。Step 3-11の実施前レビュー（コードの変更なし。起動前の条件・R7 の検証手順・起動失敗時の対処・読み取り専用のDB検証の計画・TOCTOU の方針を記録）を実施。Step 3-11A（Docker Desktop の起動後の読み取り専用の確認と、`01-app-role.sh` のログ漏洩の対策・静的テスト）を実施し、`test: protect test database initialization secrets` でcommit。`reset` は未実装。**コンテナの起動・停止とDBへの接続は、一度も行っていない。** 結果は3章の「3-A. 実施結果」） |
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

### 3-A. 実施結果（2026-11-04時点）

| Step | 状態 | commit |
|---|---|---|
| 3-0 | 実施済み（Dockerの記録は、Step 3-9で取り直した。下記） | なし |
| 3-1 | 実施済み | `3dcfbb3` |
| 3-2 | 完了 | `3f0c710` |
| 3-3 | 完了（buildは未実施） | `824d54b`（Step 3-6の後処理でcommit。`test: isolate unit and integration database access`） |
| 3-4 | 静的監査完了 | 記録なし（下記） |
| 3-4B | 接続経路の静的検査（規則1・2）完了 | `824d54b` |
| 3-5 | 統合テストのリネーム完了 | `824d54b` |
| 3-5B | 規則3・4の静的検査とPLANの更新を実施 | `824d54b` |
| 3-6 | 完了（`npm test` を2回実行し、すべて成功） | `824d54b`（PLANの更新を含む） |
| 3-7 | 統合テスト用runner・専用設定の作成完了（globalSetupは意図的に必ず停止） | `d087712`（`test: add fail-closed integration test runner`） |
| 3-7B | runnerの確認モードの検証・`.env.test` のGit保護の確認 | `d087712`（変更はPLANだけ） |
| 3-8A | ユーザーの指示により、接続後の本人確認と空DB検査を実装（DB非接続の単体テストのみ。実DBでの動作確認と、globalSetupへの組み込みは**未実施**） | `4b788e7`（`test: add integration database identity and empty checks`） |
| 3-8B | 当初の3-8：`prisma.config.ts` のガードとテストDB専用migrationスクリプト（DB非接続の単体テスト、静的検証、`prisma validate` による設定読み込みの検証。実DBへの接続・`migrate deploy` は未実施。通常実行モードは、接続後の本人確認が未実装のため必ず停止する） | `d56c8e4`（`test: guard Prisma CLI and add test DB migration runner`） |
| 3-9 | テストDBの構成ファイル（Compose定義・初期化スクリプト・`.env.test.example`・`.gitignore`）の作成と静的検証。R12のDockerの読み取り調査 | `61f8105`（`test: add isolated PostgreSQL test environment`。3-9Bと同じcommit） |
| 3-9B | Dockerのラッパー `scripts/testdb.mts`（`--check`・`--status`。読み取り専用）、R14・R15の対策、`docker compose config` による照合（架空の一時的な `.env.test` で実施）。`up`・`down`・`reset` は**未実装**（コンテナの起動・DBへの接続は一度も行っていない） | `61f8105`（`test: add isolated PostgreSQL test environment`） |
| 3-9C | R14のパスワード検証の共通化（`assertTestDatabaseCredentials()`。Dockerのラッパー・統合テストのrunner・migration用スクリプト・Prisma CLIのテストDBモードに適用）。DB非接続の単体テストと、3つの確認モードの実行による回帰確認。R14は**一部が残る** | `4553f2f`（`test: centralize test database credential validation`） |
| 3-9D | Dockerのラッパーの `--up`・`--down`（`--apply` があるときだけ変更操作）。操作前・操作後の確認、障害時（starting・unhealthy・exited・up の失敗後）の down のレビューと、Compose のラベルの照合の追加。単体テスト、静的検証。**実際の `up`・`down` は実行していない**。R7 は未検証。`reset` は未実装 | `5fcc259`（`test: add guarded test database up and down commands`） |
| 3-10A | tmpfs の判定の修正（`Mounts`・`HostConfig.Mounts`・`HostConfig.Tmpfs` のどの表し方でも、データ領域の tmpfs と初期化用の bind だけを許可する）。up の後と down の前の両方に適用。migration の前と後の検査の分け方を記録。**実際の `up`・`down`・DBへの接続は行っていない** | `8471705`（`test: validate test database tmpfs mounts safely`。Step 3-10の実施前レビューの記録も含む） |
| 3-10B | migration の前後のDBの状態（A：完全に空、B：途中まで適用・不整合、C：全件適用済み）の読み取り専用の判定（`lib/testing/testDbState.ts`）と、`pg` を読み込む1ファイル（`lib/testing/testDbConnection.ts`）の追加。DB非接続の単体テスト。**`testdb-migrate`・globalSetup への組み込みと、実DBへの接続は行っていない**（どちらも強制停止のまま）。commit の前のカタログ検査のレビューで、`pg_am`・`pg_transform` の検査漏れを直した | `daf5c8b`（`test: classify test database migration states safely`） |
| 3-10C | `testdb-migrate` への状態の判定の組み込み（A なら `migrate deploy` の後に別の接続で C を再確認、B は停止、C は Prisma CLI を起動せずに成功）、親のプロセスの `PG*`・`DOTENV_*` の拒否、状態の判定の search_path の固定。DB非接続の単体テスト。**スクリプトの実DBへの接続の許可は固定で無効**（`TESTDB_MIGRATION_LIVE_DISABLED`）。globalSetup は未変更。commit の前の最終の安全性レビューで、問題は見つからなかった | `92ba359`（`test: integrate guarded migration state checks`。親は `daf5c8b`。通常テスト1065件成功、静的検査152件・違反0件） |
| 3-11 実施前レビュー | 初回の Docker 起動の前の安全性レビュー（コードは変更なし。Docker は読み取りだけ。**Docker のデーモンが停止中で、デーモンが必要な確認はできなかった**）。起動前の条件、R7 の検証手順、起動失敗時の対処、読み取り専用のDB検証の計画、TOCTOU の方針を記録 | なし（PLANの更新だけ。未commit） |
| 3-11A | Docker Desktop の起動後の読み取り専用の確認（記録とすべて一致。テスト用のコンテナ・ボリュームなし、5434番は空き）と、初期化スクリプトのパスワード漏洩の対策（`01-app-role.sh` の最小限の修正と、静的テスト `scripts/testdb-init.test.ts` の追加。通常テスト1076件成功）。実際の初期化・R7・DB接続は未実施 | `test: protect test database initialization secrets`（通常テスト32ファイル・1076件成功、静的検査152件・違反0件。hash は commit の後に記入） |

**commitの状態：** Step 3-3〜3-6の変更（本ファイルを含む）は、Step 3-6の後処理で1つのcommit `824d54b`（`test: isolate unit and integration database access`）にまとめた。5ファイルのリネームもこのcommitに含む。各Stepの記録にある「未commit」「未追跡」は、記録した時点の状態。期待する `git status` は末尾の節。

**実際のDB接続による検証は、まだ1回も行っていない：** ガードの `throw`、統合テストのモードでの許可、静的検査の判定が実際の実行と一致することは、どれも静的な確認とDBを使わない単体テストだけで確かめている。

**Step 3-0**

- checksum：開発用DBの `_prisma_migrations` と手元の8件のSHA-256が一致した（`3dcfbb3` のcommitメッセージに記録）。R2は解消。
- Dockerの記録（`docker context show` の値、開発用ボリュームの正確な名前、`katana-db` の記録）：Step 3-0の記録は残っていない。**Step 3-9で、承認を得て読み取り系コマンドで取得し直した**（3-9の記録の「R12」）。

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
- 規則1（`prisma-client-constructor`・`prisma-adapter-pg`・`pg-driver`）、規則2（`legacy-generated-prisma`）、`db-module-reexport`（`@/lib/prisma` と PrismaClient の再export）を実装した。許可リストは `lib/prisma.ts`・`prisma/seed.ts` の2件だけ（`lib/db/` のガードと `scripts/testdb*` は、今は接続を作らないので入れていない）。→ Step 3-10B で、`pg` だけを許可するファイル `lib/testing/testDbConnection.ts` を1件追加した（3-Aの3-10B）。
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

**Step 3-8A（接続後の本人確認と空DB検査。ユーザーの指示による。`4b788e7` でcommit）**

- 下の「Step 3-8」の節（`prisma.config.ts` のガードとmigration用スクリプト）とは内容が違う。ユーザーの指示で、2-2の接続後の照合と2-3の開始前の読み取り確認を先に実装した。当初の3-8の作業は、Step 3-8Bで実施した。
- 以下の「未追跡・未commit」「未commit」は記録した時点の状態。すべて `4b788e7` に含まれる。
- 作成（未追跡・未commit）:
  - `lib/testing/integrationDatabaseCheck.ts`：`verifyIntegrationDatabase()`。DBドライバを読み込まず、接続は `connect`（pg.Client 互換の `query`・`end`）として呼び出し側が渡す。
  - `lib/testing/integrationDatabaseCheck.test.ts`：偽のクライアントによる単体テスト54件（pg・Prisma Client は読み込まない）。
- 変更（未commit）：`lib/testing/integrationGlobalSetup.ts`（コメントだけ。**必ず停止する動作は変えていない**。新しいモジュールはまだ呼ばない）、`lib/testing/dbConnectionPaths.test.ts`（通常テストの期待件数を24→25に変更。許可リスト・規則は変えていない）。
- 実行順序：(1〜3) `assertIntegrationProcessEnv()` でrunner経由の起動・URLの形式・開発用DBとの比較 → (4) 接続を1回だけ（失敗しても別の接続先を試さない） → `BEGIN READ ONLY` と `SHOW transaction_read_only = on` の確認 → (5) 本人確認 → (6) リレーションの構成とmigrationの確認 → (7) 空DB検査 → `ROLLBACK`。接続した後は、成功・失敗にかかわらず必ず `end()` する。最初の失敗を優先して投げる。
- 本人確認：`current_database() = katana_test`、`current_user`・`session_user` がともに `katana_test_user`、DBのコメント（`shobj_description`）が `katana-test-db`（2-1のマーカー）。`inet_server_port()` は情報として返すだけで、判定には使わない（サーバー内部のポートは5432が普通で、公開ポート5434とは違う）。
- テーブル構成：`schema.prisma` のモデル15件（`@map`・`@@map`・`@@schema` がないので、モデル名＝テーブル名。あれば拒否する）と、migrationの最終形の15テーブルが一致することを確認した（`Katana` などの旧テーブルは0718・0922で削除）。`pg_catalog.pg_class` から、システム以外の全スキーマのテーブル・ビュー・マテリアライズドビュー・外部テーブルを取得し、`public` の想定15テーブルと `_prisma_migrations` だけであることを確かめる。不足・想定外（暗黙の多対多 `_AToB`、ビュー、別スキーマを含む）は拒否する。
- migration：`_prisma_migrations` の適用済みの名前が、`prisma/migrations` の8件と完全に一致し、未完了・失敗・ロールバック・重複が1件もないこと。migrationは行を挿入しないので、適用直後のDBは空になる想定。
- 空DB検査：想定の15テーブルごとに `SELECT EXISTS (SELECT 1 FROM "public"."<table>")`。テーブル名は、識別子の文字種（`[A-Za-z_][A-Za-z0-9_]*`）を検証してから二重引用符で囲む（スキーマとカタログで照合済みの名前だけを使う）。1件でもあれば `DATA_PRESENT` で拒否し、行は削除しない。`_prisma_migrations` は対象外。
- 例外：`IntegrationDatabaseCheckError`（`code` 付き）。接続URL・パスワード・ドライバの元のエラーメッセージは含めず、SQLSTATE などのコードだけを含める。本人確認の失敗では、実際の値を表示しない。
- 限界：SQLで確かめられるのは、サーバーが返す名前とDBのコメントだけで、物理的にどのサーバー・コンテナかまでは保証できない（コメントは誰でも同じものを付けられる）。URLの検証（`127.0.0.1:5434` だけ）と組み合わせて判断する。列の定義までの照合はしない（Step 3-12の `migrate diff` で行う）。
- 確認済み：新しい単体テスト54件すべて成功。`npx tsc --noEmit`・変更した4ファイルの `eslint` 成功。`npm test` は25ファイル・573件成功（Step 3-7の519件＋54件）。`npx vitest list --filesOnly` は25件で、`*.integration.test.*` は0件。統合テスト用の設定は6件。`dbConnectionPaths.test.ts` は148件成功。
- **globalSetupに組み込むときの申し送り:**
  - 実際の接続には `pg` が必要。静的検査の規則1は `pg` を `lib/prisma.ts`・`prisma/seed.ts` 以外で禁止しているので、`lib/testing/integrationGlobalSetup.ts` の1ファイルだけを許可リストに足す（ディレクトリ単位では許可しない）か、`lib/prisma.ts` 経由で照合するかを、その時に決める。安全条件は「`verifyIntegrationDatabase()` の中で、接続前の検証に通った後にだけ `connect` が呼ばれること」。
  - 強制停止の `throw` を外すのは、DBへの接続の承認を得たStepで行う。
- **未実施・未検証:** 実DBに対する本人確認・空DB検査（SQLが実際のPostgreSQL 15で期待どおりに動くこと、`shobj_description`・`pg_class` の読み取り権限）、Docker・Prisma CLI・migration・seed・build、統合テストの実行、runnerの通常実行モード。

**Step 3-8B（当初の3-8：`prisma.config.ts` のガードとテストDB専用migrationスクリプト）**

- 作成（いずれも未追跡・未commit）:
  - `lib/db/prismaCliGuard.ts`：`resolvePrismaCliDatabaseTarget()`。`prisma.config.ts` から呼ぶ純粋関数。`.env.test`・`.env` の読み込みは関数として受け取り、テストDBモードのときだけ呼ぶ。
  - `lib/db/prismaCliGuard.test.ts`：37件。`prisma.config.ts` は読み込まず、ソースを文字列として確かめるだけ。
  - `lib/testing/testDbMigrate.ts`：`runTestDbMigrate()`。migrationの手順の本体。ファイルの読み込み、存在確認、接続後の本人確認、子プロセスの起動、表示は、すべて引数で受け取る。
  - `lib/testing/testDbMigrate.test.ts`：28件。偽の関数を使うので、Prisma CLIは起動せず、DBにも接続しない。
  - `scripts/testdb-migrate.mts`：実際の入出力をつなぐだけの薄いスクリプト。
- 変更（未commit）:
  - `prisma.config.ts`
  - `package.json`：`testdb:migrate`・`testdb:migrate:check` を追加。
  - `lib/testing/integrationEnv.ts`：許可リストで環境変数を引き継ぐ処理を、`inheritAllowedEnv()` として切り出した。runnerの子プロセスに渡す環境変数と、落とす変数の一覧は変わらない。
  - `lib/testing/dbConnectionPaths.test.ts`：通常テストの期待件数を25件から27件にした。許可リストと規則は変えていない。
- **`prisma.config.ts` のガード**（`import "dotenv/config"` の後、`defineConfig` の前に、モジュールの読み込み時に実行する）:
  - `KATANA_DB_TARGET` が未設定のとき：これまでどおり `env("DATABASE_URL")` を使う。`.env.test`・`.env` は読まない。
    - 例外として、`DATABASE_URL` がテストDBに見える場合は拒否する（`TEST_URL_WITHOUT_TEST_TARGET`）。テストDBに見えるとは、次のどれかに当てはまること：DB名が `katana_test`、ユーザーが `katana_test_user`、ループバックのホストでポートが5434。
    - URLを解析できない場合や、ほかの接続先の場合は、これまでどおりの動作になる。
  - `KATANA_DB_TARGET=test` のとき：
    1. `NODE_OPTIONS` と、`dotenv_config_*=` の形のコマンドライン引数がないことを確かめる。
    2. 作業ディレクトリの `.env.test` を読む。ない場合は `TEST_ENV_MISSING`。
    3. `.env.test` の `DATABASE_URL` を `assertTestDatabaseTarget()` で検証する。環境変数の検査は、dotenvが読み込んだ後の `process.env` に対して行い、開発用DBとの比較には `.env` の値を使う。
    4. プロセスの `DATABASE_URL` が、検証済みの値と完全に一致することを確かめる（`DATABASE_URL_MISMATCH`）。一致しない例は、dotenvが `.env` の開発用URLを補った場合や、未設定の場合。
    5. ここまですべて通ったら、検証済みの値を使う。テストDBモードから開発用のURLに切り替える分岐はない。
  - `KATANA_DB_TARGET` がそれ以外の値（空文字・`TEST` など）のとき：拒否する（`TARGET_INVALID`）。
  - エラー（`PrismaCliGuardError`）には、エラーコードだけを含める。URL・パスワード・拒否した値は含めない。
  - Prisma 7.2.0の仕組み（ソースで確認済み）：Prisma CLIは、設定ファイルをc12/jitiで読み込む（`dotenv: false`）。設定ファイルで例外が出ると、`Failed to load config file … Error: ${error}` を表示して終了コード1で終わり、既定の設定に戻ることはない。Prisma CLIは `.env` を自動では読まない。
- **migrationスクリプトの実行順序**（途中で失敗したら、その時点で止める）:
  1. 引数：なし、または `--check` だけを受け付ける。
  2. Nodeの起動オプション：`process.execArgv` が空で、`NODE_OPTIONS` が設定されていないこと。
  3. `.env.test` を読む。
  4. `.env` から開発用DBのURLを取得する。
  5. URLを検証する。
  6. 子プロセスの環境変数を作り、完成した環境変数でもう一度検証する。
  7. Prisma CLIの本体・`prisma.config.ts`・`schema.prisma`・`prisma/migrations` があることを確かめる。確認モードは、ここで表示して終了する。
  8. 接続後の本人確認（2-7の4）。
  9. すべて成功した場合だけ、子プロセスを起動する。
- コマンドは `node node_modules/prisma/build/index.js migrate deploy --config <root>/prisma.config.ts` に固定した。`shell: false`、作業ディレクトリは `katana-web/`。外部から引数を渡す経路はない。`migrate deploy` を選んだ理由：未適用のmigrationを適用するだけで、DBの作り直し・Prisma Clientの生成・seedを行わないため。
- 子プロセスの環境変数：
  - 親から引き継ぐのは、runnerと同じ許可リストの変数（`PATH`・`HOME`・`LC_*` など）だけ。
  - それに、検証済みの `DATABASE_URL` と `KATANA_DB_TARGET=test` を加える。
  - 引き継がないもの：`PG*`・`DOTENV_*`・`NODE_OPTIONS`・`PRISMA_*`・親の `DATABASE_URL`・`KATANA_*`。`NODE_ENV` も設定しない。
- 確認モード（`npm run testdb:migrate:check`）：表示するのは、次の5つ。DATABASE_URLの全文とパスワードは表示しない。
  - 検証に通った接続先（`127.0.0.1:5434/katana_test`、ユーザー `katana_test_user`。2-7の3）
  - 作業ディレクトリ
  - 実行する予定のコマンド
  - 子プロセスの環境変数（`DATABASE_URL` は伏せる）
  - 親から落とした主な変数の名前

  本人確認と子プロセスの起動は行わない。
- **設計との違い:**
  - 2-7の4（DBのコメントの照合）は、DBへの接続が必要なため実装していない。スクリプトは、本人確認の関数として、必ず `IDENTITY_CHECK_NOT_IMPLEMENTED` を投げる仮の関数を渡している。そのため、**`npm run testdb:migrate` の通常実行モードは、Prisma CLIを起動する前に必ず停止する**（runnerのglobalSetupと同じく、安全側に倒した形）。→ Step 3-10C で、仮の関数を、実DBへの接続の許可（固定で無効。`TESTDB_MIGRATION_LIVE_DISABLED`）に置き換えた。停止する位置（すべての検証の後、接続と Prisma CLI の起動の前）は同じ。
  - 次の2つは、設計（2-7）にはなかった拒否条件として追加した：テストモードなしでテストDBに見えるURLを使う場合（`TEST_URL_WITHOUT_TEST_TARGET`）と、`KATANA_DB_TARGET` が `test` 以外の値の場合（`TARGET_INVALID`）。
  - 静的検査の許可リスト（2-4・3-4）には、`scripts/testdb*` を加えていない。このスクリプトは `pg` もPrisma Clientも読み込まないため。
- 確認済み:
  - `npx tsc --noEmit` と、変更した8ファイルの `eslint` が成功した。
  - 新しい単体テストは65件（37件＋28件）がすべて成功した。`dbConnectionPaths.test.ts` も148件成功し、違反は0件。
  - `npm test` は27ファイル・638件が成功した（573件＋65件）。
  - `npx vitest list --filesOnly` は27件で、`*.integration.test.*` は0件。統合テスト用の設定では6件。
  - 確認モードを `NODE_DEBUG=child_process` を付けて実行した（`.env.test` はない状態）。次のどの場合も終了コード1で止まり、スクリプトは子プロセスを起動しなかった（記録された `spawn` は、npm自身が起動した `sh -c` だけ）：`.env.test` がない（`TEST_ENV_MISSING`）、未対応の引数（`ARGUMENTS_INVALID`）、`NODE_OPTIONS` がある、Nodeの起動オプションがある。
- **残る迂回の経路（R3）:** 次のどれかを直接実行すると、テストDB用のガードを通らない。
  - `KATANA_DB_TARGET` を付けない、`npx prisma …` の直接実行。`migrate reset`・`db push`・`studio` なども含む。これまでどおり `.env` の開発用DBに接続する。ただし、`DATABASE_URL` がテストDBに見える場合は拒否される。
  - `--config` で別の設定ファイルを指定する。
  - `prisma/seed.ts` の実行（R4）。
  - URLを直接受け取るCLIのオプション（`db execute --url` など。Prisma 7で残っているオプションは未確認）。

  `KATANA_DB_TARGET=test` を付けて、テストDBのURLを明示的に設定すれば、`migrate deploy` 以外のコマンド（`migrate reset` など）もテストDBに対して実行できる。ただし、接続先はテストDBに限られる。対策は、これまでどおり運用ルールとCLAUDE.mdへの明記（2-7）。
- **Prisma CLIによる設定読み込みの検証（ユーザーの承認を得て実施。実行したPrisma CLIのコマンドは `validate` だけ）:**
  - 実行方法：ローカルのCLI（`./node_modules/.bin/prisma`。npxは使わない）を、作業ディレクトリ `katana-web/` で実行した。毎回 `env -i PATH="$PATH" HOME="$HOME"` で環境変数を空にし、接続先はすべて架空の値にした。`prisma validate` は、スキーマの読み込み・lint・検証・DMMFの生成だけを行い、接続先のURLを使わない（CLIのソースで確認）。
  - 通常モード（`KATANA_DB_TARGET` なし。接続できないダミーのURL）：終了コード0。`Loaded Prisma config from prisma.config.ts.` と `The schema at prisma/schema.prisma is valid` が表示された。jitiが、拡張子付きの相対importと `import { type … }` を処理できることを確認した。実行の前後で、`git status --ignored` と `git diff` のハッシュは変わらなかった。
  - 通常モードで、テストDBに見えるURL（`katana_test_user@127.0.0.1:5434/katana_test`）を指定した場合：終了コード1。エラーは `TEST_URL_WITHOUT_TEST_TARGET`で、スキーマの処理には進まなかった。
  - テストモード（`KATANA_DB_TARGET=test`）：一時的な `.env.test`（`umask 077`、権限 `-rw-------`、架空の認証情報）を作って実行した。
    - プロセスの `DATABASE_URL` が `.env.test` の値と完全に一致し、PG*・DOTENV_*・NODE_OPTIONS がない場合：終了コード0で、設定の読み込みとスキーマの検証に成功した。
    - プロセスの `DATABASE_URL` だけを別の値にした場合：終了コード1。エラーは `DATABASE_URL_MISMATCH` で、スキーマの処理には進まなかった。
  - migrationの確認モード（同じ一時的な `.env.test` がある状態で `npm run testdb:migrate:check`。`NODE_DEBUG=child_process` 付き）：終了コード0。
    - 接続先は `127.0.0.1:5434/katana_test`（ユーザー `katana_test_user`）として検証に通った。
    - 予定のコマンドは `node node_modules/prisma/build/index.js migrate deploy --config prisma.config.ts (no shell)` と表示された。
    - 子プロセスの環境変数は、許可リストの変数・`DATABASE_URL=(hidden)`・`KATANA_DB_TARGET=test` だけだった。
    - 記録された `spawn` は、npm自身の `sh -c` だけだった。
  - すべての出力で、パスワード・`postgresql://`・URLの全文が0件であることを確かめた。一時的な `.env.test` は、検証の後に削除した。`.env`・`.env.local` のハッシュは、実行の前後で変わらなかった。
  - 表示の小さな問題（変更していない）：設定の読み込みに失敗したとき、Prismaが表示するパスが、ファイルではなくディレクトリ（`…/katana-web`）になる。Prismaが、エラーメッセージの中の `prisma.config.<拡張子>` という文字列からファイル名を推定しているため。動作には影響しない。
  - 実行中に、CLIが「Update available 7.2.0 -> 8.0.0-rc.29」と表示した。Prisma CLIは、更新の確認などで外部と通信する（DBへの接続ではない）。
- 通常テスト：`npm test` は27ファイル・638件すべて成功（記録は上の「確認済み」）。
- **未実施・未検証:**
  - 実DBへの接続。`migrate deploy` の実際の適用（Step 3-12）。
  - 接続後のDBの本人確認（2-7の4）。**未実装**。通常実行モードは必ず停止する。
  - `.env` から `DATABASE_URL` を補う、いつもの開発用の操作（`generate`・`migrate dev` など）での設定の読み込み。同じ設定ファイルを使うので動く見込みだが、実行していない。
  - Prisma CLIの外部との通信を止める設定（`CHECKPOINT_DISABLE` など）は、検討していない。
- **commit：** `d56c8e4`（`test: guard Prisma CLI and add test DB migration runner`。親は `4b788e7`）。対象は10ファイル（変更5件・新規5件）。commitの前に、`git diff --cached --check` が0件であること、`.env`・`.env.local` の値が差分に含まれないことを確かめた。
- まとめ：Prisma CLI 7.2は、変更後の `prisma.config.ts` を読み込めた。テストモードの正常系も成功した。`DATABASE_URL_MISMATCH` による拒否と、migrationの確認モードも、期待どおりに動いた。通常テストは638件すべて成功した。**実DBへの接続と `migrate deploy` は、まだ実施していない。**
- 気づいた点（変更していない）：`scripts/test-integration.mts` の確認モードは、コマンドを表示するときに `path.relative(ROOT, arg)` を相対の引数（`run` など）にも使っている。作業ディレクトリがルートのときは正しく表示されるので、今は実害がない。`testDbMigrate.ts` では、絶対パスだけを変換するようにした。
- **申し送り:**
  - 本人確認を組み込むとき：仮の関数を、DBのコメント（`katana-test-db`）・`current_database()`・`current_user` を照合する関数に置き換える。`verifyIntegrationDatabase()` は、migration済みのテーブル構成まで確かめるので、migrationの前には使えない。本人確認の部分だけを分ける必要がある。`pg` を使う場合は、静的検査の許可リストに `scripts/testdb-migrate.mts` の1ファイルだけを加えるかどうかを、その時に決める。
  - CLAUDE.mdへの追記案（Step 3-13）には、「テストDBにはPrisma CLIを直接実行せず、`npm run testdb:migrate` を使う」を入れる。

**Step 3-9（テストDBの構成ファイル。静的検証まで。`61f8105` でcommit）**

- 以下の「未追跡・未commit」「未commit」は記録した時点の状態。Step 3-9・3-9Bの変更は、すべて `61f8105` に含まれる。

- **R12：Dockerの読み取り専用の調査**（ユーザーの承認を得て実施。2026-11-03）
  - 使ったコマンド：`docker info`（バージョンだけ）・`docker context show`・`docker ps -a`・`docker volume ls`・`docker compose ls -a`。`docker volume inspect` と `docker inspect sample-db` は、`--format` で必要な項目だけを表示した。ほかに `lsof` でポートを確かめた。起動・停止・exec・ボリュームの変更は、していない。
  - Dockerのデーモンは起動していた（Engine 29.4.1、Compose v5.1.3）。**コンテキストは `desktop-linux`**（2-5の照合に使う値）。
  - **開発用コンテナ `katana-db` は存在しない**（`docker ps -a` に出てこない）。Composeのプロジェクトも、1つも表示されなかった（`docker compose ls -a`）。
  - **開発用DBのボリュームは `katana-web_postgres_data`**。どのコンテナからも使われていない。
    - 作成日時は2026-07-18T05:42:41Z。
    - ラベルは、`com.docker.compose.project=katana-web`・`com.docker.compose.volume=postgres_data`。
    - 1-2の指摘のとおり、Composeのプロジェクト名はディレクトリ名（`katana-web`）になっている。
  - ほかのコンテナは `sample-db`（`sample-db-image:latest`、2026年5月から停止中、再起動ポリシー `no`）だけ。無名のボリューム `b655b6e4…` を `/var/lib/postgresql` にマウントしている。
  - ほかのボリューム：無名のボリューム `0df3f60a…`（2026-05-01作成、どのコンテナも使っていない）。
  - テスト用のコンテナ（`katana-test-db`）、`katana-test` プロジェクト、テスト用のボリュームは、どれもない。
  - **5434番ポートは空いている。** 5433番も、今は待ち受けがない（開発用コンテナがないため）。
  - PLANとの違い：2-5と3-11は、`katana-db` のID・状態・マウントを記録し、操作の前後で比べることを前提にしている。しかし、今はコンテナが存在しない。比べる対象を「`katana-db` が存在しないこと（または状態）」と「ボリューム `katana-web_postgres_data` の作成日時とラベル」にする必要がある（ラッパーの実装時に決める）。
- 作成（いずれも未追跡・未commit）:
  - `docker-compose.test.yml`
  - `docker/test-db/init/01-app-role.sh`（実行権限 `755`）
  - `docker/test-db/init/02-marker.sql`
  - `.env.test.example`
- 変更（未commit）：リポジトリのルートの `.gitignore`（`KatanaService/.gitignore`）に、`!katana-web/.env.test.example` を追加した。`.env*` の行はそのまま。`katana-web/.gitignore` は変えていない。
- **Compose定義**（`docker-compose.test.yml`）:
  - プロジェクト・サービス・コンテナ：`name: katana-test`、サービス `test-db`、コンテナ `katana-test-db`。
  - イメージは `postgres:15`。`restart: "no"`（自動では起動し直さない）。
  - ポートは `127.0.0.1:5434:5432` だけ。
  - データの保存先：`/var/lib/postgresql/data` をtmpfsにする。トップレベルの `volumes` はなく、名前付きボリュームも使わない。
  - マウントは、`./docker/test-db/init` を `/docker-entrypoint-initdb.d` に読み取り専用でbindマウントするものだけ。
  - healthcheck：TCPでの `pg_isready`（`-h 127.0.0.1`）。初期化中の一時的なサーバーはTCPで待ち受けないので、初期化が終わる前に healthy にはならない。
  - 書かないもの：`env_file`・`privileged`・`network_mode`。
- **パスワードの渡し方：** Gitで管理するファイルには書かない。`.env.test` の値を、Composeの変数展開（`${VAR:?…}`）で受け取る。未設定なら、Composeが起動の前にエラーで止まる。
  - `KATANA_TEST_DB_PASSWORD`：`katana_test_user` のパスワード。**`.env.test` の `DATABASE_URL` のパスワードと同じ値にする。** 2つの値の一致は、今は運用で守る（ラッパーで照合する予定）。
  - `KATANA_TEST_DB_ADMIN_PASSWORD`：初期化だけに使う管理用のスーパーユーザー `postgres` のパスワード（`POSTGRES_PASSWORD`。公式イメージでは必須）。
  - `.env.test` に新しいキーが増えても、ほかのスクリプトへの影響はない。runner・`prismaCliGuard`・`testdb-migrate` は、`dotenv.parse` で `DATABASE_URL` だけを読み、`process.env` には反映しないため。
  - Composeの変数展開では、**シェルの環境変数が `--env-file` の値より優先される**（Composeの仕様）。ラッパーでは、子プロセスから同じ名前の環境変数を取り除く必要がある。
- **権限：** `katana_test_user` は、`NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` のログイン用ロールとし、`katana_test` の所有者にする。
  - PostgreSQL 15では、`public` スキーマの所有者は `pg_database_owner`。そのため、DBの所有者はmigrationでテーブルを作成できる見込み（未検証）。
  - 管理用の `postgres` DBへの `PUBLIC` の権限は取り消す。
  - スーパーユーザー（`postgres`）は、公式イメージの初期化に必要なので残した。アプリとテストからは使わない。ガードはユーザー `katana_test_user` 以外を拒否する。
- **DBの識別コメント：** `02-marker.sql` で `COMMENT ON DATABASE katana_test IS 'katana-test-db';` を実行する。この値は、`integrationDatabaseCheck.ts` の `TEST_DATABASE_MARKER` と同じ。
  - 2つの初期化スクリプトは、どちらも最初に `current_database() <> 'katana_test'` なら例外を投げる。`01-app-role.sh` は、さらに `POSTGRES_DB` が `katana_test` であること、パスワードが空でないことも確かめる。
  - 初期化スクリプトをマウントするのはテスト用のComposeファイルだけで、開発用の `docker-compose.yml` には関わらない。
- **初期化が実行される条件：** 公式イメージは、データディレクトリが空のときだけ、`/docker-entrypoint-initdb.d` のスクリプトを名前順に実行する。
  - データはtmpfsにあるので、コンテナを作るたびに空になり、毎回初期化される。
  - データディレクトリが空でない場合（ボリュームを使う構成に変えた場合など）は、初期化は実行されない。そのため、コメントが付いているとは限らない。接続後の本人確認で、必ず照合する。
  - 既存のボリュームを自動で削除したり、初期化し直したりする処理はない。
- **静的検証**（一時スクリプトで実施。`js-yaml` は推移的な依存を使った。スクリプトはcommitしない）。次の22項目がすべて一致した。
  - 2-5の操作前の確認を、`config` の代わりにファイルで照合した：
    - プロジェクト名、サービスが1つだけであること、コンテナ名、イメージ、`restart`。
    - ポートが `127.0.0.1:5434:5432` だけであること、tmpfs。
    - `type: volume` のマウントとトップレベルの `volumes` がないこと、bindマウントが初期化用のディレクトリだけであること。
    - `POSTGRES_DB=katana_test`、パスワードが必須の変数展開であること。
    - `katana-db`・`postgres_data`・`5433` という文字列と、接続URLの文字列がないこと。
  - 既存のガードとの整合：
    - マーカーと DB名・ユーザーが、`TEST_DATABASE_TARGET`・`EXPECTED_DATABASE`・`EXPECTED_USER`・`TEST_DATABASE_MARKER` と一致する。
    - `.env.test.example` のキーは3つ。URLのパスワードが `KATANA_TEST_DB_PASSWORD` と一致し、管理用のパスワードは別の値になっている。
    - 見本のURLは、`assertTestDatabaseTarget()`（`.env` の開発用URLとの比較を含む）を通る。
  - `bash -n` による `01-app-role.sh` の構文検査も通った。
- `.gitignore` の確認（`git check-ignore -v --no-index`）:
  - 管理対象になるのは `katana-web/.env.test.example` だけ。
  - 引き続き除外されるもの：`katana-web/.env.test`・`.env`・`.env.local`・`.env.test.local`・`.env.example`・`.env.development`・`.env.test.example.bak`、ほかの階層の `.env.test.example`。
- 確認済み:
  - `npx tsc --noEmit` が成功した。TypeScript・JavaScriptのファイルは変えていないので、eslintの対象はない。
  - `npm test` は、27ファイル・638件がすべて成功した。
  - `npx vitest list --filesOnly` は27件で、`*.integration.test.*` は0件。統合テスト用の設定では6件。
  - `dbConnectionPaths.test.ts` は、件数・規則とも変更なし。`.sh`・`.sql`・`.yml` は走査の対象外。
- **設計との違い:**
  - 初期化のファイルを、`01-marker.sql`（1件）ではなく、`01-app-role.sh` と `02-marker.sql` の2件にした。理由は2つ。
    - 2-1の「DB名・ユーザーは開発用と別」と、権限を絞る方針を満たすため、スーパーユーザーではないアプリ用のロールを作る必要があった。その作成に、環境変数のパスワードを使う必要がある。
    - マーカーを最後に付ければ、マーカーがあることが、初期化がすべて終わった印になる。
  - `.env.test.example` に、`KATANA_TEST_DB_PASSWORD`・`KATANA_TEST_DB_ADMIN_PASSWORD` を加えた（2-1は `DATABASE_URL` だけを想定）。
  - `.gitignore` は、`katana-web/` ではなく、リポジトリのルートで変更した（除外ルールがルートにあるため）。
  - **未実施（3-9の完了条件・変更対象のうち）**：
    - ラッパー `scripts/testdb.mts`（2-5の操作前・操作後の確認、Compose用の環境変数の除去、パスワードの一致の照合）と、`package.json` の変更。
    - `docker compose ... config` による照合（承認が必要。`.env.test` が必要）。
- **残る安全上の懸念:**
  - 見本のプレースホルダー（`CHANGE_ME_…`）のまま `.env.test` を作っても、`assertTestDatabaseTarget()` は通る（パスワードの中身は検査しない）。拒否するかどうかは、ガードを変えることになるので、別に判断する。
  - `KATANA_TEST_DB_PASSWORD` は、コンテナの環境変数に残る（`docker inspect` で見える）。ローカル専用のテストDBなので許容したが、記録しておく。
  - スーパーユーザー `postgres` も、5434番ポートからパスワードでログインできる（`127.0.0.1` だけ）。
  - R7（tmpfsとイメージの `VOLUME` 宣言の関係で、無名ボリュームが作られないか）は未検証（Step 3-11）。
  - migrationを `katana_test_user` の権限で適用できるか、`shobj_description`・`pg_class` を読めるかは、実DBで未検証。
- **未実施（Step 3-9の時点）:** Dockerの起動・停止、`docker compose config`、DBへの接続、SQLの実行、migration、seed、統合テスト、build、git add・commit。`docker compose config` による照合とラッパーは、Step 3-9Bで実施した。

**Step 3-9B（Dockerのラッパーと、`docker compose config` による照合。`61f8105` でcommit）**

- 作成（いずれも未追跡・未commit）：`scripts/testdb.mts`（ラッパー本体。検証の関数をexportし、直接実行したときだけ `main()` が動く）、`scripts/testdb.test.ts`（67件。docker の呼び出しは偽の関数で置き換える）。
- 変更（未commit）:
  - `package.json`：`testdb:check`・`testdb:status` を追加。
  - `lib/testing/dbConnectionPaths.test.ts`：通常テストの期待件数を28件にした（テストファイルを1件増やしたため。規則と許可リストは変えていない）。指示された「変更してよいファイル」には入っていないが、テストファイルを増やすと必ず変える必要がある。
- **モード:** `--check` と `--status` だけを受け付ける。それ以外（`up`・`down`・`reset`、`-p`・`-f`・`--env-file` などを含む）は、`ARGUMENTS_INVALID` で拒否する。
  - PLANの `up`・`down`・`reset`（2-3・2-5）は、**実装していない**。操作前・操作後の確認（`ps` での照合、5434番ポートの確認、開発用ボリュームの記録の比較、tmpfs・無名ボリュームの確認）がそろってから、別のStepで実装する。
- **Composeの呼び出し：** 引数を `docker compose --project-name katana-test --file <katana-web>/docker-compose.test.yml --project-directory <katana-web> --env-file <katana-web>/.env.test <サブコマンド>` に固定した（パスはすべて絶対パス）。子プロセスは `execFile`（`shell: false`）で起動し、作業ディレクトリは `katana-web/`。
  - 実行できるDockerのコマンドは、許可リストの読み取り専用の9つだけ。リストにないコマンドは `DOCKER_COMMAND_NOT_ALLOWED` で拒否する。
    - `context show`
    - `compose config --quiet`、`compose config --format json`、`compose ps --all --format json`
    - `ps --all` に `--filter` を付けた3つ（プロジェクトのラベル、`name=^katana-db$`、`volume=katana-web_postgres_data`）
    - `volume ls --filter name=^katana-web_postgres_data$`
    - `volume inspect katana-web_postgres_data --format`（名前・作成日時・Composeのラベルだけ）
- **実行順序:**
  1. 引数
  2. Nodeの起動オプション（`execArgv`・`NODE_OPTIONS`）
  3. 親に `DOCKER_HOST`・`DOCKER_CONTEXT` があれば停止
  4. `.env.test`・`.env` の読み込み
  5. R14の検証
  6. 子プロセスの環境変数を作り、もう一度確かめる（R15）
  7. Composeファイルと初期化スクリプトがあることの確認
  8. `docker context show` が `desktop-linux` であることの確認
  9. `config --quiet` と `config --format json` の照合（JSONは表示せず、プログラムの中で照合する）
  10. 要約の表示

  `--status` は、10の後に、プロジェクトのコンテナ（`katana-test-db` 以外があれば停止）、`katana-db` の有無、開発用ボリュームの名前・作成日時・ラベル、ボリュームを使うコンテナを読み取って表示する。
- **R14（パスワードの整合性）:** `.env.test` を `dotenv.parse` で読み、次の順に確かめる。
  - キーが `DATABASE_URL`・`KATANA_TEST_DB_PASSWORD`・`KATANA_TEST_DB_ADMIN_PASSWORD` の3つ以外にないこと（`TEST_ENV_UNEXPECTED_KEY`）。`--env-file` は `COMPOSE_*` なども読むので、ほかのキーを拒否する。
  - `DATABASE_URL` が `assertTestDatabaseTarget()` を通ること（`.env` の開発用URLとの比較を含む）。
  - 2つのパスワードが空でないこと。
  - 3つのパスワード（URLのパスワード・アプリ用・管理用）に、見本の値（`change_me`・`change-me`・`changeme`。大文字・小文字は区別しない）が含まれないこと（`PASSWORD_PLACEHOLDER`）。
  - 3つのパスワードが、`[A-Za-z0-9_-]` の文字だけでできていること（`PASSWORD_CHARSET`）。
  - URLのパスワードとアプリ用のパスワードが一致すること（`URL_PASSWORD_MISMATCH`）。
  - 管理用とアプリ用のパスワードが違うこと（`ADMIN_PASSWORD_SAME_AS_APP`）。
  - **パーセントエンコードの扱い：** URLのパスワードは、書かれたままの文字列（デコードしない）で比べる。使える文字は、エンコードが要らないものだけにした。そのため、`%` を含む表記は文字種の検査で拒否され、エンコードの有無で値が食い違うことはない。
  - 既存のガード（`assertTestDatabaseTarget()`）は変えていない。見本の値を拒否するのは、ラッパーだけ。runner・`testdb-migrate`・`prisma.config.ts` は、パスワードの中身を検査しないまま（R14の残り）。→ Step 3-9Cで、4つの経路に共通の検証を入れた（下記）。
- **R15（環境変数の隔離）:**
  - 子プロセスの環境変数は、runnerと同じ許可リスト（`inheritAllowedEnv()`）で引き継ぐ変数と、検証済みの `KATANA_TEST_DB_PASSWORD`・`KATANA_TEST_DB_ADMIN_PASSWORD` だけ。
  - 引き継がないもの：親の `DATABASE_URL`・`PG*`・`DOTENV_*`・`COMPOSE_*`・`POSTGRES_*`・`DOCKER_*`（`DOCKER_CONFIG`・`DOCKER_CERT_PATH` を含む）・`NODE_OPTIONS`、親の同名のパスワード変数。
  - 組み立てた後に、禁止のパターンがないこと、`KATANA_` で始まる変数がこの2つだけで、値が検証済みのものと一致することを、もう一度確かめる（`CHILD_ENV_INVALID`）。
  - パスワードは `.env.test` からだけ受け取り、ほかのファイルから補うことはない。
- **`docker compose config` による照合**（ユーザーの指示により、configだけを実行。`docker context show` も実行した。どちらもコンテナを操作しない）:
  - 架空の一時的な `.env.test`（`umask 077`、権限 `-rw-------`、架空のパスワード）を作り、`npm run testdb:check` を実行した。終了コード0で、すべての項目が一致した。
    - プロジェクト `katana-test`、`postgres:15`、`restart: no`
    - ポート `127.0.0.1:5434 -> 5432`
    - tmpfs `/var/lib/postgresql/data`、名前付きボリュームと `type: volume` のマウントがない
    - 初期化用のディレクトリが、読み取り専用のbindマウントになっている
    - healthcheck がある
    - 環境変数の4つのキーと値が、検証済みの値と一致する
    - `katana-db`・`postgres_data`・`5433`・`katana-web_` という文字列がない
  - Composeのプロジェクトのディレクトリにある `.env`（開発用）の値は、展開の結果に混ざらなかった。環境変数の値が、検証済みの値と完全に一致した。
  - 親に `COMPOSE_FILE=docker-compose.yml`・`COMPOSE_PROJECT_NAME=katana-web`・`KATANA_TEST_DB_PASSWORD=wrong`・`DATABASE_URL`・`PGHOST` を設定して実行しても、プロジェクトは `katana-test` のままで、パスワードは `.env.test` の値で展開された（R15の確認）。
  - 次の場合は、Dockerを呼ばずに終了コード1で止まった。
    - `.env.test.example` をそのままコピーした場合（`PASSWORD_PLACEHOLDER`）
    - `COMPOSE_PROFILES` を加えた場合（`TEST_ENV_UNEXPECTED_KEY`）
    - `DOCKER_HOST` がある場合（`DOCKER_TARGET_ENV_PRESENT`）
    - `-p katana-web` を付けた場合（`ARGUMENTS_INVALID`）
  - 出力に、パスワードと `postgresql://` は0件だった。
  - 一時的な `.env.test` は削除した。`.env`・`.env.local` のハッシュは、実行の前後で変わらなかった。
  - 実行後の `docker ps -a`・`docker volume ls` の一覧は、Step 3-9の調査と同じだった（`sample-db`、無名のボリューム2つ、`katana-web_postgres_data`）。
  - `--status` は、単体テストだけで確かめた（実際のDockerでは実行していない）。
- **tmpfsとイメージの `VOLUME` 宣言（R7）:** `postgres:15` のイメージは `VOLUME /var/lib/postgresql/data` を宣言している。
  - 同じパスにtmpfsのマウントがあれば、Dockerはそのパスに無名のボリュームを作らない見込み（コンテナの作成時に、マウント済みのパスを飛ばす）。ただし、**静的には確定できない**。イメージの設定も読んでいない。
  - 後続のStepで、初めて起動した後に、次を確かめる：`docker inspect katana-test-db` の `Mounts` が初期化用のbindマウントだけであること、`HostConfig.Tmpfs` に `/var/lib/postgresql/data` があること、`docker volume ls` の一覧が起動の前後で増えていないこと。
  - Composeは、コンテナを作り直すときに、前のコンテナの無名ボリュームを引き継ぐ。無名ボリュームができていた場合は、このことにも注意する。
- **開発用ボリュームの保護:** `katana-web_postgres_data` には、読み取り（`volume ls`・`volume inspect --format`・`ps --filter volume=`）しか行わない。削除・変更・マウントするコマンドは、許可リストにない。Composeの定義でも、このボリュームは参照していない（config の照合で確認済み）。
- 確認済み:
  - `npx tsc --noEmit` と、変更した3ファイルの `eslint` が成功した。
  - `bash -n docker/test-db/init/01-app-role.sh` が成功した。
  - 新しい単体テストの67件が成功した。`dbConnectionPaths.test.ts` は148件成功し、違反は0件。
  - `npm test` は28ファイル・705件が成功した（638件＋67件）。
  - `npx vitest list --filesOnly` は28件で、`*.integration.test.*` は0件。統合テスト用の設定では6件。
- **残る課題・未検証:**
  - `up`・`down`・`reset` の実装（操作前・操作後の確認を含む）。
  - コンテナの初回の起動と、R7の確認。
  - 初期化スクリプトが実際に成功すること（ロールの作成、所有者の変更、マーカーの設定）。
  - `katana_test_user` の権限で migration を適用できること。
  - `--status` の実際の出力。
  - Composeの `ps --format json` の出力の形（JSON配列か、1行ごとのJSONか）は、両方に対応したが、Compose v5で実際に確かめていない。
- **commitの前の修正（コメント・文書だけ）:** `docker-compose.test.yml` のコメント2か所（初期化スクリプトの名前を `01-app-role.sh` に訂正。マウントはディレクトリ単位なので、実際のマウントパスは正しかった。`testdb.mts` が「後続のStepで作成」とあった記述を、今の状態に更新）と、本ファイルの2か所（Phase 3の状態の欄、Step 3-4の許可リストの記述）。
- **commitの前の最終検証:**
  - `npx tsc --noEmit`、TS・JSの3ファイルの `eslint`、`bash -n docker/test-db/init/01-app-role.sh`、`git diff --check` が成功した。
  - `npm test` は28ファイル・705件がすべて成功した（静的検査の違反0件）。`npx vitest list --filesOnly` は28件で、`*.integration.test.*` は0件。統合テスト用の設定では6件。
  - `docker compose config` による照合（`npm run testdb:check`）を、3-9Bと同じ条件で行い、終了コード0で全項目が一致した。条件は、架空のパスワードで権限600の一時的な `.env.test` を作ること、`DOCKER_HOST`・`DOCKER_CONTEXT`・`NODE_OPTIONS` を外すこと、実行後に削除すること。開発用DBへの参照はなく、出力に秘密情報は0件。`.env`・`.env.local` のハッシュと、`docker ps -a`・`docker volume ls` の一覧は、実行の前後で変わらなかった。
  - **コンテナの起動・停止・削除、DBへの接続、migration、seed、統合テスト、build は行っていない。**
- **commit：** `61f8105`（`test: add isolated PostgreSQL test environment`。親は `d56c8e4`）。Step 3-9・3-9Bをまとめた1つのcommit。対象は10ファイル（変更4件・新規6件）。
  - 変更：リポジトリのルートの `.gitignore`、`package.json`、`lib/testing/dbConnectionPaths.test.ts`、`docs/PLAN-test-db-isolation.md`。
  - 新規：`.env.test.example`、`docker-compose.test.yml`、`docker/test-db/init/01-app-role.sh`、`docker/test-db/init/02-marker.sql`、`scripts/testdb.mts`、`scripts/testdb.test.ts`。
  - ステージはファイルを指定して行った（`git add .`・`-A` は使っていない）。commitの前に、`git diff --cached --check` が0件であること、`.env`・`.env.local` の値と実在する認証情報が差分に含まれないことを確かめた。pptx・`test-data/`・`.env.test` はステージしていない。
  - commit後の本ファイルの更新（この記録と「次のセッションで最初に行うこと」）は、ユーザーの指示で、次の実装作業（Step 3-9C）のcommitに含めた。

**Step 3-9C（R14のパスワード検証の共通化。ユーザーの指示による）**

- 目的：Step 3-9Bではラッパーだけが行っていた `.env.test` のパスワードの検証を、共通の純粋関数にまとめ、テストDBの正規の実行経路のすべてで行う。DBには接続しない。
- **共通の関数**（`lib/db/testDatabaseGuard.ts` に追加。外部モジュールは読み込まない）:
  - `assertTestDatabaseCredentials(testEnv)`：`.env.test` を `dotenv.parse` した結果を受け取り、次の順に確かめる。成功したら、検証済みの2つのパスワードを返す。
    1. `DATABASE_URL` が解析できること（`URL_INVALID`）
    2. `KATANA_TEST_DB_PASSWORD`・`KATANA_TEST_DB_ADMIN_PASSWORD` が空でないこと（`APP_PASSWORD_MISSING`・`ADMIN_PASSWORD_MISSING`）
    3. URLのパスワードを含む3つの値が、見本の値（`/change[_-]?me/i`）でないこと（`PASSWORD_PLACEHOLDER`）
    4. 3つの値が `[A-Za-z0-9_-]` だけでできていること（`PASSWORD_CHARSET`）
    5. URLに書かれたままのパスワードが `KATANA_TEST_DB_PASSWORD` と一致すること（`URL_PASSWORD_MISMATCH`）
    6. 管理用のパスワードがアプリ用と違うこと（`ADMIN_PASSWORD_SAME_AS_APP`）
  - `TestDatabaseCredentialsError`：`code` と `detail`（コードを除いた説明）を持つ。メッセージ・`detail` には、パスワード・接続URLを含めない。
  - 定数 `TEST_DB_APP_PASSWORD_KEY`・`TEST_DB_ADMIN_PASSWORD_KEY` もここに置いた（ラッパーはこれを使う）。
  - `assertTestDatabaseTarget()` は変えていない。共通の関数は、どの経路でも `assertTestDatabaseTarget()` に通った**後**に呼ぶ。接続先が不正なら、今までどおり接続先のエラーで止まる。
- **適用した経路（4つ）:**
  - Dockerのラッパー（`scripts/testdb.mts` の `verifyTestDbEnv`）：自前の検証を共通の関数に置き換えた。エラーコードは今までと同じ（共通の関数のコードをそのまま使う）。キーを3つに限る条件（`TEST_ENV_UNEXPECTED_KEY`）は、Composeの動作を変えさせないためのものなので、ラッパーにだけ残した。
  - 統合テストのrunner（`lib/testing/integrationEnv.ts` の `prepareIntegrationEnv`）：拒否したら `IntegrationRunnerError`（`the test database credentials in .env.test were rejected (<コード>)`）。
  - migration用スクリプト（`lib/testing/testDbMigrate.ts`）：手順5に追加。新しいコード `CREDENTIALS_REJECTED`（理由のコードを括弧で付ける）。確認モードでも止まる。
  - Prisma CLIのテストDBモード（`lib/db/prismaCliGuard.ts`）：`assertTestDatabaseTarget()` の後、`DATABASE_URL_MISMATCH` の確認の前。新しいコード `CREDENTIALS_REJECTED`。`targetCode` に理由のコードを入れる。
  - パスワードは、検証には `.env.test` の値だけを使う。親の環境変数に同じ名前の変数があっても使わない。runner・migration用スクリプトの子プロセスには、パスワードを渡さない（接続には `DATABASE_URL` だけを使う）。
- **既存の機能への影響:**
  - 開発・本番用の経路は変えていない。`lib/prisma.ts` と、Prisma CLIの既定のモード（`KATANA_DB_TARGET` が未設定）は変更なし。既定のモードで `.env.test` を読まないことは、既存のテストで確認している。
  - テストDBの経路は厳しくなった。`DATABASE_URL` しか書いていない `.env.test` は、runner・`testdb-migrate`・Prisma CLIのテストDBモードでも拒否される（`.env.test.example` には、もともと3つのキーがある）。
  - 既存のガードは緩めていない。globalSetup（`lib/testing/integrationGlobalSetup.ts`）は、**今も必ず停止する**（変更していない）。
- **テスト:**
  - 新規：`lib/testing/integrationEnv.test.ts`（runnerの `prepareIntegrationEnv` には、これまで単体テストがなかった）。
  - 変更：`lib/db/testDatabaseGuard.test.ts`（共通の関数のテスト）、`lib/db/prismaCliGuard.test.ts`・`lib/testing/testDbMigrate.test.ts`（テスト用の `.env.test` に架空のパスワード2つを足し、R14のテストを追加）、`scripts/testdb.test.ts`（ラッパーの判定が共通の関数と同じコードになること）。
  - 確かめた内容：正しい設定、見本の値、空・未設定のパスワード、不一致、管理用とアプリ用が同じ、使えない文字・パーセントエンコードの表記、キーの名前の大文字・小文字、不正な接続先、`NODE_OPTIONS`・`PG*`、親の環境変数のパスワードを使わないこと、エラーに秘密情報が入らないこと。
  - `lib/testing/dbConnectionPaths.test.ts`：テストファイルが1つ増えたので、通常テストの期待件数を28→29に変更した。規則・許可リストは変えていない。
- **確認済み:**
  - 新しく追加したテストの57件が成功した。
  - `npm test` は29ファイル・762件がすべて成功した（705件＋57件）。`dbConnectionPaths.test.ts` の静的検査の違反は0件。
  - `npx tsc --noEmit` と、変更した11ファイルの `eslint` が成功した。`git diff --check` は0件。
  - `npx vitest list --filesOnly` は29件で、`*.integration.test.*` は0件。統合テスト用の設定では6件。
  - **回帰確認（3つの確認モード）：** 架空の認証情報で一時的な `.env.test` を作った（`umask 077`、権限 `-rw-------`）。`DOCKER_HOST`・`DOCKER_CONTEXT`・`NODE_OPTIONS` を外して実行した。
    - 3つの確認モードは、どれも検証だけで終わり、子プロセスの起動・DBへの接続の前に返ることを、ソースで確かめてから実行した（runner の `mode === "check"`、`runTestDbMigrate` の手順7の後、`testdb.mts` の読み取り専用のコマンドの許可リスト）。
    - `npm run test:integration:check`・`npm run testdb:migrate:check`・`npm run testdb:check` は、3つとも終了コード0で、共通の検証に通った。`testdb:check` の `docker compose config` の照合も、全項目が一致した。
    - `.env.test.example` をそのままコピーした場合は、3つとも終了コード1で止まった（runner と `testdb-migrate` は `(PASSWORD_PLACEHOLDER)`、ラッパーは `PASSWORD_PLACEHOLDER`）。
    - 出力に、パスワード・`CHANGE_ME`・`postgresql://`・`postgres://` は0件。一時的な `.env.test` は削除し、存在しないことを確かめた。`.env`・`.env.local` のハッシュと、`docker ps -a`・`docker volume ls` の一覧は、実行の前後で変わらなかった。
  - **Dockerの操作（読み取り系の `context show`・`config`・前後比較の `ps -a`・`volume ls` 以外）、コンテナの起動、DBへの接続、migration、seed、統合テスト、runnerの通常実行モード、build は行っていない。**
- **R14の残課題（R14は完全には解消していない）:**
  1. globalSetup と `lib/prisma.ts` の統合テストモードを、runnerを通さずに起動する経路。どちらもプロセスの `DATABASE_URL` の接続先だけを検証し、パスワードは検証しない。`KATANA_DB_TEST_MODE=integration`・`KATANA_TEST_RUNNER=script` を手で設定して `vitest --config vitest.integration.config.ts` を直接実行すると、runnerのパスワードの検証を通らない。**今は globalSetup が必ず停止するので、統合テストは始まらない。** globalSetup に接続の処理を組み込むときに、この経路の対策を決める。
  2. `docker compose` の直接実行。Compose定義の `${VAR:?}` は、値が設定されていることしか確かめない。見本の値のままでも起動できる。操作はラッパーからだけ行う運用で守る（CLAUDE.mdへの追記案、Step 3-13）。
  3. psql などのプロジェクトの外の道具からテストDBへの接続は、対象外。
- **commit：** `4553f2f`（`test: centralize test database credential validation`。親は `61f8105`）。対象は12ファイル（変更11件・新規1件。本ファイルを含む）。commitの前に、`git diff --cached --check` が0件であること、`.env`・`.env.local` の値と実在する認証情報が差分に含まれないこと、`assertTestDatabaseTarget()` を緩めていないこと、globalSetup・`lib/prisma.ts`・`prisma.config.ts` を変えていないことを確かめた。hash は、Step 3-9Dのセッションで記録した。

**Step 3-9D（Dockerのラッパーの `up`・`down`。実装・単体テスト・静的検証と、障害時の down のレビューまで。実際の起動・停止は未実施）**

- **実際の `up`・`down` は実行していない。** Dockerの読み取り系のコマンドも、このStepでは1回も実行していない（すべて偽の関数によるテスト）。DBへの接続、migration、seed、統合テストも行っていない。
- 変更（未commit）：`scripts/testdb.mts`、`scripts/testdb.test.ts`、`package.json`（`testdb:up`・`testdb:down` を追加）、本ファイル。新しいファイルはない。`lib/testing/dbConnectionPaths.test.ts` は変えていない（テストファイルの数は29のまま）。
- **引数：** 次の6通りだけを、順番も含めて完全一致で受け付ける。それ以外（`--reset`、`--apply` だけ、`--apply --up`、`--check --apply`、`-p`・`-f`・`--volumes`・`--remove-orphans` などの追加）はすべて `ARGUMENTS_INVALID`。
  - `--check`・`--status`（今までどおり）
  - `--up`・`--down`：操作前の確認をすべて行い、実行する予定のコマンドを表示するだけ（変更操作はしない）
  - `--up --apply`・`--down --apply`：確認がすべて通った場合だけ、変更操作を行う
  - npm の登録は `testdb:up` → `--up`、`testdb:down` → `--down`（`--apply` を含めない）。実際に操作するには `npm run testdb:up -- --apply` のように、`--apply` を明示する。
- **Dockerのコマンドの固定:**
  - 読み取り専用のコマンドは、許可リスト（14個）と完全一致したものだけを実行する。
    - 追加したのは、同名コンテナ・5434番の公開・すべてのボリューム・プロジェクトのボリューム・イメージの有無・テスト用コンテナの `inspect` の6つ。
    - `katana-db` の記録は、比較が揺れないように、名前・ID・状態（`.State`）に変えた。経過時間を含む `.Status` は使わない。
    - 開発用ボリュームの有無は、すべてのボリュームの一覧から判断する（名前で絞り込む `volume ls` は使わなくなった）。
  - テスト用コンテナの `inspect` は、決まった形式（プロジェクト・サービスのラベル、状態、health、Mounts、HostConfig.Tmpfs、HostConfig.PortBindings）だけを読む。`Config.Env` などのパスワードを含む項目は読まない。
  - 変更操作は、別の関数（`mutate`）からだけ実行する。
    - `--apply` がなければ `MUTATION_NOT_ALLOWED`。
    - 引数が次の2つと完全一致しなければ `DOCKER_COMMAND_NOT_ALLOWED`。禁止する引数（`--volumes`・`-v`・`--remove-orphans`・`--rmi`・`--renew-anon-volumes`・`-V`・`--force-recreate`・`--always-recreate-deps`・`--build` など）を含む場合も拒否する。
    - up：`compose <固定の4つ> up --detach --wait --wait-timeout 120 --no-deps --no-build --no-recreate --pull never test-db`
    - down：`compose <固定の4つ> down`
  - `<固定の4つ>` は、今までどおり `--project-name katana-test --file <絶対パス> --project-directory <katana-web> --env-file <katana-web/.env.test>`。子プロセスは `shell: false`、環境変数は許可リストの変数と検証済みの2つのパスワードだけ（R15）。
  - サービス名 `test-db` は、`config --format json` の照合（サービスが `test-db` の1つだけであること）に通った後にだけ使う。
- **操作前の確認（up・down共通。1つでも失敗したら、変更操作をしない）:**
  1. 引数
  2. Node の起動オプション・`NODE_OPTIONS`
  3. `DOCKER_HOST`・`DOCKER_CONTEXT`
  4. `.env.test` の読み込みとキーの確認
  5. `assertTestDatabaseTarget()`
  6. `assertTestDatabaseCredentials()`
  7. 子プロセスの環境変数（作った後の再確認を含む）
  8. 必要なファイル
  9. `docker context show` が `desktop-linux`
  10. `config --quiet` と `config --format json` の照合（3-9Bと同じ項目）
  11. Dockerの状態の記録（読み取りだけ）：`katana-test` プロジェクトのコンテナ（`compose ps`）、ラベルで絞り込んだコンテナ、名前が `katana-test-db` のコンテナとそのプロジェクトのラベル、プロジェクトのボリューム、すべてのボリューム、5434番を公開しているコンテナ、開発用コンテナ `katana-db`（名前・ID・状態）、開発用ボリューム（名前・作成日時・ラベル）、開発用ボリュームを使うコンテナ
  12. プロジェクトの中身：
      - コンテナは `katana-test-db` だけ（`UNEXPECTED_CONTAINER`）
      - サービスは `test-db` だけ（`UNEXPECTED_SERVICE`）
      - 同じ名前のコンテナは `katana-test` プロジェクトのものだけ（`CONTAINER_NAME_CONFLICT`）
      - プロジェクトのボリュームがない（`UNEXPECTED_VOLUME`）
      - テスト用コンテナが開発用ボリュームを使っていない（`DEVELOPMENT_VOLUME_IN_USE`）
- **up の安全条件:**
  - 上の確認に加えて、次を確かめる。
    - テスト用コンテナが1つもないこと（`TEST_CONTAINER_EXISTS`）。起動中・停止中を問わず、既存のコンテナは起動し直さず、作り直しもしない。
    - 5434番を公開しているコンテナがないこと（`PORT_IN_USE`）。
    - イメージ `postgres:15` がローカルにあること（`docker image inspect`。なければ `IMAGE_MISSING`）。イメージは取得しない。
  - 起動後の確認（`POST_CHECK_FAILED`。失敗しても、コンテナ・ボリュームは削除しない）:
    - プロジェクトのコンテナが `katana-test-db`（`test-db`）の1つだけで、running かつ healthy。ラベル・名前の一覧も同じ。
    - プロジェクトのボリュームがない。
    - **すべてのボリュームの一覧が起動前と同じ**（無名のボリュームが増えていない。R7）。
    - 5434番を公開しているのは `katana-test-db` だけ。
    - 開発用DBの記録が変わっていない。
    - `inspect`：マウントが初期化用ディレクトリの読み取り専用のbindマウント1つだけ（volume 型がない）、`HostConfig.Tmpfs` に `/var/lib/postgresql/data` がある、ポートが `5432/tcp → 127.0.0.1:5434` だけ、ラベルが `katana-test`・`test-db`。
- **down の安全条件:**
  - 上の確認に加えて、テスト用コンテナがあれば、`inspect` で同じ項目を照合する（running・healthy は問わない。`CONTAINER_INSPECT_MISMATCH`）。テスト用コンテナがなければ、`--apply` があっても何もしない。
  - 停止後の確認（`POST_CHECK_FAILED`。失敗しても、コンテナ・ボリュームを作り直さない）：テスト用コンテナがどの一覧にもない、プロジェクトのボリュームがない、すべてのボリュームの一覧が停止前と同じ（増減なし）、開発用DBの記録が変わっていない。
- **テスト**（`scripts/testdb.test.ts`。72件→163件）:
  - Dockerは偽の関数で置き換えた。偽の関数は状態を持ち、変更操作の後は操作後の状態を返す。
  - 確かめた内容：
    - up・down のコマンドの組み立てと、`--apply` がなければ変更操作をしないこと
    - 不正な引数、不正な `.env.test`（見本の値・不一致・想定外のキー・ない）、不正な接続先
    - 別のプロジェクト・Composeファイル・作業ディレクトリ・env ファイル、別のコンテキスト、`DOCKER_HOST`・`DOCKER_CONTEXT`
    - 開発用ボリュームの参照（config・inspect・ボリュームの利用者）
    - 既存コンテナ・同名コンテナ・5434番の衝突、不明なサービス・孤立したコンテナ、イメージがない
    - 起動の失敗（stderr のパスワードを伏せる・後片付けをしない）
    - 起動後・停止後の確認の失敗（何も削除・作り直ししない）
    - down で `--volumes` などを使わないこと、エラーと出力に秘密情報を含めないこと
- **確認済み:**
  - `npx tsc --noEmit`、`scripts/testdb.mts`・`scripts/testdb.test.ts` の `eslint` が成功した。`git diff --check` は0件。
  - `npm test` は29ファイル・853件がすべて成功した（762件＋91件）。`dbConnectionPaths.test.ts` の静的検査の違反は0件。
  - `npx vitest list --filesOnly` は29件で、`*.integration.test.*` は0件。統合テスト用の設定では6件。
- **設計（2-5）との違い:**
  - 5434番が空いていることの確認は、`lsof` ではなく、`docker ps --filter publish=5434` で行う。Docker以外のプロセスが5434番を使っている場合は見つけられない。その場合は、ポートの割り当てに失敗して up が止まる見込み。
  - up の後の「DBのコメントの照合」は、DBに接続しないので、ラッパーでは行わない（接続後の本人確認は、migration用スクリプト・globalSetup で行う予定）。
  - `logs` は実装していない。
  - 開発用コンテナ `katana-db` は、Step 3-9の調査の時点で存在しない。そのため、比べる対象は `katana-db` の有無・ID・状態と、開発用ボリュームの名前・作成日時・ラベル、ボリュームを使うコンテナ（R12）。
- **未確認（実際のDockerでの確認が必要）:**
  - Compose v5.1.3 が、`up` の `--wait-timeout`・`--pull never`・`--no-recreate` の組み合わせを受け付けること（受け付けなければ、エラーで止まり、何も起動しない見込み）。
  - `docker ps` の `--filter publish=5434`・`--filter name=^…$`・`{{.Label "…"}}`・`{{.State}}`、`inspect` の決まった形式の出力が、想定どおりの形であること。`compose ps --format json` の形（JSON配列か、1行ごとのJSONか）。
  - Docker Desktop の `inspect` で、bindマウントの `Source` が `katana-web/docker/test-db/init` の絶対パスのまま表示されること。違う場合は、起動後の確認が `inspect: mounts` で失敗する（その場合も、何も削除しない）。
  - R7（tmpfs とイメージの `VOLUME` 宣言の関係）の最終判定。初めて起動したときに、起動後の確認（すべてのボリュームの一覧の比較と、`inspect` の Mounts）で判定する。
  - `--wait` が healthcheck の失敗やタイムアウトで終了した場合、コンテナは残る。そのときは `--status` で確かめてから `--down` で片付ける（自動では削除しない）。
  - `docker-compose.test.yml` の冒頭のコメントは「up・down・reset は未実装」のままだった（前半で変更してよいファイルに含まれていなかった）。→ 後半で直した（下記）。
- **障害時の down のレビュー（Step 3-9Dの後半。ユーザーの指示による）:**
  - 調べた状態：A. 正常に起動済み（healthy）、B. 起動途中（starting）、C. 初期化の失敗（unhealthy）、D. 停止済み（exited）、E. up のタイムアウト後に残ったコンテナ。あわせて、作成だけされた状態（created）も調べた。
  - 結果：down の前の確認は、コンテナの状態（state・health）を条件にしていない（`containerInspectMismatches` を `running: false` で呼ぶ）。そのため、A〜Eのどれでも、同一性を確かめられれば down できる。
    - 同一性の確認：コンテナ名 `katana-test-db`、プロジェクト `katana-test`、サービス `test-db`、Compose のラベル、開発用ボリュームを使っていないこと、不明なサービス・コンテナがないこと。
    - コンテナの一覧は、`docker compose ps` も `docker ps` も、すべて `--all` で読む（停止済みのコンテナも見える）。
  - **見つかった不足と修正（最小限）：** Compose のラベルは、プロジェクトとサービスの2つしか照合していなかった。そのため、`-p katana-test` で別のComposeファイルから作られた、同じ形のコンテナと区別できなかった。
    - `inspect` の決まった形式に、`com.docker.compose.project.config_files` と `com.docker.compose.project.working_dir` を加えた。
    - 照合の条件：Composeファイルが `katana-web/docker-compose.test.yml` の絶対パスの1つだけ、作業ディレクトリが `katana-web` の絶対パス。
    - 合わなければ、up の後の確認（`POST_CHECK_FAILED`）でも、down の前の確認（`CONTAINER_INSPECT_MISMATCH`）でも止まる。
    - 条件は厳しくなっただけで、既存の安全条件は緩めていない。
  - 対象を特定できない場合は、どれも down しない（fail-closed）。不明なコンテナを削除する例外は作っていない。該当する場合は次のとおり。
    - `inspect` が失敗した
    - ラベル（プロジェクト・サービス・Composeファイル・作業ディレクトリ）が違う、またはない
    - 同じ名前のコンテナが別のプロジェクトのもの、またはラベルがない
    - プロジェクトに別のコンテナ・サービスがある
    - 開発用ボリュームを使っている
    - マウント・tmpfs・ポートが違う
  - E の流れ（単体テストで確認）：
    1. `up --apply` の `--wait` が失敗すると、`DOCKER_COMMAND_FAILED` で止まる。down は呼ばず、コンテナは残る。
    2. 次の `up --apply` は、`TEST_CONTAINER_EXISTS` で止まる（作り直さない）。
    3. `--status` で状態（`running, unhealthy`）が見える。`--down`（`--apply` なし）は、変更操作をしない。
    4. `--down --apply` で片付けられる。
- **テスト（後半で追加）：** `scripts/testdb.test.ts` は163件→188件（25件を追加）。
  - A〜D・created で down できること、E の一連の流れ、コンテナの一覧がすべて `--all` で読まれること
  - unhealthy のコンテナでも、ラベル（プロジェクト・サービス・Composeファイル・作業ディレクトリ）、開発用ボリュームのマウント、tmpfs、ポートが違えば down しないこと
  - 他のプロジェクトの同名コンテナ・ラベルのない同名コンテナ・混ざった別のコンテナ・不明なサービス・開発用ボリュームの利用・`inspect` の失敗で down しないこと
  - `--apply` がなければ、healthy・unhealthy・exited のどれでも変更操作をしないこと
- **`docker-compose.test.yml`：** 冒頭のコメントだけを、今の状態に直した（up・down は実装済みで、実際の起動・停止は未検証。reset は未実装）。コメント以外の行が変わっていないことを確かめた。
- **後半の確認:**
  - `npx tsc --noEmit`、`scripts/testdb.mts`・`scripts/testdb.test.ts` の `eslint` が成功した。`git diff --check` は0件。
  - `npm test` は29ファイル・878件がすべて成功した（853件＋25件。Step 3-9C の762件からは＋116件）。`dbConnectionPaths.test.ts` は148件が成功し、静的検査の違反は0件。
  - `npx vitest list --filesOnly` は29件で、`*.integration.test.*` は0件。統合テスト用の設定では6件。
  - Dockerのコマンドは、このStepでは1回も実行していない。
- **Step 3-9D の時点で、まだ完了していないこと（完了扱いにしない）:**
  - 実際の `up`・`down`（Dockerでの起動・停止）は、一度も行っていない。
  - R7 は未検証（初めて起動するときに判定する）。
  - Compose のラベル（`config_files`・`working_dir`）の実際の値が、絶対パスのまま入ること。違う場合は、up の後の確認と down の前の確認で止まる。その場合も、何も削除しない。
  - reset は未実装。
- **commit：** `5fcc259`（`test: add guarded test database up and down commands`。親は `4553f2f`）。対象は5ファイル（`scripts/testdb.mts`、`scripts/testdb.test.ts`、`package.json`、`docker-compose.test.yml`、本ファイル）。commitの時点で、次の状態だった。
  - up・down は実装済みで、`--apply` が必要。障害時（starting・unhealthy・exited・created・up の失敗後）の down に対応している。
  - 通常テストは878件が成功した。
  - Dockerの実際の操作と、実DBへの接続は行っていない。R7 は未検証。reset は未実装。R14 の残課題はそのまま。

**Step 3-10の実施前レビュー（調査とPLANの更新だけ。ユーザーの指示による。2026-11-03）**

- このレビューでは、コードを変更していない。Dockerの変更操作、DBへの接続、migration、`.env.test` の作成も行っていない。
- **Dockerの読み取り専用の調査**（実行したコマンド：`docker context show`、`docker version`、`docker compose version`、`docker compose up|down|ps --help`、`docker ps -a`、`docker volume ls`、`docker volume inspect katana-web_postgres_data --format …`、`docker image ls postgres`、`docker image inspect postgres:15 --format {{.Id}}`、`docker compose ls -a`、`docker ps -a --filter publish=5434`・`--filter name=^…$`。あわせて `lsof -nP -iTCP:5434 -sTCP:LISTEN`。出力は名前・状態・ラベルだけに絞り、`docker inspect` でコンテナの設定（環境変数）は読んでいない）:
  - コンテキストは `desktop-linux`。Docker Engine 29.4.1（クライアント・サーバーとも）、Docker Compose v5.1.3。
  - `docker compose up` は、ラッパーが使う `--detach`・`--wait`・`--wait-timeout <秒>`・`--no-deps`・`--no-build`・`--no-recreate`・`--pull <always|missing|never>` を、すべて受け付ける（ヘルプで確認）。`--no-recreate` と両立しないのは `--force-recreate` などで、ラッパーは使っていない。
  - `docker compose down` は `[SERVICES]` を取れる。`--volumes`・`--remove-orphans`・`--rmi` は、どれも指定しないかぎり使われない。
  - `docker compose ps` は `--all`（停止済みを含む）と `--format json` を受け付ける。JSON の実際の形（配列か、1行ごとのJSONか）は、対象のプロジェクトがないので確かめていない（ラッパーはどちらにも対応している）。
  - コンテナは `sample-db`（`sample-db-image:latest`、exited、Compose のプロジェクトなし）だけ。**`katana-db` と `katana-test-db` は存在しない。** Compose のプロジェクトは1つも表示されない。
  - ボリュームは、無名の2つ（`0df3f60a…`・`b655b6e4…`）と `katana-web_postgres_data`。**開発用ボリュームの記録は、Step 3-9の調査と同じ**（作成日時 2026-07-18T05:42:41Z、ラベル `com.docker.compose.project=katana-web`・`com.docker.compose.volume=postgres_data`）。`katana-test` のボリュームはない。
  - イメージ `postgres:15` はローカルにある（ID `29342cb52157`、約6か月前）。
  - 5434番：公開しているコンテナはなく、`lsof` でも待ち受けているプロセスはない（調査の時点）。
- **実装と CLI の仕様の照合（`scripts/testdb.mts`。コードは修正していない）:**
  - 引数：ラッパーの up・down の固定の引数は、Compose v5.1.3 のヘルプにあるオプションだけでできている。
  - `docker ps --format` は、テンプレートの `\t` を自分でタブに置き換える。`volume inspect --format` は置き換えない。ラッパーは、JS の文字列で本物のタブを渡しているので、どちらでも同じ出力になる見込み。
  - `ps` の JSON：配列と1行ごとのJSONの両方を読む。`Name`・`Service`・`State`・`Health` だけを使う。
  - `inspect`：ラベルがないときは、Go テンプレートの `index` が空文字を返す（`json` で `""`）。偽の Docker では `null` を使ったテストもあるが、どちらも不一致として止まるので、判定は変わらない。
  - `config_files`・`working_dir` のラベル：Compose は、`-f` と `--project-directory` で渡した絶対パスを、そのまま（ファイルが複数ならカンマ区切りで）ラベルに入れる、という想定で比べている。**実際の値は未確認**（Compose のプロジェクトがないので、今は読めない）。
  - ボリューム：すべてのボリュームの名前の一覧を、操作の前後で比べる。
  - healthcheck：`compose ps` の `Health` が `healthy` であることと、`inspect` の `.State.Health.Status` が `healthy` であること（up の後だけ。down の前は問わない）。
  - コンテキスト：`DOCKER_HOST`・`DOCKER_CONTEXT` があれば止まり、`docker context show` が `desktop-linux` であることを確かめる。子プロセスには `HOME` を渡すので、`~/.docker` の設定のコンテキストが使われる。
  - **食い違いの可能性（要注意）：** Compose の `tmpfs:` は `HostConfig.Tmpfs` に入り、`inspect` の `Mounts` には出てこない、という想定で、`Mounts` が初期化用のbindマウント1つだけであることを確かめている。もし Docker が tmpfs を `Mounts` にも載せる場合は、次のことが起きる。
    - up の後の確認が `inspect: mounts` で失敗する（コンテナは残る）。
    - down の前の確認も `CONTAINER_INSPECT_MISMATCH` で止まり、**ラッパーでは片付けられない。**
    - そのときは、手作業で削除せずに報告し、照合の条件の見直しを先に行う。最初の起動の前に、この場合の扱いを決めておく。
    - → Step 3-10A で、tmpfs の表し方の違い（A・B・C）を受け付けるように判定を直した（下記）。
  - ネットワーク：up は `katana-test_default` を作り、down はそれを削除する。ラッパーは、ネットワークを操作の前後で確かめていない（安全上の問題は小さいが、記録しておく）。
  - up の確認の問い合わせ：`docker compose up` には `-y`（すべての問い合わせに yes と答える）がある。ラッパーは付けていない。問い合わせが出た場合は、yes と答えずに失敗する見込み（安全側）。
- **実装の状態の整理:**
  - **A. 実装済み・静的検証済み**（単体テストと静的検査で確認）：
    - `assertTestDatabaseTarget()`・`assertTestDatabaseCredentials()`
    - 統合テストのrunner（確認モード）・`testdb-migrate`（確認モード）・Prisma CLIのテストDBモード
    - ラッパーの `--check`・`--status`・`--up`・`--down` の検証の流れ、変更操作の許可リスト
    - 通常テストと統合テストの分離、接続経路の静的検査
    - `docker compose config` の照合と、3つの確認モードは、架空の `.env.test` を使って実際に実行し、成功している（3-9B・3-9C）。
  - **B. 未実装：**
    - `reset`
    - **`testdb-migrate` の接続後の本人確認**（`verifyDatabaseIdentity` は、今は必ず `IDENTITY_CHECK_NOT_IMPLEMENTED` で止まる。そのため、Step 3-12 の migration は、このままでは実行できない）
    - globalSetup への接続処理の組み込み（`verifyIntegrationDatabase()` は実装済みだが、DBドライバにつながっていない）と、setupFiles での各ワーカーの照合
    - 5434番の `lsof` による確認（ラッパーは `docker ps --filter publish=5434` で代用）
    - `logs`
    - Step 3-13 のドキュメント
  - **C. 実装済みだが実動作は未検証：**
    - `up --apply`・`down --apply`（Compose v5.1.3 での実際の動作、`ps`・`inspect` の実際の出力の形、`config_files`・`working_dir` のラベルの値、tmpfs と `Mounts` の関係）
    - `--status` の実際の出力
    - R7
    - 初期化スクリプト（ロールの作成、所有者の変更、コメントの設定）、healthcheck が初期化の完了まで healthy にならないこと
    - `katana_test_user` の権限での migration、runner・`testdb-migrate` の通常実行モード
  - **D. 外部への操作で、明示的な承認が必要なもの：**
    - `.env.test` の作成（ユーザーが行う。Step 3-10）
    - `testdb:up -- --apply`・`testdb:down -- --apply`（Dockerの起動・停止）
    - DBへの接続（読み取りを含む）
    - migration と `prisma migrate diff`（Step 3-12）
    - 統合テストの実行（Phase 4）
    - `CLAUDE.md` の変更（Step 3-13）
- **PLANとの差（PLANの内容は変更していない。差として記録する）:**
  - Step 3-11 の完了条件「DBのコメントが一致する」は、ラッパーでは確かめられない（ラッパーはDBに接続しない）。DBに接続して確かめる処理（`testdb-migrate` の本人確認など）を先に実装するか、Step 3-11 の完了条件の確かめ方を決める必要がある。
  - Step 3-12 は、`testdb-migrate` の本人確認が未実装なので、実施条件を満たせない。
  - 2-3 の `testdb:reset` は、最後に migration用スクリプトを実行する手順になっている。そのため、本人確認が実装されるまでは、reset を実装しても最後まで進められない。
  - 2-5 の「up の前に `lsof` で5434番を確かめる」は、`docker ps --filter publish=5434` に置き換えている（3-9D の記録のとおり）。
- **次に実装すべきもの（提案。着手には指示と承認が必要）:**
  1. `testdb-migrate` の接続後の本人確認：`pg` で1回だけ接続し、`BEGIN READ ONLY` の中で `current_database()`・`current_user`・DBのコメントを照合する。
     - 静的検査の規則1（`pg` の許可リスト）を変える必要があるので、設計を先に示す。
     - Step 3-11 の「DBのコメントの照合」にも使える。
  2. `reset`（down → up → 操作後の確認 → migration）。1の後に実装する。
  3. globalSetup への接続処理の組み込みと、R14 の残課題1の対策（Phase 4 の前）。
- **初回の up の前に満たすべき条件（チェックリスト）:**
  1. `.env.test` が安全に作られている（Step 3-10。ユーザーが行う）:
     - `umask 077` で作る。権限は `-rw-------`。
     - キーは `DATABASE_URL`・`KATANA_TEST_DB_PASSWORD`・`KATANA_TEST_DB_ADMIN_PASSWORD` の3つだけ。
     - パスワードは `[A-Za-z0-9_-]` だけで、見本の値ではない。URLのパスワードとアプリ用のパスワードが一致し、管理用のパスワードは違う。開発用DBのパスワードは流用しない。
     - `git status` に出てこない（`.gitignore:36` の `.env*` で除外されることを、`git check-ignore -v --no-index .env.test` で確認済み）。
     - `npm run testdb:check`・`npm run test:integration:check`・`npm run testdb:migrate:check` が、3つとも成功する。
  2. `postgres:15` がローカルにある（調査の時点で確認済み。ラッパーは取得しない）。
  3. Dockerのコンテキストが `desktop-linux`。`DOCKER_HOST`・`DOCKER_CONTEXT` が設定されていない。
  4. 5434番が空いている（`docker ps -a --filter publish=5434` と `lsof -nP -iTCP:5434 -sTCP:LISTEN` の両方で確かめる）。
  5. 開発用ボリュームの記録（名前・作成日時・ラベル・使っているコンテナ）と、`katana-db` の有無を、起動の前に記録する（`npm run testdb:status`）。
  6. テスト用のコンテナ・ボリューム・Compose のプロジェクトが存在しない。
  7. 本物の `.env.test` で、`docker compose config` の照合（`testdb:check`）が通る。
  8. `npm run testdb:up`（`--apply` なし）の出力を確認し、そのうえで `--apply` の承認を得る。
  9. up が失敗したときの調べ方と戻し方を決めておく:
     - `--status` で状態を見る。
     - `testdb:down`（`--apply` なし）で確認してから、`testdb:down -- --apply` で片付ける。
     - down が確認で止まった場合（tmpfs と `Mounts` の食い違いなど）は、`docker rm` などを手作業で実行せずに報告する。
  10. R7 を起動の後に確かめられる:
      - ラッパーの起動後の確認（すべてのボリュームの一覧の比較、`inspect` の Mounts・Tmpfs）
      - あわせて、読み取り専用の `docker inspect katana-test-db --format '{{json .Mounts}} {{json .HostConfig.Tmpfs}}'` と、起動の前後の `docker volume ls`
- **reset の扱い（未実装のまま。今回は実装しない）:**
  - PLANの仕様（2-3）：2-5の操作前の照合 → `down` → `up` → 操作後の照合 → migration用スクリプト。データは tmpfs にあるので、コンテナを作り直せば消える。SQLによる削除は使わない。
  - reset で削除されるもの：
    - テスト用コンテナ `katana-test-db`（down）
    - Compose が作るネットワーク `katana-test_default`（down で削除され、up で作り直される）
    - tmpfs 上のテストデータ（コンテナの削除とともに消える）
  - ボリュームへの影響：名前付きボリュームはない。`down` に `--volumes` を付けないので、ボリュームは削除しない。もし R7 の結果、無名のボリュームが作られていた場合は、それも削除されずに残る（up の後の確認で検出して止まる）。
  - 開発用ボリュームへの操作を禁止する条件（reset を実装するときに、そのまま守る）:
    - 変更操作は、`mutate` の許可リスト（固定の up・down）だけを使う。`--volumes`・`-v`・`--remove-orphans`・`--rmi`、`docker volume rm`・`prune`、`docker system prune` は使わない。
    - `katana-db` と `katana-web_postgres_data` を対象にするコマンドは、読み取り（`ps --filter`・`volume inspect --format`）以外には実行しない。
    - 次の場合は、何も操作せずに止まる：テスト用コンテナが開発用ボリュームを使っている、volume 型のマウントがある、プロジェクトにボリュームがある。
    - 操作の前後で開発用DBの記録を比べ、違えば止まる。開発用ボリュームを、自動で作り直したり元に戻したりしない。
    - migration の手順は、本人確認（上の「次に実装すべきもの」の1）が通った場合だけ進む。
- **残る安全上の懸念:**
  - tmpfs と `inspect` の `Mounts` の関係（上記）。食い違えば、ラッパーで down できなくなる。
  - `config_files`・`working_dir` のラベルの実際の値。
  - R7。
  - R14 の残課題（globalSetup・`lib/prisma.ts` を直接起動する経路、`docker compose` の直接実行）。
  - Docker以外のプロセスによる5434番の使用は、ラッパーでは見つけられない（チェックリストの4で、`lsof` を手作業で確かめる）。
  - `testdb-migrate` の本人確認が未実装なので、Step 3-12 に進めない。

**Step 3-10A（tmpfs の判定と、障害時の復旧のしやすさの修正。コード・単体テスト・PLANの更新だけ）**

- Dockerの変更操作、DBへの接続、migration、統合テストは行っていない。Dockerのコマンドも、このStepでは実行していない（読み取り系を含む）。
- 変更：`scripts/testdb.mts`、`scripts/testdb.test.ts`、本ファイル。commit は `8471705`（`test: validate test database tmpfs mounts safely`。親は `5fcc259`）。commit の前に、`git diff --cached --check` が0件であること、秘密情報・想定外の変更・安全ガードの緩和がないことを確かめた。
- **修正した理由：** Step 3-10の実施前レビューで、次の想定が確かでないことが分かった。
  - それまでの想定：データ領域の tmpfs は `HostConfig.Tmpfs` にだけ現れ、`inspect` の `Mounts` には初期化用の bind が1つだけある。
  - Docker の公式ドキュメント（Storage › tmpfs mounts）の記載：
    - `--mount type=tmpfs` は、`Mounts` に `{"Type":"tmpfs",…,"Destination":…}` の形で現れる。
    - `--tmpfs` は、パスとオプションの対応表（`{"/app":""}`）の形で示されている。この例は `.Mounts` の出力として載っていて、どのフィールドに出るのかが、ドキュメントからは確定できない。
  - Compose の `tmpfs:` 指定（サービスの属性。パスとオプション）が、どちらの形で現れるかは、バージョンによって違い得る。
  - 想定と違う形だった場合、正常なテストDBのコンテナが2か所で拒否される。そのため、ラッパーでは片付けられなくなるおそれがあった。
    - up の後の確認（`inspect: mounts`）
    - down の前の確認（`CONTAINER_INSPECT_MISMATCH`）
- **tmpfs の判定の仕様**（`mountMismatches()`。up の後の確認と down の前の確認の両方で使う）:
  - `inspect` で読む項目に、`HostConfig.Mounts` と `Config.Volumes` を加えた。`Config.Volumes`（イメージの `VOLUME` 宣言）は、実際のマウントではないので、判定には使わない。
  - 許可するマウント：
    - 初期化用ディレクトリ（`katana-web/docker/test-db/init` → `/docker-entrypoint-initdb.d`）の読み取り専用の bind、1つだけ（`Mounts` では `RW: false`、`HostConfig.Mounts` では `ReadOnly: true`）
    - データ領域（`/var/lib/postgresql/data`。パスは完全一致）の tmpfs
  - 受け付ける tmpfs の表し方：
    - A. `Mounts` は bind だけで、`HostConfig.Tmpfs` にデータ領域がある（オプションの値は問わない）
    - B. `Mounts` に `Type: tmpfs` のデータ領域がある。`HostConfig.Mounts` にもある場合は、両方が一致すること
    - C. `Mounts` と `HostConfig.Tmpfs` の両方にデータ領域がある
  - 拒否するもの（項目名だけを返し、パスなどの値は含めない）：
    - `Type: volume` のマウント（`Mounts`・`HostConfig.Mounts` のどちらでも）
    - データ領域への bind
    - ほかのパスの tmpfs（親ディレクトリ、末尾に `/` を付けたものを含む）
    - ほかの bind（書き込み可能な初期化用の bind、別の場所の初期化用の bind を含む）
    - 不明な種類のマウント
    - 初期化用の bind がない、または2つ以上ある
    - データ領域の tmpfs が確認できない
    - データ領域の tmpfs の重複
    - 矛盾：データ領域の tmpfs を `HostConfig.Tmpfs` と `HostConfig.Mounts` の両方で指定している、`HostConfig.Mounts` で指定したものが `Mounts`（実際のマウント）にない、同じパスに tmpfs 以外のマウントがある
    - `Mounts`・`HostConfig.Mounts` が配列でない、`HostConfig.Tmpfs` が対応表でない
  - ボリュームの一覧の増減の確認（すべてのボリュームの名前を、操作の前後で比べる）は、そのまま残した。実際に無名のボリュームが作られた場合は、`Mounts` の `Type: volume` と、一覧の比較の両方で見つかる。
- **up の後の確認への影響：** マウントの照合を `mountMismatches()` に置き換えた。A・B・C のどれでも、正常なコンテナは確認に通る。拒否するものに当たれば、今までどおり `POST_CHECK_FAILED` で止まり、何も削除しない。
- **down の前の確認への影響：**
  - 同じ `mountMismatches()` を使う。状態は問わない。created・running（healthy・starting・unhealthy）・exited の、どれでも down できる。
  - up がタイムアウトした後に残ったコンテナも同じで、A・B・C のどれでも down できる。
  - 同一性の確認は、今までどおり行う：名前、プロジェクト・サービス・Composeファイル・作業ディレクトリのラベル、開発用ボリュームを使っていないこと、不明なサービス・コンテナがないこと。
- **障害時の扱い（down を実行せずに止まる場合）と、手作業で戻す場合:**
  - 止まる場合：`inspect` が失敗した、名前・ラベルが合わない、開発用ボリュームを使っている、不明なマウント・サービス・コンテナがある、そのほか対象を確実に特定できない。
  - ラッパーから `docker rm` などを直接実行する救済の経路は、追加していない。
  - 手作業で戻す必要が出た場合は、作業を止めて報告し、**操作ごとに個別の承認を得る**。調べる項目（どれも読み取りだけ）:
    1. `npm run testdb:status` の出力（プロジェクトのコンテナ・ボリューム、5434番、開発用DBの記録）
    2. ラッパーが止まったときのエラーコードと、不一致の項目名
    3. `docker ps -a --filter name=^katana-test-db$ --format '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Label "com.docker.compose.project"}}'`
    4. `docker inspect katana-test-db --format '{{json .Mounts}} {{json .HostConfig.Mounts}} {{json .HostConfig.Tmpfs}} {{json .Config.Labels}}'`（`Config.Env` は読まない）
    5. `docker volume ls` と、開発用ボリュームの記録（名前・作成日時・ラベル）。Step 3-9・3-10の記録と比べる。
    6. 原因が判定の条件にある場合は、手作業で削除する前に、判定の見直しを先に行う。
- **テスト**（`scripts/testdb.test.ts`。188件→250件）:
  - `mountMismatches()`：
    - A・B・C を許可する。`HostConfig.Mounts` がない場合、オプションがある場合、`Config.Volumes` に宣言がある場合・ない場合も許可する。
    - 拒否するもの（上の一覧）を、それぞれ拒否する。返す項目名に、パスや開発用ボリュームの名前が含まれない。
  - up の後の確認：A・B・C のどれでも通る。データ領域への volume・bind、不明な tmpfs、tmpfs がない、指定の矛盾では、`POST_CHECK_FAILED` で止まり、何も削除しない。
  - down の前の確認：
    - A・B・C と5つの状態（created・healthy・starting・unhealthy・exited）の組み合わせで、固定の down を1回だけ実行する。開発用ボリュームに対しては、読み取りのコマンドだけを実行する。
    - up のタイムアウト後に残ったコンテナ（B）も片付けられる。
    - unhealthy・exited のコンテナで、不明なマウント・tmpfs がない・矛盾があれば、down しない。
  - 既存のテストは skip していない。
- **確認済み:**
  - `npx tsc --noEmit`、`scripts/testdb.mts`・`scripts/testdb.test.ts` の `eslint` が成功した。`git diff --check` は0件。
  - `npm test` は29ファイル・940件がすべて成功した（878件＋62件）。`dbConnectionPaths.test.ts` は148件が成功し、静的検査の違反は0件。
  - `npx vitest list --filesOnly` は29件で、`*.integration.test.*` は0件。統合テスト用の設定では6件。
- **migration の前と後の、DBの検査の分け方（設計の記録。実装・`pg` の許可リストの変更は次の工程）:**
  - 今の `verifyIntegrationDatabase()`（`lib/testing/integrationDatabaseCheck.ts`）は、次の4つを順に確かめる。
    1. 本人確認：`current_database()`・`current_user`・`session_user`・DBのコメント
    2. テーブルの構成：期待するテーブルと `_prisma_migrations` 以外のリレーションがない
    3. migration の履歴：期待する名前と完全一致し、失敗・ロールバックがない
    4. 空DB検査
  - これは migration の**後**の状態を前提にしている。また、接続前の検証は `assertIntegrationProcessEnv()`（runner から起動されたことが条件）で行っている。
  - そのため、migration の前のDBや、`testdb-migrate` から呼ぶ場面には、そのまま使えない。
  - **A. migration の前**（`testdb-migrate` の手順8。Prisma CLI を起動する直前）:
    - 接続前の検証は、`testdb-migrate` が検証済みの接続先（`.env.test` の値と、`assertTestDatabaseTarget()`・`assertTestDatabaseCredentials()`）を使う。runner の起動経路の条件は使わない。
    - 接続は1回だけ。`BEGIN READ ONLY` の中で SELECT だけを行い、最後に ROLLBACK する。
    - 本人確認：`current_database() = katana_test`、`current_user`・`session_user` = `katana_test_user`、DBのコメント = `katana-test-db`。
    - システム以外のスキーマに、リレーションが1つもない（アプリのテーブルも `_prisma_migrations` もない）。
    - migration の後の条件（15テーブル・8件の履歴・空DB）は、ここでは使わない。
  - **B. migration の後**（Step 3-12 の照合と、統合テストの開始前の globalSetup）:
    - 本人確認（Aと同じ）。
    - アプリのテーブルが、`schema.prisma` の15モデルとちょうど一致し、それと `_prisma_migrations` 以外のリレーションがない。
    - `_prisma_migrations` が、`prisma/migrations` の8件とちょうど一致し、すべて完了していて、ロールバックがない。
    - アプリのテーブルが空。
    - 今の `verifyIntegrationDatabase()` の中身は、ほぼBに当たる。
  - 実装の方針（案）：
    - 本人確認と、リレーション・migration・空DBの検査を、接続済みのクライアントを受け取る関数に分ける。
    - 接続前の検証は、呼び出し側（`testdb-migrate`・globalSetup）が、それぞれの条件で行う。
    - `pg` の読み込みは、静的検査の規則1の許可リストに、1ファイルだけ追加する（ディレクトリ単位では許可しない）。
  - **設計判断（ユーザーの決定。2026-11-04）：** `testdb-migrate` は、接続後の本人確認に通った後、DBの状態を次の3つに分けて扱う。
    - 状態の判定は、本人確認（DB名・`current_user`・`session_user`・DBのコメント）に通った後にだけ行う。本人確認に失敗すれば、どの状態でも止まる。
    - **A. migration を1件も適用していない、完全に空のDB** → 本人確認の後、`prisma migrate deploy` を許可する。
      - 「完全に空」とは、システム以外のスキーマにリレーションが1つもないこと（アプリのテーブルも `_prisma_migrations` もない）。
    - **B. migration を途中まで適用した、または失敗したDB** → 拒否して止まる。
      - 該当するのは、AでもCでもない状態のすべて。例：`_prisma_migrations` だけがある、件数が足りない、失敗・ロールバックの記録がある、テーブルが足りない・余分にある。
      - 自動で migration を続けることも、自動で `reset` することもしない。作り直しは、ユーザーの指示と承認を得て、別の操作として行う。
    - **C. migration をすべて適用済みのDB** → 本人確認と、migration の後の検査（上のB）に成功した場合だけ、migration を実行し直さずに成功とする。
      - Prisma CLI は起動しない。
      - migration の後の検査の空DB検査を含むので、データが残っていれば止まる。
  - **想定する migration：** 今は8件（`prisma/migrations` の、`migration.sql` を持つディレクトリ）。新しい migration を追加したときは、期待する名前と件数を見直す。期待する一覧は、`prisma/migrations` から毎回読み取り、DBの `_prisma_migrations` と名前で完全一致を確かめる。件数を数えるだけの照合にはしない。
  - **DBの構造の検査の範囲:**
    - 確かめること（今の `verifyIntegrationDatabase()` と同じ範囲）:
      - 本人確認：`current_database()`、`current_user`、`session_user`、DBのコメント（`pg_database` の `shobj_description`）。
      - リレーション：システム以外のスキーマ（`pg_catalog`・`information_schema`・`pg_toast*`・`pg_temp_*` 以外）の、テーブル・パーティションテーブル・ビュー・マテリアライズドビュー・外部テーブル（`relkind` が `r`・`p`・`v`・`m`・`f`）の名前とスキーマ。
        - A：1つもない。
        - C：`public` スキーマの、`schema.prisma` の15モデルのテーブルと `_prisma_migrations` だけ。
      - migration の履歴（Cだけ）：`_prisma_migrations` の `migration_name` が期待する8件と完全一致し、すべて `finished_at` があり、`rolled_back_at` がない。
      - 空DB検査（Cだけ）：15テーブルのどれにも行がない。
    - 確かめないこと:
      - 列・型・インデックス・制約・シーケンス・関数・enum型などの、テーブルの中身の定義。
      - スキーマとの差分。これは Step 3-12 の `prisma migrate diff` で照合する。
    - 検討事項（未決定）：Aの「完全に空」の判定に、システム以外のスキーマの、ユーザー定義の型（enum など）・シーケンス・関数がないことを加えるか。途中で失敗した migration の残りを見つけやすくなる。実装の前に決める。
      - → 決定（Step 3-10B の指示）：加える。enum・domain などの型、シーケンス、インデックス、関数・プロシージャ、想定外のスキーマ・拡張も確かめる（3-10B の記録）。
  - **実DBによる検証は、まだ行っていない。** A・B・C の判定は、Step 3-10B で実装した（下記）。`testdb-migrate` の手順8への組み込みは、まだ行っていない。
- **未検証のまま残ること:**
  - 実際の `up`・`down`。
  - R7。
  - Compose のラベル（`config_files`・`working_dir`）の実際の値。
  - Docker Desktop が実際にどの形で tmpfs を表すか（A・B・C のどれか）。
  - 実DBへの接続。

**Step 3-10B（migration の前後のDBの状態の判定。実装・単体テスト・PLANの更新だけ）**

- 前提：ブランチ `chore/test-db-isolation`、HEAD `8471705`（Step 3-10A）。Step 3-10A の commit hash `8471705` を、表と3-10Aの記録に記入した。
- **実DBへの接続・Dockerの操作・migration・Prisma CLI のDB操作・統合テストの実行は、行っていない。** `testdb-migrate` の通常実行モードの強制停止（`IDENTITY_CHECK_NOT_IMPLEMENTED`）と、globalSetup の強制停止は、そのまま残した。新しい判定の関数は、どこからも呼ばない。
- 作成・変更したファイル（未commit）:
  - 新規 `lib/testing/testDbState.ts`：状態の判定（`classifyTestDatabase()`・`classifyCatalogInventory()`・`readCatalogInventory()`・`enumNamesFromSchema()`）。`pg` は読み込まない。接続は `connect` として受け取る。
  - 新規 `lib/testing/testDbConnection.ts`：`pg` を直接 import する唯一のファイル。`connectTestDatabase(url)` を呼んだときだけ、1回接続する（接続タイムアウト10秒、クエリ・文のタイムアウト30秒）。接続に失敗したら、閉じてから元のエラーを投げる。
  - 新規 `lib/testing/testDbState.test.ts`（84件。レビュー前は81件）、`lib/testing/testDbConnection.test.ts`（4件。`pg` を factory 付きの `vi.mock` で置き換える）。
  - 変更 `lib/testing/integrationDatabaseCheck.ts`：部品を export して共有できるようにした。`verifyIntegrationDatabase()` の動作は変えていない（既存の54件はそのまま成功）。
    - 接続の開始・終了を `runReadOnlyCheck()` に切り出した（接続は1回、`BEGIN READ ONLY`、成功・失敗にかかわらず ROLLBACK と `end()`、最初の失敗を優先）。
    - 本人確認を `assertDatabaseIdentity()` として export した。
    - migration の履歴の比較を `compareMigrationHistory()`、空DB検査を `findNonEmptyTables()` に分けた。
    - `@map` などの拒否を `assertSupportedSchema()` に分けた。
    - エラーコード `TARGET_REJECTED` を追加した。
  - 変更 `lib/testing/dbConnectionPaths.test.ts`：`pg` の許可リストの追加（下記）と、通常テストの期待件数（29→31）。
- **責務の分け方:**
  1. 接続：`testDbConnection.ts` の `connectTestDatabase()`（呼び出し側が渡す）
  2. 本人確認：`assertDatabaseIdentity()`
  3. migration の前の空DBの判定、4. migration の後の完了状態の判定：`classifyCatalogInventory()`（カタログの一覧から判定する純粋関数）と、C の候補のときだけ読む履歴・空DB検査
  5. 接続の終了：`runReadOnlyCheck()`
  - runner 専用の起動条件（`assertIntegrationProcessEnv()`）は、状態の判定では使わない。`classifyTestDatabase()` は、呼び出し側が検証した接続URLを受け取り、接続の前にもう一度 `assertTestDatabaseTarget()` で確かめる（`env` は空。環境変数の検査は呼び出し側の責任）。
- **手順:**
  1. 期待値（テーブル・enum・migration の一覧）と接続URLを、接続の前に検証する。
  2. 1回だけ接続する。
  3. `BEGIN READ ONLY`。`SHOW transaction_read_only` が `on` であることを確かめる。
  4. 本人確認（`current_database() = katana_test`、`current_user`・`session_user` = `katana_test_user`、DBのコメント = `katana-test-db`）。**失敗したら throw し、カタログを読まない（状態を返さない）。**
  5. カタログの一覧を読む。
  6. 状態を判定する。
  7. ROLLBACK して接続を閉じる。
  - 実行する SQL は SELECT・SHOW・`BEGIN READ ONLY`・ROLLBACK だけ（単体テストで確認）。
- **PostgreSQL のカタログの検査範囲:**
  - システムのスキーマは対象外：`pg_catalog`、`information_schema`、`pg_toast*`（`pg_toast_temp_*` を含む）、`pg_temp_*`。
  - スキーマ（`pg_namespace`）：`public` だけを許す。`public` がなければ B。
  - 拡張（`pg_extension`）：`plpgsql` だけを許す（なくてもよい）。
  - リレーション（`pg_class`。`relkind` が `c` 以外のすべて）：テーブル・パーティションテーブル・ビュー・マテリアライズドビュー・外部テーブル・シーケンス・インデックス・パーティションインデックス。
    - インデックスは対象のテーブル（`pg_index`）を、シーケンスは所有するテーブル（`pg_depend` の `deptype` が `a`・`i`）を一緒に読む。
  - 型（`pg_type`）：enum・domain・複合型・range・multirange・基本型など。
    - **二重に数えないもの：** テーブル・ビューなどの行型（リレーションの側で数える）、型ごとに自動で作られる配列型（元の型の側で数える）、独立した複合型の `pg_class` の行（型の側で1回だけ数える）。
    - range 型と、自動で作られる multirange 型は、別々に数える。
  - 関数・プロシージャ・集約関数・ウィンドウ関数（`pg_proc`）。
  - その他のユーザー定義オブジェクト：OID が 16384（FirstNormalObjectId）以上のものを、種類ごとに数える。対象は、演算子・演算子クラス・演算子族・照合順序・変換・キャスト・言語・全文検索の4種類・拡張統計・ルール・トリガー（外部キーの内部トリガーを除く）・ポリシー・イベントトリガー・パブリケーション・外部データラッパー・外部サーバー・デフォルト権限・ラージオブジェクト・アクセスメソッド・変換（23種類。最後の2つは commit の前のレビューで追加した）。
  - 数えないもの：
    - 制約・列の既定値（C の定義の一致は Step 3-12 で照合する）。
    - サブスクリプション・ユーザーマッピング（一般ユーザーが読めないカタログ。作るにはスーパーユーザーの権限が必要）。
- **A・B・C の判定条件:**
  - **A**：次をすべて満たす。
    - スキーマは `public` だけ。
    - 拡張は `plpgsql` だけ。
    - リレーション・型・関数・その他のオブジェクトが0件（`_prisma_migrations` もない）。
  - **C**：A と同じ「想定外のもの」の条件（スキーマ・拡張・関数・その他のオブジェクト）に加えて、次をすべて満たす。
    - `public` のテーブル（`relkind` が `r`）が、`schema.prisma` の15モデルと `_prisma_migrations` にちょうど一致する。
    - インデックス・シーケンスは、それらのテーブルのものだけ。インデックスの定義は照合しない。
    - ビュー・マテリアライズドビュー・外部テーブル・パーティションテーブルがない。
    - 型は、`public` の enum だけ。名前は `schema.prisma` の5つとちょうど一致する。
    - migration の履歴が、`prisma/migrations` の名前（今は8件）と完全一致する。失敗・未完了・ロールバック・重複の記録がない。
    - アプリの15テーブルが空。
    - 結果には `schemaDiff: "not-verified"` を付ける。列・型の中身・インデックス・制約の一致は、Step 3-12 の `prisma migrate diff` で照合するまで保証しない。
  - **B**：A にも C にも当たらないものすべて。判定の理由（オブジェクトの名前と件数。20件を超える分は件数だけ）を返す。例：
    - 履歴が1件・3件だけ、失敗・ロールバック・重複の記録がある。
    - `_prisma_migrations` だけがある。
    - 履歴はあるがテーブルが足りない。
    - enum・シーケンス・関数・domain だけがある。
    - 想定外のテーブル・ビュー・スキーマ・拡張がある。
    - データが残っている。
  - **判定の順序:**
    - C の構造の条件を満たさないときは、migration の履歴も空DB検査も読まない。想定外のテーブルには触れない。
    - `_prisma_migrations` が `public` のテーブルとしてないときは、履歴を読まない。
  - **検査そのものの失敗は B としない。** SQL のエラー・接続の失敗・ROLLBACK や `end()` の失敗・本人確認の失敗は、例外（`QUERY_FAILED`・`CONNECT_FAILED`・`CLOSE_FAILED`・本人確認の各コード）を投げて止まる（fail-closed）。
  - 件数として読めない値は、オブジェクトがあるものとして扱う。
- **期待値:**
  - テーブルは `applicationTablesFromSchema()`、enum は `enumNamesFromSchema()`、migration は `listMigrationNames()` で、実際のファイルから毎回読む。件数は固定しない。
  - 単体テストでは、今のファイルから読んだ値が15テーブル・5 enum・8件で、名前が一致することを確かめた。新しい migration を追加したときは、このテストの名前の一覧を見直す。
  - 期待する migration の名前が重複していれば、接続の前に拒否する。
- **`pg` の許可リストの変更（静的検査の規則1）:**
  - `lib/testing/dbConnectionPaths.test.ts` に、`ALLOWED_PG_DRIVER_FILES = ["lib/testing/testDbConnection.ts"]`（ファイル単位の完全一致）を追加した。
  - このファイルでは、パッケージ名がちょうど `pg` の参照だけを許可する。
    - pg のサブパス・`pg-pool`・`pg-native` は許可しない。
    - `@prisma/adapter-pg` と PrismaClient も許可しない。
  - 既存の許可リスト（`lib/prisma.ts`・`prisma/seed.ts`）と、ほかの規則は変えていない。
  - 規則4では、このファイルをDB接続モジュールとしては扱わず、中の `pg` の参照で判定する。
    - `testDbConnection.test.ts` は、`pg` を factory 付きの `vi.mock` で置き換えているので、DBに到達しない。
    - モックを無視すると、`pg` に到達することもテストで確かめた（解析の空振りの検出）。
  - 追加したテスト：
    - 完全一致の `pg` だけを許可し、サブパスや別のパスでは検出する。
    - ファイルが実在し、中身を別のパスに置くと `pg-driver` として検出される。
- **追加したテストと結果:**
  - `testDbState.test.ts` 81件（レビューで3件追加し、84件）：本人確認の成功・各不一致、A、A の崩れ（enum・シーケンス・インデックス・関数・プロシージャ・domain・複合型・range・スキーマ・拡張・ビュー・外部テーブル・その他のオブジェクト）、C、B（履歴1件・3件・失敗・ロールバック・重複・余分・空、`_prisma_migrations` だけ、テーブル不足、想定外のテーブル・ビュー・インデックス・シーケンス・型・関数・スキーマ・拡張・トリガー、データあり）、SQL の失敗の fail-closed、接続の解放、SQL の種類、秘密情報。
  - `testDbConnection.test.ts` 4件：import しただけでは接続しない、1回だけ接続する、接続の失敗時に閉じる。
  - `dbConnectionPaths.test.ts` は4件増えた（152件）。
  - 既存の `integrationDatabaseCheck.test.ts` 54件は、変更せずにすべて成功した。
- **確認済み:**
  - `npx tsc --noEmit` が成功した。変更・新規の6ファイルの `eslint` も成功した。`git diff --check` は0件。
  - `npm test` は31ファイル・1029件がすべて成功した（940件＋89件）。レビューの修正の後は1032件（下記）。
  - `npx vitest list --filesOnly` は31件で、`*.integration.test.*` は0件。
- **migration runner（`testdb-migrate`）への組み込みの設計（未実施。別工程）:**
  - `scripts/testdb-migrate.mts` の `verifyDatabaseIdentity` の仮の関数を、`classifyTestDatabase()` を呼ぶ関数に置き換える。
    - `connect` には `connectTestDatabase` を渡す。
    - 期待値は、`prisma/schema.prisma` と `prisma/migrations` から読む。
  - `runTestDbMigrate()` の手順8で、結果に応じて分ける。
    - A：手順9に進む（`prisma migrate deploy`）。
    - C：Prisma CLI を起動せずに成功とする。
    - B：理由を表示して停止する。
    - 例外：停止する。
    - そのため、手順8の戻り値の型を変える（今は `Promise<void>`）。
  - 接続は、確認モードでは行わない。通常実行モードの手順8だけで行う。
  - 接続の前の条件：
    - 親のプロセスに `PG*` の環境変数がないことを確かめる。`pg` は、URL にない設定を `PG*` から補うため。
    - 接続URLは、手順5・6で検証済みの値だけを使う。
  - migration の後には、もう一度 `classifyTestDatabase()` を呼び、C であることを確かめる（Step 3-12）。
  - globalSetup への組み込みは別の工程とする。`verifyIntegrationDatabase()` と `connectTestDatabase` を使う。
- **未実施・未検証のまま残ること:**
  - `testdb-migrate`・globalSetup への組み込み。どちらも強制停止のまま。
  - 実DBへの接続。
    - カタログの SQL が PostgreSQL 15 で実際に動くこと。
    - `katana_test_user` の権限で読めること（`pg_default_acl`・`pg_largeobject_metadata`・`pg_publication` など）。
    - 初期化直後のDBが本当に A と判定されること（initdb が作ったオブジェクトの OID が 16384 未満であることを含む）。
  - `prisma migrate diff` による定義の照合（Step 3-12）。
  - `reset`（未実装）。
  - 実際の `up`・`down`、R7、Compose のラベルの実際の値、tmpfs の実際の表し方（Step 3-10A から引き続き）。
- **カタログ検査のレビュー（commit の前。ユーザーの指示による。2026-11-04）:**
  - 判断の根拠：PostgreSQL 15 の仕様、`docker/test-db/init/` の2つのスクリプト、8件の migration の SQL。
    - migration が作るのは、テーブル・enum・インデックス（UNIQUE を含む）・`ALTER TABLE` による制約と外部キーだけ。
    - 関数・トリガー・シーケンス・ビュー・スキーマ・拡張・`ALTER TYPE` はない。
    - 途中で作った5テーブルと2つの enum（`Era`・`KatanaType`）は、後の migration で削除済み。
  - 前提（未検証）：initdb が作る標準のオブジェクトの OID は、すべて 16384 未満。
    - CREATE DATABASE は template1 をそのまま写すので、OID も変わらない。
    - 前提が外れると、正常なDBが B になる（安全側で、誤って A・C にはならない）。初回の実DB接続で確かめる。
  - **クラスタ共通のオブジェクト**（`pg_database` のテストDB自身、ロール `katana_test_user`、`pg_shdescription` のDBのコメント）:
    - OID は 16384 以上だが、判定には使わない。読むのは、本人確認の `pg_database`（DB名とコメントの照合）だけ。
    - 初期化スクリプトの次の操作は、どれもクラスタ共通のカタログだけを変え、`katana_test` の中には何も残さない：`CREATE ROLE`、`ALTER DATABASE ... OWNER`、`REVOKE ON DATABASE postgres`、`COMMENT ON DATABASE`、`DO` ブロック。
  - **スキーマで絞り込むカタログ（OID の条件は使わない）:**
    | カタログ | 判定 |
    |---|---|
    | `pg_namespace` | `public` の OID は 2200（標準）。ほかは B。`pg_` で始まるスキーマは、ユーザーが作れない |
    | `pg_class` | テーブルの TOAST とその索引は `pg_toast` にあり、対象外。C のインデックス（主キー・UNIQUE・`@@index`）は、対象のテーブルが想定テーブルなら許す。シーケンスは、`pg_depend` の `a`（SERIAL・OWNED BY）・`i`（IDENTITY）で想定テーブルが所有するものだけを許す。今の migration にシーケンスはない |
    | `pg_type` | テーブルの行型と、enum・行型の配列型（`_UserRole` など）は、二重に数えないように除く。C の enum は5つとちょうど一致すること |
    | `pg_proc` | plpgsql の関数（ハンドラーなど）は `pg_catalog` にあり、対象外。`public` の関数・プロシージャは A・C のどちらでも B |
    | `pg_extension` | `plpgsql` だけを名前で許す（その言語・関数は `pg_catalog` にあり、OID は 16384 未満） |
    - `pg_depend` の内部依存（外部キー・インデックス・型の依存）は、数えない。シーケンスの所有者の判定にだけ使う。
  - **OID で数えるカタログ（正常な A・C のDBに OID 16384 以上の行が現れないものだけ。全カタログには使っていない）:**
    | カタログ | 判定 |
    |---|---|
    | `pg_operator`・`pg_opclass`・`pg_opfamily`・`pg_collation`・`pg_conversion`・`pg_cast`・`pg_language`・全文検索の4つ | 標準のものは initdb が作る。enum を作っても、キャストや演算子は作られない。照合順序（ICU のものを含む）は initdb が取り込む |
    | `pg_statistic_ext`・`pg_rewrite`・`pg_policy` | migration では作らない。`pg_rewrite` はビューがあると増えるが、ビューは A・C のどちらでも B |
    | `pg_trigger` | 外部キーの内部トリガー（`tgisinternal`）は C に正常に存在するので、数えない。CONSTRAINT TRIGGER を含む、ユーザーのトリガーは B |
    | `pg_event_trigger`・`pg_publication`・`pg_foreign_data_wrapper`・`pg_foreign_server`・`pg_largeobject_metadata` | migration・初期化では作らない |
    | `pg_default_acl` | 初期化スクリプトは `ALTER DEFAULT PRIVILEGES` を使わないので、行は0件のはず |
    | `pg_am`・`pg_transform` | レビューで追加した（下記） |
    - OID で数えないカタログ：
      - `pg_constraint`・`pg_attrdef`・`pg_enum`・`pg_index`・`pg_depend`・`pg_description`。C では OID 16384 以上の行が正常にある。定義の一致は Step 3-12。
      - `pg_database`・`pg_authid`・`pg_shdescription`（クラスタ共通）。
      - `pg_subscription`・`pg_user_mapping`（一般ユーザーが読めない）。
  - **A・B・C の判定のレビュー結果:** 指示の観点はすべて満たしていた。
    - A：`public` と標準のオブジェクトを許し、`_prisma_migrations` があれば A にならない。enum・シーケンス・関数などが残っていれば B。
    - B：A・C のどちらにも当たらないときだけ B。SQL の失敗は B と断定しない。想定外のテーブルからデータを読まない。migration の自動継続・reset はない（関数はDBを変更しない）。
    - C：15テーブルと `_prisma_migrations`、migration 名8件の完全一致、失敗・未完了・ロールバック・重複なし、5つの enum、全テーブルが空、想定外のオブジェクトなし。`schemaDiff: "not-verified"` を維持し、スキーマの完全一致とは扱わない。
    - 本人確認は、カタログを読む前に行う。
  - **見つけて直した問題（検査の漏れ。安全条件は緩めていない）:**
    - `pg_am`（アクセスメソッド）と `pg_transform`（変換）を数えていなかった。
      - 原因：一覧の作成時の漏れ。
      - 影響：これらが残っていても A・C と判定され得た。作るにはスーパーユーザーの権限が要る（`pg_transform` は型の所有者でも作れる）ので、テストDBで起こる可能性は低い。
      - 修正：OID で数えるカタログに追加した（21種類→23種類）。標準のアクセスメソッドは OID 16384 未満なので、誤って検出することはない。
    - 単体テストを3件追加した。
      - その他のオブジェクトの SQL が23のカタログをすべて OID で絞り込み、内部トリガーを除くのは `pg_trigger` だけで、正常なDBに OID 16384 以上の行があるカタログを OID で数えていないこと。
      - リレーション・型・関数・スキーマの一覧が、OID ではなくスキーマで絞り込み、シーケンスの所有者と暗黙の型の除き方が設計どおりであること。
      - アクセスメソッドが残っていれば B になること。
  - **残る限界（記録のみ。今回は直していない）:**
    - スーパーユーザーが `pg_catalog` にオブジェクトを作った場合、スキーマで絞り込むカタログでは見つけられない。テストDBのアプリのロールは、スーパーユーザーではない。
    - `search_path` を変えて標準の演算子・関数を隠された場合の対策（`set_config` で検査中だけ `pg_catalog` に固定するなど）はしていない。既存の `verifyIntegrationDatabase()` も同じ。`public` の関数・演算子があれば B になるが、その一覧を読む前に、ほかの検査の SQL が実行される。
    - `public` スキーマを削除して作り直した場合も、A と判定する（所有者・権限は確かめない）。
  - **初回の実DB接続のときに確かめること:**
    1. 6つのカタログの SQL が、PostgreSQL 15 でエラーなく動く。
    2. `katana_test_user` の権限で、23のカタログ（`pg_default_acl`・`pg_largeobject_metadata`・`pg_publication`・`pg_statistic_ext`・`pg_am`・`pg_transform` など）を読める。
    3. 初期化直後のDBが A になる。そのとき、OID で数えたその他のオブジェクトの件数が、すべて0（特に照合順序・変換・言語）。
    4. `migrate deploy` の後のDBが C になる。
       - インデックスが、すべて想定テーブルのものとして読める。
       - シーケンスがない。
       - 型は5つの enum だけ（配列型と行型は除かれる）。
       - 内部トリガー以外のトリガーがない。
    5. 本人確認に失敗するDB（DBのコメントなし・別のDB名）では、カタログを読まずに止まる。
- **最終の確認（レビューの修正の後）:**
  - `npx tsc --noEmit` が成功した。6つのTSファイルの `eslint` も成功した。`git diff --check` は0件。
  - `npm test` は31ファイル・1032件がすべて成功した（940件＋92件）。
    - `testDbState.test.ts` は84件、`testDbConnection.test.ts` は4件。
    - `dbConnectionPaths.test.ts` は152件で、静的検査の違反は0件。
  - `npx vitest list --filesOnly` は31件で、`*.integration.test.*` は0件。統合テスト用の設定では6件。
  - commit は `daf5c8b`（`test: classify test database migration states safely`。親は `8471705`）。通常テスト1032件成功、静的検査152件・違反0件。

**Step 3-10C（`testdb-migrate` への状態の判定の組み込み。実装・単体テスト・PLANの更新だけ）**

- 前提：ブランチ `chore/test-db-isolation`、HEAD `daf5c8b`（Step 3-10B）。Step 3-10B の hash を、表と3-10Bの記録に記入した。
- **実DBへの接続・Dockerの操作・Prisma CLI の起動・migration・統合テストの実行は、行っていない。** スクリプトの通常実行モードは、今も必ず停止する（下記の「強制停止」）。globalSetup は変更していない。
- 変更したファイル（未commit）:
  - `lib/testing/testDbMigrate.ts`：14手順の流れ、A・B・C の分岐、migration の後の再判定、`createTestDatabaseClassifier()`、実DBへの接続の許可（`LiveDatabaseAccess`）。
  - `scripts/testdb-migrate.mts`：仮の本人確認の関数を、固定の `LIVE_DATABASE_DISABLED` に置き換えた。
  - `lib/testing/testDbState.ts`：search_path の固定と、`count` のスキーマ修飾。
  - `lib/testing/integrationDatabaseCheck.ts`：エラーコード `SEARCH_PATH_NOT_PINNED` の追加だけ。
  - `lib/testing/testDbMigrate.test.ts`、`lib/testing/testDbState.test.ts`。
  - `pg` の許可リスト・静的検査の規則・テストファイルの数は変えていない。
- **手順（`runTestDbMigrate()`）:**
  1. 引数と、Node の起動オプション（execArgv・NODE_OPTIONS）を確かめる。
  2. `.env.test` を読む。
  3. `.env`（開発用DB）を読む。
  4. `assertTestDatabaseTarget()` で接続URLを確かめる。
  5. `assertTestDatabaseCredentials()` でパスワードを確かめる。
  6. **新規**：親のプロセスの `PG*`・`DOTENV_*` を拒否する（`UNSAFE_PARENT_ENV`）。
     - 状態の判定の接続は、このプロセスの中で `pg` が行い、`pg` は URL にない設定を `PG*` から補うため。
     - 確認モードでも同じように拒否する。
  7. 子プロセスの環境変数を作り、もう一度確かめる。
  8. Prisma CLI のファイルと、固定のコマンドを確かめる（確認モードはここで終わる）。
  - ここで、実DBへの接続の許可を確かめる。無効なら止まる。
  9〜11. 状態を判定する（`classifyDatabase`）：読み取り専用の接続、search_path の固定、本人確認、A・B・C の判定。
  12. A のときだけ `migrate deploy` を起動する。
  13. 別の接続で、もう一度判定する。
  14. C であることを確かめて終わる。
  - 既存の1〜8の順序と条件は、6の追加のほかは変えていない。
- **状態ごとの動作:**
  | 状態 | 動作 |
  |---|---|
  | A | 固定のコマンドで `migrate deploy` を1回だけ起動する。終了コードが0なら、別の接続で再判定する（本人確認を含む）。C なら成功。A のまま・B なら `POST_MIGRATION_STATE_MISMATCH`、再判定そのものの失敗なら `POST_MIGRATION_CHECK_FAILED`。終了コードが0でない・起動できないなら `MIGRATION_FAILED` で、再判定はしない |
  | B | 理由を表示して `DATABASE_STATE_INCONSISTENT` で止まる。Prisma CLI は起動しない |
  | C | Prisma CLI を起動せずに成功する。表示は「schema diff not verified; Step 3-12」で、スキーマの完全一致とは表示しない |
  | 判定の失敗 | 接続・本人確認・SQL・search_path の固定・接続を閉じる処理の失敗は、`STATE_CHECK_FAILED` で止まる。A・B・C のどれとも扱わず、Prisma CLI は起動しない。メッセージには元のエラーのコードだけを含める（想定外の例外は `unknown`） |
  - どの場合も、reset・自動復旧・migration の再実行はしない。失敗のメッセージには「Nothing was reset」を含める。
- **強制停止の維持:**
  - `IDENTITY_CHECK_NOT_IMPLEMENTED` を `TESTDB_MIGRATION_LIVE_DISABLED` に置き換えた。
  - `runTestDbMigrate()` は、`liveDatabase` が `{ mode: "enabled", classifyDatabase }` のときだけ判定に進む。それ以外は、すべての検証の後、接続と Prisma CLI の起動の前に止まる。
  - スクリプトは `liveDatabase: LIVE_DATABASE_DISABLED`（凍結した定数）を固定で渡す。環境変数・引数では変えられない。
  - スクリプトは、接続の部品（`testDbConnection.ts`・`createTestDatabaseClassifier`・`pg`）を読み込まない。
  - 単体テストでは、上の2点と globalSetup の強制停止を、コメントを除いたソースで確かめる。
  - **接続を有効にするには、スクリプトのコードの変更が必要**（`liveDatabase: { mode: "enabled", classifyDatabase: createTestDatabaseClassifier({ root, connect: connectTestDatabase }) }`）。これは承認を得た後続の工程で行う。
  - 偽の依存関係は、`runTestDbMigrate()` の引数でしか渡せない。スクリプトは、外部の入力から依存関係を作らない。
- **接続と子プロセスの分け方:**
  - `createTestDatabaseClassifier({ root, connect })` は、作るときに `schema.prisma`・`prisma/migrations` から期待値を読む（接続しない）。呼ぶたびに `classifyTestDatabase()` で1回だけ接続する。
  - 接続は `connectTestDatabase()` を再利用する。`pg` を読み込むファイルは増やしていない。
  - 判定には、検証済みの `.env.test` の URL だけを渡す。migration の前と後で同じ値を使い、別のURLへの接続し直しはしない。
  - 接続は次の3つで、それぞれ別。
    1. migration の前の判定（読み取り専用。終わったら閉じる）。
    2. Prisma CLI（子プロセスが自分で作る。`DATABASE_URL` は同じ検証済みの値）。
    3. migration の後の判定（読み取り専用）。
- **TOCTOU のリスク（残る）:**
  - 1の判定を閉じてから2の Prisma CLI が接続するまでの間に、DBの中身や、`127.0.0.1:5434` で応答するサーバーが変わる可能性がある（コンテナの入れ替えなど）。
  - 対策：
    - 3で本人確認と C をもう一度確かめる。
    - ポートは `127.0.0.1` にだけ公開している。
    - 間隔は短い。
  - 防げないこと：2の時点で別のDBに migration が適用されること。そのDBが本人確認に通らない限り、3で失敗として検出する。
  - 親のプロセスでロックを持ち続けても、Prisma CLI の接続を制御できないので、使っていない。
- **search_path の確認結果:**
  - カタログは、すべて `pg_catalog.` で修飾していた。`public` のテーブルは `"public"."名前"` で修飾し、名前は `quoteIdentifier()`（英数字と `_` だけ）で検証してから引用していた。URL などの外部の入力は、SQL に連結していない（定数とカタログで照合した名前だけ）。
  - 問題：関数（`current_database()`・`shobj_description()`・`inet_server_port()`・`count`）と演算子（`=`・`<>`・`>=`・`LIKE`）は、修飾していなかった。
    - ロール・DBの設定で `search_path` が `public, pg_catalog` のように pg_catalog を後ろに置いていると、public に作られた同名の関数・演算子が先に使われ、判定を偽れる。
  - 修正（状態の判定だけ）：
    - `BEGIN READ ONLY` の直後に `SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)` を実行する。トランザクションの中だけ有効で、ROLLBACK で戻る。DBは変更しない。
    - 戻り値が `pg_catalog` であることを確かめ、違えば `SEARCH_PATH_NOT_PINNED` で止まる。
    - `count` は `pg_catalog.count` に修飾した。
    - 一時スキーマはリレーションの解決では先に探されるが、検査の SQL のリレーションは、すべて修飾している。
  - 追加したテスト：
    - search_path の固定が本人確認より前に行われること。
    - 固定に失敗したら止まること（戻り値の違い・SQL の失敗）。
    - FROM・JOIN の対象がすべて `pg_catalog.pg_*` か `"public"."…"` で、URL を含まないこと。
  - 対応していないもの：既存の `verifyIntegrationDatabase()`（統合テストの globalSetup 用）は固定していない。既存の54件のテストを変えないため。globalSetup に組み込むときに、同じ固定を加える。
  - **実DB接続を有効にする前の必須の確認：** PostgreSQL 15 で、読み取り専用トランザクションの中の `set_config(..., true)` が成功し、`pg_catalog` を返すこと。
- **追加したテストと結果:**
  - `testDbMigrate.test.ts` は26件増えた。
    - A→C の正常な流れ（呼び出しの順序、判定の引数、`migrate deploy` 1回）。
    - B・C で Prisma CLI を起動しないこと。
    - migration の前の判定の6種類の失敗。
    - `migrate deploy` の失敗と、起動の失敗。
    - A→A・A→B の異常な遷移。
    - migration の後の本人確認・カタログ・接続を閉じる処理の失敗。
    - 親のプロセスの `PGHOST`・`PGPASSWORD`・`PGOPTIONS`・`DOTENV_CONFIG_PATH` の拒否。
    - 強制停止（実行経路、前の検証の失敗が先に出ること、定数の凍結、スクリプトと globalSetup のソース）。
    - `createTestDatabaseClassifier` が作るときに接続せず、開発用の URL では接続せずに拒否すること。
    - 確認モードの表示。
  - 既存のテストのうち、動作が変わったものに合わせて直したもの（どれも条件を厳しくする方向）：
    - 終了コードを返す → `MIGRATION_FAILED` で止まる。
    - 親の `PG*`・`DOTENV_*` を落として続ける → 拒否する。
    - 確認モードで親の `PGHOST` を許す → 拒否する。
  - `testDbState.test.ts` は7件増えた（84→91件）。
  - パスワードの検証（見本の値・不一致・文字種など）の既存のテストは、そのまま成功した。
- **確認済み:**
  - `npx tsc --noEmit` が成功した。変更した6ファイルの `eslint` も成功した。`git diff --check` は0件。
  - `npm test` は31ファイル・1065件がすべて成功した（1032件＋33件）。
  - `dbConnectionPaths.test.ts` は152件が成功し、静的検査の違反は0件（許可リストは変えていない）。
  - `npx vitest list --filesOnly` は31件で、`*.integration.test.*` は0件。統合テスト用の設定では6件。
- **未実施・未検証のまま残ること:**
  - 実DBへの接続（強制停止の解除は、承認を得た後続の工程）。
    - 3-10B の「初回の実DB接続のときに確かめること」5項目。
    - 上の search_path の確認。
    - A→`migrate deploy`→C の実際の流れ。
  - globalSetup への組み込みと、`verifyIntegrationDatabase()` の search_path の固定。
  - `prisma migrate diff` による定義の照合（Step 3-12）。
  - `reset`（未実装）。
  - TOCTOU（上記）。
  - 実際の `up`・`down`、R7、Compose のラベル、tmpfs の実際の表し方（Step 3-10A から引き続き）。
- **commit の前の最終の安全性レビュー（ユーザーの指示による。2026-11-05。コードの変更なし）:**
  - 前提：HEAD `daf5c8b`、`.env.test` なし。globalSetup・接続先のガード（`lib/db/`）・`integrationEnv.ts`・`testDbConnection.ts`・`dbConnectionPaths.test.ts`・`prisma.config.ts` は、HEAD から変わっていない。
  - **実行ゲート:** 問題なし。
    - スクリプトは `liveDatabase: LIVE_DATABASE_DISABLED`（凍結した定数）だけを渡す。
      - `process.env`・`process.argv` は、親の環境変数と引数として渡すだけで、許可の値には使わない。
      - `createTestDatabaseClassifier`・`connectTestDatabase` の名前は、ヘッダーのコメントにしか現れない。
    - `runTestDbMigrate()` の中の順序は次のとおり。
      1. 確認モードの終了（DBに接続しない）
      2. 許可の確認（`liveDatabase.mode !== "enabled"` なら `TESTDB_MIGRATION_LIVE_DISABLED`）
      3. 最初の判定（接続）
      4. `spawn`
      - そのため、無効のときは、接続と Prisma CLI の起動の両方より前に止まる。
    - 有効な判定の関数を渡しているのは単体テストだけ。`createTestDatabaseClassifier` と `connectTestDatabase` を組み合わせて呼ぶコードはない。
    - import した時点では、`testDbMigrate.ts`・`testDbState.ts` は定数の定義だけで、接続も子プロセスの起動もしない。`pg` を読み込むのは `testDbConnection.ts` だけ（静的検査で確認）。
    - globalSetup の強制停止は変わっていない。
  - **search_path と SQL の順序:** 問題なし。`classifyTestDatabase()` の SQL は次の順に実行する。
    1. 接続（1回）
    2. `BEGIN READ ONLY`
    3. `pg_catalog.set_config('search_path', 'pg_catalog', true)`（戻り値が `pg_catalog` でなければ `SEARCH_PATH_NOT_PINNED` で止まり、本人確認に進まない）
    4. `SHOW transaction_read_only`
    5. 本人確認
    6. カタログの6つの一覧
    7. C の候補のときだけ、migration の履歴と空DB検査
    8. ROLLBACK
    9. `end()`
    - 失敗しても、ROLLBACK（BEGIN の後なら）と `end()` は必ず行う。
    - `public` のテーブルは `"public"."名前"` で修飾し、名前は検証してから引用する。システムカタログは `pg_catalog.` で修飾する。
  - **A・B・C とエラーの扱い:** 3-10C の記録のとおりで、問題なし。
    - A は `migrate deploy` を1回だけ起動し、別の接続で本人確認を含めて再判定する。C でなければ失敗する。
    - B・C は Prisma CLI を起動しない。C は「schema diff not verified」と表示する。
    - 判定の失敗は、どれも成功とは扱わない。別のURLへは接続し直さない。メッセージにはコードだけを含める。自動の修復・reset はない。
  - **最終の確認:**
    - `npx tsc --noEmit` が成功した。変更した6つのTSファイルの `eslint` も成功した。`git diff --check` は0件。
    - `npm test` は31ファイル・1065件がすべて成功した。
    - `dbConnectionPaths.test.ts` は152件で、違反は0件。
    - `npx vitest list --filesOnly` は31件で、統合テストは0件。統合テスト用の設定では6件。
    - DBへの接続・Dockerの操作・Prisma CLI の起動は、行っていない。
  - **実DBで確かめていないこと（検証済みではない）:**
    - PostgreSQL 15 での SQL の実際の動作。
    - search_path の固定の実際の動作。
    - 実際の A→`migrate deploy`→C。
    - TOCTOU のリスク。
    - `prisma migrate diff`（Step 3-12）。
    - globalSetup への組み込み。
    - 実際の Docker の `up`・`down`。
    - R7。
    - `reset`（未実装）。
  - commit は `92ba359`（`test: integrate guarded migration state checks`。親は `daf5c8b`）。通常テスト1065件成功、静的検査152件・違反0件。hash は、Step 3-11の実施前レビューのセッションで記録した。

**Step 3-11の実施前レビュー（初回の Docker 起動の前の安全性レビュー。ユーザーの指示による。2026-11-05）**

- 前提：ブランチ `chore/test-db-isolation`、HEAD `92ba359`。変更済みのファイルなし。未追跡は pptx と `test-data/` だけ。`.env.test` はない。
- **このレビューでは、コードを変更していない。** Docker の変更操作（up・down・run・exec・start・stop・restart、ボリュームの変更）、DBへの接続、migration、seed、統合テスト、build、`.env.test` の作成は行っていない。`testdb-migrate` の実行ゲートと globalSetup の強制停止は、そのまま。
- 読んだファイル：`docker-compose.test.yml`、`docker/test-db/init/01-app-role.sh`・`02-marker.sql`、`scripts/testdb.mts`、`scripts/testdb.test.ts`（範囲は既存の記録で確認）、`lib/testing/testDbConnection.ts`、`lib/testing/testDbState.ts`、`lib/testing/testDbMigrate.ts`、`scripts/testdb-migrate.mts`、`lib/testing/integrationDatabaseCheck.ts`（本人確認の部分）、`.env.test.example`、本ファイル。

- **A. 実行した読み取りの確認と結果（2026-11-05）:**
  - シェルの環境：`DOCKER_HOST`・`DOCKER_CONTEXT`・`NODE_OPTIONS` は未設定。`PG*`・`DOTENV_*`・`COMPOSE_*` の変数もない。
  - `docker context show`：`desktop-linux`（期待どおり）。クライアント 29.4.1、`docker compose version`：5.1.3。
  - **Docker のデーモンは停止中だった**（`Cannot connect to the Docker daemon at unix:///Users/…/.docker/run/docker.sock`）。そのため、次は**今回は確認できていない**：`postgres:15` の有無、開発用ボリュームの有無・記録、`katana-test-db`・`katana-db` の有無、テスト用ボリュームの有無、5434番を公開するコンテナ、`docker compose ls`、ネットワーク。Docker Desktop の起動は、このレビューでは行っていない。
  - `lsof -nP -iTCP:5434 -sTCP:LISTEN`：待ち受けなし。
  - `npm run testdb:status`・`npm run testdb:up`（`--apply` なし）：どちらも `TEST_ENV_MISSING` で終了コード1。Docker を呼ぶ前に止まった。
  - `git check-ignore -v --no-index .env.test`：`.gitignore:36:.env*` で除外される。
  - `bash -n docker/test-db/init/01-app-role.sh`：成功。Git でのモードは `01-app-role.sh` が `100755`、`02-marker.sql` が `100644`。

- **B. 初期化スクリプトの確認（静的。実際の実行は未検証）:**
  - 実行の順序：公式イメージの entrypoint は、データディレクトリが空のとき、initdb → 一時的なサーバー（`listen_addresses=''`。UNIX ソケットだけ）を起動 → `POSTGRES_DB`（`katana_test`）を作成 → `/docker-entrypoint-initdb.d/*` を名前順に処理（`01-app-role.sh` → `02-marker.sql`）→ 一時的なサーバーを停止 → 本来のサーバーを起動（TCP で待ち受け）。
    - `01-app-role.sh` は実行権限があるので、source ではなく別のプロセスとして実行される（shebang は `/usr/bin/env bash`。Debian 系の `postgres:15` には bash がある）。bind マウントで実行権限が保たれることは未検証。保たれずに source された場合も、`exit 1` で entrypoint ごと止まる（安全側）。
    - `02-marker.sql` は、entrypoint が `psql -v ON_ERROR_STOP=1 --dbname katana_test`（管理用のスーパーユーザー）で実行する。
  - 確認した事項:
    | 観点 | 結果 |
    |---|---|
    | 対象が `katana_test` だけ | 満たす。`01` は `POSTGRES_DB` を確かめ、`--dbname katana_test` で接続し、`DO` ブロックで `current_database()` も確かめる。`02` も `DO` ブロックで確かめる。`REVOKE ALL ON DATABASE postgres FROM PUBLIC` だけはクラスタ共通の権限の変更（`postgres` DB の中身には触れない） |
    | アプリ用のロール | `katana_test_user`（`LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`）。スーパーユーザーではない。`katana_test` の所有者になる |
    | DBの識別コメント | `COMMENT ON DATABASE katana_test IS 'katana-test-db'`。`TEST_DATABASE_MARKER` と同じ値 |
    | PostgreSQL 15 の構文 | `CREATE ROLE … PASSWORD :'app_password'`（psql の変数を文字列として展開。パスワードは `[A-Za-z0-9_-]` だけなので引用の問題はない）、`ALTER DATABASE … OWNER TO`、`REVOKE ALL ON DATABASE`、`COMMENT ON DATABASE`、`DO $$ … $$` は、どれも PostgreSQL 15 で有効。実行による確認はしていない |
    | 秘密情報を表示しない | スクリプトは `echo` でパスワードを表示しない。`set -x` もない。ただし下の「残る懸念」の2つがある |
    | 途中の失敗で止まる | `set -Eeuo pipefail` と `psql -v ON_ERROR_STOP=1`。entrypoint も `set -Eeo pipefail` で、初期化スクリプトの失敗で終了する。`restart: "no"` なので、コンテナは exited のまま残る |
  - **途中で失敗したときに、不完全なDBが残る可能性:**
    - `01` が失敗：ロールがない、または所有者の変更の前で止まる。`02` が失敗：ロールはあるが、識別コメントがない。どちらも entrypoint が止まり、本来のサーバー（TCP）は起動しない。healthcheck（TCP の `pg_isready`）は healthy にならない。
    - データは tmpfs にあるので、コンテナが止まると消える（Docker の仕様。実際の動作は未検証）。そのため、不完全なDBがコンテナの外やボリュームに残ることはない見込み。ただし、R7 で無名のボリュームが作られていた場合は、データディレクトリがボリュームに残り、次に同じコンテナを `docker start` すると初期化が実行されずに不完全なDBで起動し得る。ラッパーは既存のコンテナを起動し直さない（`TEST_CONTAINER_EXISTS`）ので、ラッパーの経路では起きない。
    - 識別コメントは初期化の最後の手順なので、コメントがあれば初期化は最後まで進んだと判断できる。接続後の本人確認は、コメントがなければ `MARKER_MISMATCH` で止まる。
  - **残る懸念（このレビューの時点。1・2は Step 3-11A で対策した。下の「Step 3-11A」の記録が正）:**
    1. 初期化の SQL が失敗すると、PostgreSQL は既定（`log_min_error_statement = error`）で、失敗した文をサーバーのログに書く。`CREATE ROLE … PASSWORD '…'` が失敗した場合、**`docker logs katana-test-db` にアプリ用のパスワードが出る**。障害の調査で `docker logs` を読むときは、出力をそのまま表示・記録しない（下の D）。
    2. `psql --set=app_password=…` の値は、初期化の間だけ、コンテナの中のプロセスの引数として見える（`docker top` など）。ローカル専用のテストDBなので許容する。
    3. 管理用のパスワードは、3-9の記録のとおり、コンテナの環境変数（`docker inspect` の `Config.Env`）に残る。調査では `Config.Env` を読まない。

- **C. 初回起動の前提条件と確かめ方（すべて読み取り。1つでも満たさなければ up しない）:**
  | # | 条件 | 確かめ方 | 今回の結果 |
  |---|---|---|---|
  | 1 | `DOCKER_HOST`・`DOCKER_CONTEXT`・`NODE_OPTIONS`・`PG*`・`DOTENV_*`・`COMPOSE_*` がない | `env` | 満たす |
  | 2 | コンテキストが `desktop-linux` | `docker context show`（ラッパーも確かめる） | 満たす |
  | 3 | Docker のデーモンが動いている | `docker version --format '{{.Server.Version}}'` | **満たさない（停止中）**。ユーザーが Docker Desktop を起動する |
  | 4 | `postgres:15` がローカルにある | `docker image inspect postgres:15 --format '{{.Id}} {{json .Config.Volumes}}'`（ラッパーは `IMAGE_MISSING` で止まる。取得はしない） | 未確認（デーモン停止）。3-10の前のレビューでは ID `29342cb52157` |
  | 5 | 開発用ボリュームがあり、記録が変わっていない | `docker volume inspect katana-web_postgres_data --format '{{.Name}}\t{{.CreatedAt}}\t{{index .Labels "com.docker.compose.project"}}\t{{index .Labels "com.docker.compose.volume"}}'` を、3-9・3-10の記録（2026-07-18T05:42:41Z、`katana-web`・`postgres_data`）と比べる。`docker ps -a --filter volume=katana-web_postgres_data` が空 | 未確認 |
  | 6 | `katana-db` の有無が記録と同じ（今は存在しない） | `docker ps -a --filter name=^katana-db$` | 未確認 |
  | 7 | `katana-test-db`・`katana-test` のコンテナ・ボリューム・Compose のプロジェクト・ネットワーク `katana-test_default` がない | `docker ps -a --filter name=^katana-test-db$`、`--filter label=com.docker.compose.project=katana-test`、`docker volume ls --filter label=com.docker.compose.project=katana-test`、`docker compose ls -a`、`docker network ls` | 未確認 |
  | 8 | 5434番が使われていない | `docker ps -a --filter publish=5434` と `lsof -nP -iTCP:5434 -sTCP:LISTEN` の両方（ラッパーは前者だけ） | `lsof` は待ち受けなし。Docker 側は未確認 |
  | 9 | すべてのボリュームの一覧を記録する（R7 の比較の基準） | `docker volume ls --format '{{.Name}}'` | 未確認。3-10の前のレビューでは、無名の2つ（`0df3f60a…`・`b655b6e4…`）と `katana-web_postgres_data` |
  | 10 | `.env.test` が正しく作られている（下の I） | 3つの確認モード | 未作成 |
  | 11 | Compose 設定の照合 | `npm run testdb:check`（本物の `.env.test` で） | 未実施（`.env.test` がない） |
  | 12 | `testdb:status` が想定どおり | テスト用のコンテナ・ボリュームがない、5434番の公開がない、開発用の記録が9・5・6と同じ | 未実施（`TEST_ENV_MISSING` で止まることだけ確認） |
  | 13 | `--apply` なしではコンテナを作らない | `npm run testdb:up`（予定のコマンドの表示だけ）。`mutate` は `apply` がなければ `MUTATION_NOT_ALLOWED`（単体テストで確認済み） | 単体テストでは確認済み。実際の dry run は未実施 |
  - Docker Desktop を起動すると、再起動ポリシーのあるコンテナが自動で起動し得る。3-10の前の記録では、コンテナは `sample-db`（再起動ポリシー `no`）だけなので、影響はない見込み。起動の後に `docker ps -a` で確かめる。

- **D. R7 とマウントの検査（初回の up の後）:**
  - ラッパーの起動後の確認（自動。どれか1つでも違えば `POST_CHECK_FAILED`。何も削除しない）：すべてのボリュームの一覧が起動前と同じ、プロジェクトのボリュームがない、`mountMismatches()`（初期化用の読み取り専用の bind 1つと、データ領域の tmpfs だけ）、ポートが `5432/tcp → 127.0.0.1:5434` だけ、Compose のラベル4つ、running・healthy、開発用の記録が同じ。
  - あわせて、手作業で読み取って記録する（`Config.Env` は読まない）:
    1. `docker inspect katana-test-db --format '{{json .Mounts}}'`：`Type: bind`、`Source` が `katana-web/docker/test-db/init` の絶対パス、`Destination` が `/docker-entrypoint-initdb.d`、`RW: false` の1件だけ。`Type: volume` があれば R7 は不合格。
    2. `--format '{{json .HostConfig.Tmpfs}}'`：`/var/lib/postgresql/data` がある（Compose の `tmpfs:` は、この形になる見込み。3-10A の A）。
    3. `--format '{{json .HostConfig.Mounts}}'`：初期化用の bind（`ReadOnly: true`）だけ。volume 型がない。
    4. `--format '{{json .Config.Volumes}}'`：イメージの `VOLUME` 宣言（`/var/lib/postgresql/data`）が出る見込み。宣言であって実際のマウントではないので、これだけでは不合格にしない。
    5. `--format '{{json .Config.Labels}}'`：`com.docker.compose.project=katana-test`、`service=test-db`、`project.config_files` が `katana-web/docker-compose.test.yml` の絶対パス1つ、`project.working_dir` が `katana-web` の絶対パス。Compose のラベルにパスワードは入らない見込み（入っていれば記録しない）。
    6. `--format '{{json .HostConfig.PortBindings}}'`：`{"5432/tcp":[{"HostIp":"127.0.0.1","HostPort":"5434"}]}` だけ。`docker ps --filter publish=5434` に出るのは `katana-test-db` だけ。
    7. `docker volume ls --format '{{.Name}}'` を、起動前（C の9）と比べる。**1つでも増えていれば R7 は不合格**（無名のボリュームの名前を記録し、削除しない）。
    8. 開発用ボリュームの記録（C の5）と `katana-db` の有無（C の6）が、起動前と同じ。
    9. `docker network ls`：`katana-test_default` が増えるのは想定どおり（ラッパーは確認していない）。それ以外が増えていない。
  - 判定：1〜8のすべてが期待どおりのときだけ、R7 を「合格」と記録する。予期しないマウント・ラベル・ポートが1つでもあれば、安全とは判断しない。
  - **重要な注意（up の前に合意しておくこと）:** Docker Desktop の `inspect` で、bind の `Source` が `/host_mnt/Users/…` のような別の表記になる、または Compose のラベルのパスが期待と違う場合、正常なコンテナでも次の2か所で止まる。
    - up の後の確認（`POST_CHECK_FAILED`）
    - down の前の確認（`CONTAINER_INSPECT_MISMATCH`）。**この場合、ラッパーでは片付けられない。**
    - R7 が不合格（`Type: volume` がある）の場合も同じで、down の前の確認が止まる。
    - そのときは、`docker rm` などを手作業で実行しない。読み取りの結果を報告して止まり、(a) 照合の条件を実際の表記に合わせて直すか（レビューと単体テストを経た、別のコード変更）、(b) 操作ごとに個別の承認を得て手作業で片付けるかを、ユーザーが決める。条件を緩めて先に進めることはしない。
    - コンテナが残っても、`127.0.0.1:5434` で待ち受けるだけで、migration・統合テストは実行ゲートで止まっているので、急いで片付ける必要はない。

- **E. 起動に失敗したときの対処（自動の削除・作り直しはしない）:**
  - どのケースでも、最初に次を読み取りで確かめる：ラッパーのエラーコードと不一致の項目名、`npm run testdb:status`、開発用ボリュームの記録と `katana-db` の有無（起動前と同じか）、`docker volume ls`（起動前と比べる）。
  - down は、`npm run testdb:down`（`--apply` なし）の確認に通った場合だけ、**別に承認を得て** `npm run testdb:down -- --apply` を実行する。確認に通らない場合は、手作業の削除を自動で行わず、調査の結果を報告して止まる。
  | ケース | 想定される状態 | 読み取りの調査 | 片付け |
  |---|---|---|---|
  | A. Compose が起動の前に失敗（変数展開・ポートの割り当て・イメージなど） | `DOCKER_COMMAND_FAILED`。コンテナがない、または created のまま（ポートの割り当ての失敗など）。ネットワーク `katana-test_default` だけが残ることがある | `testdb:status`、`docker ps -a --filter name=^katana-test-db$ --format '{{.ID}}\t{{.State}}\t{{.Label "com.docker.compose.project"}}'`、`docker network ls`、`lsof -nP -iTCP:5434 -sTCP:LISTEN`（Docker 以外のプロセスが5434番を使っていないか） | コンテナがあれば、down の確認に通る場合だけ承認を得て down。コンテナがなくネットワークだけが残った場合、ラッパーの down は「何もしない」で終わる（ネットワークは残る。害は小さいので、削除するかは別に決める） |
  | B. コンテナの作成後に初期化が失敗 | `--wait` が失敗し、コンテナは exited（`restart: "no"`）。tmpfs のデータは消えている見込み | `testdb:status`、`docker inspect katana-test-db --format '{{.State.Status}} {{.State.ExitCode}} {{json .State.Error}}'`。ログを読む場合は、**別に承認を得て**、`docker logs katana-test-db 2>&1 \| grep -E 'initdb\.d\|ERROR\|FATAL' \| grep -v -E 'STATEMENT\|PASSWORD'` のように、失敗した文（パスワードを含み得る）を除いて読む。生のログは表示・記録しない | down の確認に通る場合だけ承認を得て down（exited でも down できる。3-9D・3-10A）。原因を直してから、改めて up の承認を得る |
  | C. PostgreSQL が unhealthy | `--wait` が失敗し、コンテナは running・unhealthy | `testdb:status`、`docker inspect katana-test-db --format '{{json .State.Health}}'`（`pg_isready` の出力だけで、秘密情報はない）。必要なら B と同じ方法でログを読む | 同上 |
  | D. ラベル・マウントの検査の不一致 | `POST_CHECK_FAILED`。コンテナは running・healthy のまま | D の1〜9を読み取り、どの項目がどう違うかを記録する（パスワード以外） | down の確認に通る場合だけ承認を得て down。通らない場合（上の「重要な注意」）は、報告して止まる |
  | E. up のタイムアウト（120秒） | `DOCKER_COMMAND_FAILED`。コンテナは starting・unhealthy・healthy のどれか（後から healthy になることがある） | `testdb:status`、`docker inspect … '{{json .State.Health}}'` | ラッパーの起動後の確認が実行されていないので、後から healthy になっても**成功とは扱わない**。down の確認に通る場合だけ承認を得て down し、原因を確かめてから up をやり直す |
  - どのケースでも、`--volumes`・`-v`・`--remove-orphans`・`docker volume rm`・`prune`・`docker rm -f` は使わない。開発用ボリュームと `katana-db` には、読み取り以外の操作をしない。

- **F. 実DBの読み取り専用の検証（初回の起動の後。今回は接続していない）:**
  - 確かめること（3-10B・3-10C の「初回の実DB接続のときに確かめること」を含む）:
    1. 接続先が `127.0.0.1:5434`（URL のガード。DB の中からは公開ポートを確かめられない。`inet_server_port()` は5432になる見込みで、情報として記録するだけ）
    2. `current_database() = katana_test`、`current_user`・`session_user` = `katana_test_user`、DBのコメント = `katana-test-db`
    3. 読み取り専用のトランザクションの中で、`pg_catalog.set_config('search_path', 'pg_catalog', true)` が成功して `pg_catalog` を返す
    4. 6つのカタログの SQL が、`katana_test_user` の権限でエラーなく動く（`pg_default_acl`・`pg_largeobject_metadata`・`pg_publication`・`pg_statistic_ext`・`pg_am`・`pg_transform` を含む23のカタログ）
    5. 初期化の直後のDBが **A** と判定される（OID 16384 以上のその他のオブジェクトが0件であることを含む）
  - 使う処理：既存の `classifyTestDatabase()`（`createTestDatabaseClassifier({ root, connect: connectTestDatabase })`）。SQL は `BEGIN READ ONLY`・`set_config`（トランザクションの中だけ）・`SHOW`・SELECT・ROLLBACK だけで、DBを変更しない。
  - **今の実装の問題：読み取りだけの検証を実行する経路がない。**
    - `testdb-migrate` の実行ゲートを有効にすると、状態が A のときに、その場で `prisma migrate deploy` まで進む。読み取りだけで止める方法がない。
    - 確認モード（`--check`）は、DBに接続しない。
    - globalSetup は強制停止のままで、migration の後の状態（C）を前提にしている。
    - そのため、`testdb-migrate` の実行ゲートを外して検証することはしない（今回の指示どおり）。
  - **必要なコード変更（提案。着手には指示と承認が必要）:**
    - 読み取り専用の検証のモードを、migration の実行ゲートとは**別の**ゲートで追加する。案は次の2つ。
      - 案1（推奨）：`runTestDbMigrate()` に `--verify` モードを追加する。手順1〜8（引数・Node の起動オプション・`.env.test`・接続先・パスワード・親の `PG*`・`DOTENV_*`・子プロセスの環境変数の検証）をそのまま共有し、判定を1回だけ行って、状態（A・B・C）と本人確認の結果を表示して終わる。**どの状態でも Prisma CLI を起動しない**（`spawn` を呼ばないことを単体テストで確かめる）。
      - 案2：別のスクリプト（`scripts/testdb-verify.mts`）にする。手順1〜8の重複を避けるため、案1より変更が大きい。
    - ゲートの分け方：`--verify` には、読み取り専用の判定だけを渡す新しい許可（例：`readOnlyDatabase`）を使う。migration 用の `liveDatabase` は `LIVE_DATABASE_DISABLED` のまま固定する。通常実行モード（引数なし）は、今までどおり `TESTDB_MIGRATION_LIVE_DISABLED` で止まる。
    - 影響する既存のテスト：「スクリプトが接続の部品（`testDbConnection.ts`・`createTestDatabaseClassifier`）を読み込まない」ことを確かめる単体テスト（3-10C）。`--verify` のために読み込むなら、このテストを「`liveDatabase` には凍結した無効の定数だけを渡す」「接続の部品は `--verify` の経路でだけ使う」に変える必要がある。`pg` の許可リスト（`testDbConnection.ts` の1ファイル）は変えない。
    - 表示：本人確認の4項目が一致したこと、search_path を固定できたこと、状態（A・B・C）と B の理由、`inet_server_port()` の値。接続URL・パスワードは表示しない。
  - 実行の経路（コード変更の後）：`env` から `PG*`・`DOTENV_*`・`NODE_OPTIONS` を外した状態で `npm run testdb:migrate -- --verify`（または専用の npm スクリプト）。1回だけ接続し、成功・失敗にかかわらず ROLLBACK と `end()` をする。失敗したら、コードだけを記録して止まる（SQL の権限の問題なら、判定の SQL を直す前に報告する）。

- **G. TOCTOU の検討結果（設計の方針。実装は migration の実行を有効にする工程で行う）:**
  - 前提：migration の前の判定・Prisma CLI・migration の後の判定は、別々の接続（後ろの2つは別のプロセス）。間で `127.0.0.1:5434` の応答先が入れ替わる可能性は、なくせない。**migration の後の確認だけで、誤った接続を防げるとは扱わない**（後の確認は「検出」で、防止ではない）。
  - 防止の側（誤った接続先に migration が届かないようにする）:
    - 接続URLは `127.0.0.1:5434`・`katana_test`・`katana_test_user` に固定されている。開発用DB（5433・`katana`・別の認証情報）にこのURLで届くには、5434番を5433番に中継し、さらに開発用DBに `katana_test_user` と `katana_test` がある必要がある。現実的には起きない。
    - migration の直前に、5434番の待ち受けが Docker（`katana-test-db`）だけであることを確かめる：`docker ps --filter publish=5434` が `katana-test-db` だけ、`lsof -nP -iTCP:5434 -sTCP:LISTEN` の待ち受けが Docker Desktop のプロセスだけ。
  - 検出の側（コンテナの識別情報とDBの本人確認の組み合わせ）:
    1. Docker 側の識別情報 D1（読み取り）：`katana-test-db` のコンテナID、`State.StartedAt`、`katana-test_default` での IP アドレス、ポートの割り当て、Compose のラベル。ラッパーの検査（`containerInspectMismatches`）にも通ること。
    2. migration の前の判定の中（本人確認と同じ読み取り専用のトランザクション）で、DB側の識別情報 F1 を読む：`inet_server_addr()`（コンテナの中のアドレス）、`pg_postmaster_start_time()`。可能なら `pg_control_system()` の `system_identifier`（`katana_test_user` で実行できるかは未確認）。
    3. F1 と D1 を照合する：`inet_server_addr()` がコンテナの IP と一致し、`pg_postmaster_start_time()` が `State.StartedAt` より後で、初期化にかかる時間の範囲に収まる。合わなければ migration を始めない。
    4. `prisma migrate deploy`。
    5. migration の後の判定で F2 を読み、F1 と完全に一致すること（サーバーが再起動・入れ替わりしていない）。
    6. 最後にもう一度 D2 を読み、D1 と一致すること（コンテナが入れ替わっていない）。
    - 4の間に入れ替わった場合でも、5・6で検出できる。ただし、そのときには migration は別のサーバーに届いている。届いた先がテストDBの本人確認に通らないサーバーなら、そのサーバーは変更されているかもしれないが、開発用DBではない（防止の側の理由）。
  - 実装上の判断（未決定。migration の実行を有効にする工程で決める）：`testdb-migrate` から Docker の読み取りコマンドを呼ぶか（ラッパーの関数を共有するか）、ラッパーに migration を呼ぶ手順（`reset` の一部）を持たせるか。どちらでも、Docker の読み取りは許可リストのコマンドだけにする。
  - Prisma CLI の接続を親のプロセスから制御する方法（ロックを持ち続けるなど）は、効果がないので使わない（3-10C の記録と同じ）。

- **H. Step 3-11 の完了条件との違い（PLANの3章の節の内容）:**
  - 「DBのコメントが一致する」は、ラッパーでは確かめられない（DBに接続しない）。F の読み取り専用の検証のモードを実装してから確かめる。そのため、Step 3-11 を次のように分けることを提案する。
    - **3-11（Docker の起動）**：前提条件（C）→ dry run → 承認 → `testdb:up -- --apply` → 起動後の確認と R7（D）→ 開発用の記録の照合。DBには接続しない。
    - **3-11B（読み取り専用のDB検証）**：F のコード変更（別の承認）→ 実DBへの読み取り専用の接続（別の承認）→ 本人確認・search_path・カタログ・状態 A。
  - 2-5の「up の前に `lsof` で5434番を確かめる」は、ラッパーでは `docker ps --filter publish=5434` だけ。手作業の `lsof` で補う（C の8）。

- **I. `.env.test`（今回は作成していない。ユーザーが後続の工程で作る）:**
  - 必要なキーは3つだけ（ラッパーは、ほかのキーを `TEST_ENV_UNEXPECTED_KEY` で拒否する）:
    - `DATABASE_URL=postgresql://katana_test_user:<アプリ用のパスワード>@127.0.0.1:5434/katana_test`（クエリパラメータ・フラグメントを付けない）
    - `KATANA_TEST_DB_PASSWORD=<アプリ用のパスワード>`（URL のパスワードと完全に同じ）
    - `KATANA_TEST_DB_ADMIN_PASSWORD=<管理用のパスワード>`（アプリ用と違う値）
  - パスワードの条件：`[A-Za-z0-9_-]` だけ、空でない、`change_me` などの見本の値を含まない、開発用DBのパスワードを流用しない。
  - 作り方の例（パスワードを画面とシェルの履歴に残さない）：`katana-web/` で `umask 077` の後、`openssl rand -hex 24` で作った2つの値を、シェルの変数を経由して `printf` で `.env.test` に書き込み、変数を `unset` する。`.env.test.example` をコピーしてエディタで書き換えてもよい。
  - 作った後の確認：`ls -l .env.test` が `-rw-------`、`git status --short` に出ない、`npm run testdb:check`・`npm run test:integration:check`・`npm run testdb:migrate:check` の3つが成功する。
  - パスワードは、本ファイル・ログ・報告に書かない。DBを作り直すまで、パスワードの変更は反映されない（初期化はデータが空のときだけ）。

- **起動の前に解決すべき問題:**
  1. Docker のデーモンが停止中。ユーザーが Docker Desktop を起動した後、C の2〜9を読み取りでもう一度確かめる。
  2. `.env.test` がない（ユーザーが作る。I）。
  3. bind の `Source`・Compose のラベルのパスの表記が想定と違った場合、ラッパーで片付けられなくなる（D の「重要な注意」）。その場合の扱い（止まって報告し、条件の修正か個別の承認による手作業かを決める）を、up の承認の前に合意しておく。
  4. 読み取り専用のDB検証の経路がない（F）。Step 3-11 の完了条件「DBのコメントが一致する」を満たすには、コード変更が必要。
- **残る未検証の事項:**
  - Docker のデーモンが必要な前提条件（C の3〜9・11〜13）。
  - 初期化スクリプトの実際の実行（ロールの作成・所有者の変更・コメント）、bind マウントで実行権限が保たれること、healthcheck が初期化の完了まで healthy にならないこと。
  - tmpfs のデータがコンテナの停止で消えること。
  - R7、tmpfs の実際の表し方（3-10A の A・B・C のどれか）、bind の `Source` とラベルの実際の値、`compose ps --format json` の形。
  - 実際の up・down（Compose v5.1.3 での固定の引数の受け付けは、3-10の前のレビューでヘルプにより確認済み）。
  - 実DBでの SQL・権限・search_path の固定・状態 A の判定。
  - TOCTOU の対策（G。未実装）。`pg_control_system()` を `katana_test_user` で実行できるか。
  - `reset`（未実装）、globalSetup への組み込み、`prisma migrate diff`（Step 3-12）。
- **実DBへの接続と migration は、実施していない。** コンテナの起動・停止も行っていない。

#### Step 3-11A：Docker 起動前の最終安全確認（実施済み。commit `test: protect test database initialization secrets`）

- **前提の確認:** ブランチ `chore/test-db-isolation`、HEAD `92ba359`。変更は PLAN の未commit分だけ。pptx・`test-data/` は未追跡のまま触れていない。
- **Docker Desktop:** ユーザーが起動した（Claude Code からは起動していない）。最初の確認ではデーモンに接続できず停止し、ユーザーの起動の後に再開した。
- **読み取り専用の確認の結果（使ったコマンドは、指示の一覧と `docker ps -a --filter`・`docker volume ls --filter`・`docker volume inspect`・`docker inspect sample-db --format`（再起動ポリシーと停止日時だけ）・`docker image ls postgres`。起動・停止・exec・削除はしていない）:**
  | 項目 | 結果 | 記録との比較 |
  |---|---|---|
  | コンテキスト | `desktop-linux` | 一致 |
  | Docker | クライアント・エンジンとも 29.4.1（Docker Desktop 4.71.0、linux/arm64）。Compose v5.1.3 | 一致 |
  | コンテナ | `sample-db`（`sample-db-image:latest`、Exited (0)、6か月前に停止。再起動ポリシー `no`、停止日時 2026-05-06）だけ。ポートの公開なし | 一致。**Docker Desktop の起動に伴って起動したコンテナはない** |
  | `katana-db`・`katana-test-db` | どちらも存在しない。`com.docker.compose.project=katana-test` のコンテナ・ボリュームもない | 一致 |
  | ボリューム（R7 の比較の基準） | `0df3f60a…`（無名、2026-05-01T07:48:32Z、どのコンテナも使っていない）、`b655b6e4…`（無名、2026-05-04T01:58:29Z、`sample-db` が使う）、`katana-web_postgres_data` の3つだけ | 一致 |
  | 開発用ボリューム | `katana-web_postgres_data`、作成日時 2026-07-18T05:42:41Z、ラベル `com.docker.compose.project=katana-web`・`com.docker.compose.volume=postgres_data`・`com.docker.compose.version=5.1.3`・`config-hash=3c74db25…`。使っているコンテナはない | 一致 |
  | `postgres:15` | あり。ID `29342cb52157`（作成 2026-04-22）。`Config.Volumes` は `{"/var/lib/postgresql/data":{}}`（R7 の対象の宣言。初回の up の後に D の手順で確かめる） | 一致 |
  | 5434番 | `lsof` で待ち受けなし。Docker 側もポートを公開しているコンテナなし | 空き |
  - 前提条件の表 C のうち、2〜9 は満たす。10〜13（`.env.test` と確認モード・dry run）は未実施。
- **初期化スクリプトのログ漏洩の確認（静的）:**
  | 経路 | 修正前 | 対策 |
  |---|---|---|
  | サーバーのログ（`docker logs`） | `log_min_error_statement` の既定は `error`。`CREATE ROLE … PASSWORD '…'` が失敗すると、`STATEMENT:` の行に全文（psql が展開した後のパスワードを含む）が出る。`log_statement`・`log_min_duration_statement` の既定は文を出さないが、明示的には止めていない | psql のセッションの最初に `SET log_statement = 'none'`・`log_min_error_statement = 'panic'`・`log_min_duration_statement = -1`・`log_min_duration_sample = -1`（このセッションだけ。どれもスーパーユーザーが変更できる設定で、初期化は管理用のスーパーユーザーで接続する）。失敗しても `ERROR:` の行（メッセージだけ）は残り、文は記録されない。記録自体を防ぐ方式で、後からのマスクには頼らない |
  | psql の標準エラー | 既定の `VERBOSITY=default` では、位置のある誤り（構文の誤りなど）で `LINE 1: CREATE ROLE … PASSWORD '…'` の抜粋が出る（`docker logs` に入る） | `-v VERBOSITY=terse`（抜粋の代わりに「at character N」だけ）、`-v SHOW_CONTEXT=never` |
  | psql の ECHO | 使っていない（`-a`・`-e`・`-E`・`--echo-*` なし、`--no-psqlrc` で設定ファイルも読まない） | 変更なし。静的テストで確かめる |
  | psql の標準出力 | `DO`・`CREATE ROLE` などのコマンドタグだけ | 変更なし |
  | プロセスの引数 | `--set=app_password=<パスワード>` が、初期化の間だけコンテナの中のプロセスの引数に見えた | psql 15 の `\getenv app_password KATANA_TEST_DB_PASSWORD` で、環境変数から読む。引数には出ない |
  | シェルのトレース | `set -x` なし。entrypoint もトレースしない | 変更なし。静的テストで確かめる |
  | 環境変数の表示 | スクリプトは表示しない（エラーメッセージは変数名だけ） | 変更なし |
  | エラーメッセージ | `refusing to initialize database %`（DB名だけ）など。サーバーのエラー（例：ロールが既にある）にパスワードは入らない | 変更なし |
  | コンテナの環境変数 | `KATANA_TEST_DB_PASSWORD`・`POSTGRES_PASSWORD` は `Config.Env` に残る | 対策なし（Compose の環境変数で渡す設計のまま）。調査で `Config.Env` を読まない運用を続ける |
  - `02-marker.sql` は秘密情報を扱わない。entrypoint は `.sql` を ECHO なしの psql で実行する。`docker-compose.test.yml` には `command`・`entrypoint` がなく、サーバーのログの設定を上書きしない。どちらも変更していない。
  - 初期化の失敗で止まる条件は維持：`set -Eeuo pipefail`、`-v ON_ERROR_STOP=1`。`\getenv` で変数が設定されなかった場合は、`:'app_password'` が展開されず構文の誤りになり、ON_ERROR_STOP で止まる（シェルで空でないことも先に確かめている）。
  - 残る注意：PostgreSQL のサーバーが PANIC で止まる場合だけは文が記録され得るが、`CREATE ROLE` で PANIC になることは想定しない。障害の調査で `docker logs` を読むときに、E の B の除外のフィルタを使う運用は続ける。
- **修正したファイル:**
  - `docker/test-db/init/01-app-role.sh`：上の対策（psql の引数・`SET` の4行・`\getenv`・コメント）。実行権限（100755）は維持。
  - `scripts/testdb-init.test.ts`（新規、11件）：ファイルの内容だけで確かめる静的テスト。Docker・DBには接続しない。シェルのトレースがない、パスワードの値を展開するのは空かどうかの確認だけ、psql は1回だけでパスワードを引数に渡さない、ECHO・ログファイルを使わず `VERBOSITY=terse`・`SHOW_CONTEXT=never`、パスワードを含む文は `CREATE ROLE` の1つだけ、`\getenv` が `CREATE ROLE` より前、ログの設定4つが `CREATE ROLE` より前で途中で戻さない、`02-marker.sql` が秘密情報を扱わない、Compose がログの設定・`command` を持たない。修正前の `01-app-role.sh` に対しては5件が失敗することを確かめた（一時的に戻して実行し、修正後の内容に戻したことを `cmp` で確認）。
  - `lib/testing/dbConnectionPaths.test.ts`：通常テストのファイル数 `EXPECTED_UNIT_TEST_COUNT` を31から32に更新（新しいテストファイルの追加による。規則4のテスト名の「25件」は以前から定数と食い違っているが、変更していない）。
- **静的テストの結果:** `bash -n docker/test-db/init/01-app-role.sh` 成功、`npx tsc --noEmit` 成功、`npm test` 32ファイル・1076件成功（最初の実行では、ファイル数の定数の更新前で1件失敗）、`git diff --check` 成功。実DBを使うテストは実行していない。
- **初回の up の後に問題が起きたときの方針（ユーザーの指示。D の「重要な注意」と E を、この内容で確定する）:** Mounts の表示形式が想定外、bind の `Source` のパスの不一致、Compose のラベルの不一致、無名のボリュームの作成、up のタイムアウトのどれでも、自動で `down`・`docker rm`・`docker volume rm` を行わない。対象のコンテナID・ラベル・マウント・ポート・開発用ボリュームの状態を読み取りで確かめて報告する。個別の承認を得るまで、手作業で削除しない。
- **Step 3-11 の未実施の事項:** `.env.test` の作成（ユーザー）、3つの確認モード（`testdb:check`・`test:integration:check`・`testdb:migrate:check`）、`testdb:status`、`testdb:up`（`--apply` なし）、up の承認と `testdb:up -- --apply`、起動後の確認と R7（D）、読み取り専用のDB検証のモード（F。3-11B）。
- **残る未検証の事項:** 修正した初期化スクリプトの実際の実行（`\getenv`・`SET` の受け付け、失敗時にログに文が出ないこと）、初期化の実際の動作と tmpfs のデータの消え方、R7、bind の `Source`・ラベルの実際の値、実際の up・down、実DBでの検証、TOCTOU の対策（未実装）。
- **commit の前の最終レビュー（2回目のセッション）:**
  - `postgres:15` のイメージの環境変数 `PG_VERSION=15.17-1.pgdg13+1`（`docker image inspect` で読み取り）。`\getenv` は psql 15 で追加された機能なので使える。
  - ログを止める `SET` の4行は、`CREATE ROLE` より前に、同じ psql のセッション（1つの接続）で実行される。`ON_ERROR_STOP=1` なので、`SET` が1つでも失敗すれば psql はその場で終了し（終了コード3）、`set -e` でスクリプトも失敗する。`CREATE ROLE` には進まない。
  - `\getenv` は、環境変数がなくても失敗しない（psql の変数が未設定のまま）。その場合、`:'app_password'` が展開されずに構文の誤りになり、ON_ERROR_STOP で止まる。文の中にパスワードは入らない。シェルは先に空でないことを確かめている。
  - `:'app_password'` は、psql が `PQescapeLiteral` で SQL の文字列リテラルとして引用する（引用符・バックスラッシュも安全に扱う）。さらにパスワードは `[A-Za-z0-9_-]` だけに制限されている（R14）。
  - パスワードはコマンドの引数に入らない。ECHO・`set -x` はない。例外のメッセージ（`RAISE EXCEPTION`）は DB 名だけで、パスワードを含まない。
  - 最終テスト：`bash -n` 成功、`npx tsc --noEmit` 成功、変更したテストファイル2つの `eslint` 成功、`npm test` 32ファイル・1076件成功、`npx vitest list --filesOnly` は32ファイル（`scripts/testdb-init.test.ts` を含み、`*.integration.test.*` は0件。統合テスト6ファイルは除外）、`dbConnectionPaths.test.ts` の静的検査152件成功・違反0件、`git diff --check` 成功。
  - **一時的な事象：** 2回目のセッションの最初の `docker image inspect postgres:15` が1回だけ `No such image: postgres:15` を返した。直後の `docker image ls` には `postgres:15`（`29342cb52157`）が表示され、名前を指定した `inspect` も4回続けて成功した。コンテナ・ボリューム・開発用ボリュームの記録は変わっていない。原因は不明（Docker Desktop の起動の直後の一時的な応答の可能性）。ラッパーはイメージがなければ `IMAGE_MISSING` で止まる（安全側）。
- **まとめ（Step 3-11A の時点）:** Docker 側の起動前の条件は確認済み（`postgres:15` あり、開発用ボリュームは変更なし、5434番は未使用）。初期化のログ漏洩の対策と静的テスト11件を追加し、通常テスト1076件が成功。**実際の初期化の処理、R7 は未検証。DBへの接続は未実施。**
- **実DBへの接続・migration・コンテナの起動と停止は、実施していない。** `.env.test` は作成していない。

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
    - 許可リスト：`lib/prisma.ts`、`prisma/seed.ts`、`lib/db/` の中のガード関連ファイル、`scripts/testdb*`（当初の予定）。**実装した許可リストは `lib/prisma.ts`・`prisma/seed.ts` の2件だけ**（3-Aの3-4）。`scripts/testdb-migrate.mts`（Step 3-8B。検証の後に `prisma migrate deploy` を起動する。通常実行モードは今は必ず停止する）と `scripts/testdb.mts`（Step 3-9B。Dockerのラッパー。読み取り専用の `--check`・`--status`）は、どちらもDBへの接続を自分では作らないので、許可リストに入れていない。
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

### Step 3-8：`prisma.config.ts` のガードとmigration用スクリプト（Step 3-8Bとして実施済み。実装した仕様は3-Aの記録が正）

- **作業内容:** 2-7のガードと、`testdb-migrate` スクリプトを作る。
- **変更対象ファイル:** `prisma.config.ts`、`scripts/testdb-migrate.mts`（新規）、`package.json`。
- **実施条件:** Step 3-7が完了している。
- **完了条件:** 開発用URLを指定すると、Prisma CLIを起動する前に拒否される。Prisma CLIそのものは実行しない。
- **承認が必要な操作:** なし。
- **停止条件:** Prisma CLIが起動してしまう。

### Step 3-9：Compose定義とDockerのラッパー（Step 3-9・3-9Bで、構成ファイル・`--check`・`--status`・`config` による照合まで実施。`up`・`down`・`reset` は未実装。実装した仕様は3-Aの記録が正）

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
- **実施前レビューの結果（3-Aの「Step 3-11の実施前レビュー」）:** 前提条件・R7 の検証手順・失敗時の対処はそちらが正。完了条件の「DBのコメントが一致する」はラッパーでは確かめられないので、3-11（Docker の起動と R7。DBに接続しない）と 3-11B（読み取り専用のDB検証。コード変更が必要）に分けることを提案している。
- **Step 3-11A の結果（3-Aの「Step 3-11A」）:** Docker 側の前提条件（C の2〜9）は満たす。初期化スクリプトのログ漏洩の対策は済んだ。初回の up に残る前提は、`.env.test` の作成と3つの確認モード・dry run、D の「重要な注意」の扱いの合意、up の承認。

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
| R3 | `KATANA_DB_TARGET=test` を設定せずにPrisma CLIを直接実行すると、開発用DBに接続する | 残余リスク（2-7）。運用ルールとCLAUDE.mdで対処する。Step 3-8Bで、テストDBに見えるURLをテストモードなしで使う場合は拒否するようにした（ほかの経路は3-Aの3-8B） |
| R4 | `prisma/seed.ts` と Prisma Studio はガードの外にある | 範囲外 |
| R5 | `lib/generated/prisma/` が、Gitの除外対象なのに管理されたまま残っている | importは静的検査で防ぐ。整理は別タスク |
| R6 | 静的検査はASTの解析だが、文字列を組み立てたimport、パッケージ経由の読み込み、`@/*` 以外の別名などはすり抜けられる（3-Aの3-4B・3-5Bに一覧）。判定できない動的importなどは、規則4で「未確認」として失敗させる | 低。レビューで補う |
| R7 | tmpfsとイメージの `VOLUME` 宣言の関係 | 未検証。静的には確定できない（3-Aの3-9B）。Step 3-9Dで、`testdb --up --apply` の起動後の確認に、すべてのボリュームの一覧の比較と、`inspect` の Mounts・Tmpfs の照合を入れた（最終判定は、初めて起動するとき）。初めて起動した後に、`docker inspect` の `Mounts`・`HostConfig.Tmpfs` と、起動前後の `docker volume ls` で確かめる。既存の無名ボリューム `0df3f60a…`（どのコンテナも使っていない）があることは記録済み。手作業で読み取る項目と合格の条件は、3-Aの「Step 3-11の実施前レビュー」の D で確定した（ボリュームが1つでも増えれば不合格） |
| R8 | Node 25で `.mts` のスクリプトを動かせるか。Vitest 4の `test.env` と `.env.test` の扱い | `test.env` が親プロセスの値を上書きすることは、Step 3-3でソースを読んで確認済み。`.mts` のrunnerがNode 25でそのまま動くことは、Step 3-7Bの確認モードで確認済み。統合テスト用の設定は `envDir: false` でViteに `.env*` を読ませない（通常実行モードでの確認は未実施） |
| R12 | Step 3-0で取得したDockerの記録（コンテキスト・ボリューム名・`katana-db`）が残っていない | 解消（Step 3-9で取得し直した：コンテキスト `desktop-linux`、ボリューム `katana-web_postgres_data`）。**調査の時点で、開発用コンテナ `katana-db` は存在しない。** 今後の比較の対象は、開発用ボリュームの名前・作成日時（2026-07-18T05:42:41Z）・ラベル（`com.docker.compose.project=katana-web`・`com.docker.compose.volume=postgres_data`）と、`katana-db` の有無。`testdb --status` がこれらを読み取る。ボリュームへの操作は読み取りだけ |
| R14 | `.env.test` のパスワードがプレースホルダーのままでもガードを通る。`DATABASE_URL` と `KATANA_TEST_DB_PASSWORD` の一致は、運用で守っている | **一部対策済み・残課題あり。** Step 3-9Cで、共通の `assertTestDatabaseCredentials()`（見本の値・空・文字種・URLとの一致・管理用との違い）を、4つの正規の経路（Dockerのラッパー・統合テストのrunner・`testdb-migrate`・Prisma CLIのテストDBモード）に適用した。残り：(1) runnerを通さずに globalSetup・`lib/prisma.ts` の統合テストモードを起動する経路（パスワードは未検証。今は globalSetup が必ず停止する）、(2) `docker compose` の直接実行、(3) 外部の道具からの接続（対象外）。詳細は3-Aの3-9C |
| R15 | Composeの変数展開では、シェルの環境変数が `--env-file` より優先される | 対策済み（Step 3-9B）。Composeの子プロセスには、許可リストの変数と検証済みのパスワードだけを渡す。親に `COMPOSE_*` や同名のパスワードを設定しても結果が変わらないことを、`config` で確認した |
| R13 | Step 3-3の完了条件の `npm run build` を実施していない | DBに接続しないことを確認できる方法が見つかるまで保留。Phase 4までに実施する |
| R9 | テストが途中で落ちた後は、`testdb:reset` が必要になる | 利便性の問題であり、安全性の問題ではない |
| R10 | ガードのコードそのものを書き換えられると防げない | CLAUDE.mdとレビューで対処する |
| R11 | 開発用DBの認証情報が `docker-compose.yml` に直接書かれている | 範囲外 |

---

## 次のセッションで最初に行うこと

1. `CLAUDE.md` と本ファイルを読む。特に「全Phase共通の禁止事項」、3章の「3-A. 実施結果」、これから行うStepの節を読む。
2. `git branch --show-current`、`git status --short`、`git log -1 --oneline` で状態を確認し、次の想定と一致するかを確かめる。一致しなければ、作業を始めずに報告する。
   - ブランチ：`chore/test-db-isolation`
   - HEAD：Step 3-11A の commit（`test: protect test database initialization secrets`。親は `92ba359`。hash は 3-A の表）
   - 変更済み（未commit）：なし（Step 3-11A の commit の hash を記入した後の `docs/PLAN-test-db-isolation.md` だけが変更済みになる場合がある）
   - 未追跡（commitの対象外）：`docs/presentations/KatanaService_プロジェクト構成.pptx`、`test-data/`
   - `.env.test` は存在しない（Step 3-7B・3-8B・3-9B・3-9C と、`61f8105` のcommit前の検証で作った一時ファイルは、すべて削除済み）
3. Step 3-9・3-9Bは、構成ファイル・ラッパーの `--check`・`--status`・`docker compose config` による照合まで実施し、`61f8105` でcommit済み。Step 3-9C（R14のパスワード検証の共通化）は `4553f2f` でcommit済みだが、R14には残課題がある（3-Aの3-9C）。Step 3-9D（ラッパーの `--up`・`--down`）は、実装・単体テスト・静的検証と障害時の down のレビューまで実施し、`5fcc259` でcommit済み。**実際の `up`・`down` は、まだ一度も実行していない。R7 も未検証。** Step 3-11の実施前レビューの結果（3-Aの「Step 3-11の実施前レビュー」。前提条件の表 C、R7 の D、失敗時の E、DB検証の F、TOCTOU の G、`.env.test` の I）を先に読む。レビューの時点では Docker のデーモンが停止中だったが、Step 3-11A でユーザーが Docker Desktop を起動し、前提条件 C の2〜9 を満たすことを確かめた（3-Aの「Step 3-11A」）。初期化スクリプトのログ漏洩の対策も 3-11A で済んだ。初回の up の後に問題が起きたときは、自動で削除せず、読み取りで調べて報告し、個別の承認を待つ（3-11A で確定）。次に何を行うかは、始める前にユーザーに確認する。候補は次のとおり。
   - ユーザーによる `.env.test` の作成（Step 3-10）の後、Docker の状態（C の2〜9）の再確認と、3つの確認モード・`testdb:status`・`testdb:up`（`--apply` なし）の実行
   - Step 3-11（`testdb:up -- --apply`。別の承認が必要。D の「重要な注意」の扱いを、承認の前に合意する）
   - 読み取り専用のDB検証のモードの実装（F の案1。`testdb-migrate` の migration の実行ゲートは無効のまま。実装とその後の実DBへの接続は、それぞれ承認が必要）
   - `reset` の実装（本人確認の後）

   コンテナの起動（Step 3-11）と、R7の確認は、まだ行っていない。接続後の本人確認と状態の判定は Step 3-10B で実装して commit し、Step 3-10C で migration 用スクリプトの流れに組み込んだ。ただし、スクリプトの実DBへの接続の許可は固定で無効で、通常実行モードは接続の前に必ず止まる。globalSetup には組み込んでおらず、強制停止のまま（初回の実DB接続で確かめることは、3-Aの3-10B・3-10Cの記録）。指示されたStep以外には着手しない。
4. Stepが終わったら報告し、ユーザーの確認を得たうえで、次の2つを更新してからセッションを終える。
   - 3章の「3-A. 実施結果」（結果、設計との違い、未検証の事項、次のStepへの申し送り）
   - 本節の手順2の想定と、手順3の次のStep
