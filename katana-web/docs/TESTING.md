# テストとテストDB

このファイルは、テストの実行方法と、テスト専用DBの扱いをまとめたものです。設計・経緯・検証の記録は [PLAN-test-db-isolation.md](PLAN-test-db-isolation.md) にあります。両者が食い違う場合は、PLAN の記録と実装（`scripts/`・`lib/testing/`・`lib/db/`）が正です。

記載は 2026-11-15 時点（HEAD `0c1702b`）の状態に基づきます。**固定ゲートは6つともすべて無効です。**

（2026-11-23 追記・Step 4-3）統合テストの globalSetup に、7つ目の固定ゲート `INTEGRATION_DATABASE_DISABLED` を追加しました。**固定ゲートは7つともすべて無効です。** 詳しくは「固定ゲート」の節と、`npm run test:integration` の行を参照してください。

（2026-11-23 追記・Step 4-4・4-5）第7のゲートは、globalSetup（`lib/testing/integrationGlobalSetup.ts`）と setupFiles（`lib/testing/integrationSetup.ts`）の**2か所**で同じ定数を使います。今は2か所とも無効です。**統合テストは、実DBではまだ一度も実行していません**（「5. 統合テストの経路」）。→（2026-11-23 更新・Step 4-10）統合テスト6件は、第7のゲートを一時的に有効にして（`4d8940d`）実DBで1回実行し、54件が成功しました。ゲートは `3088ace` で2か所とも無効に戻しています。

（2026-11-23 追記・Step 4-13B・4-14）F-01 の E2E 用の開発サーバーを起動するスクリプト（`scripts/e2e-dev-server.mts`）に、**8つ目の固定ゲート `E2E_DEV_SERVER_DISABLED`** を追加しました。**固定ゲートは8つともすべて無効です。** E2E 用の開発サーバーは、まだ一度も起動していません（「7. E2E 用の開発サーバー」）。

（2026-11-24 追記・Step 4-13C・4-15）E2E 用のテストデータの準備と、シナリオごとの DB の変更を行うスクリプト（`scripts/testdb-e2e.mts`）に、**9つ目の固定ゲート `E2E_FIXTURE_DISABLED`** を追加しました。**固定ゲートは9つともすべて無効です。** このスクリプトは、まだ一度も `--apply` で実行していません（「7. E2E 用の開発サーバー」の「E2E 用のテストデータ」）。

---

## 1. 承認の原則

次の操作は、**操作ごとに個別の承認を得てから**行います（PLAN の「全Phase共通の禁止事項」）。

- DB への接続（読み取り専用でも）
- Docker の操作（読み取り系のコマンドを含む）
- Prisma CLI の実行
- migration・`db push`・seed
- 統合テストの実行
- 固定ゲートの有効化（コードの変更と commit を伴う）

また、次のことはしません。

- 開発用DB（`katana`）への書き込み
- 開発用の `docker-compose.yml` と、ボリューム `postgres_data` の変更
- `test-data/` の変更・削除
- 秘密情報（パスワード、`AUTH_SECRET`、接続文字列の全文）を、ドキュメント・ログ・報告に書くこと
- テストを通すために、ガードを緩めること
- 失敗したときの、自動の再実行・DB の自動修復

---

## 2. DB の構成

### 開発用DB とテストDB

| | 開発用DB | テストDB |
|---|---|---|
| Docker | `docker-compose.yml`・コンテナ `katana-db`・ボリューム `postgres_data` | `docker-compose.test.yml`・プロジェクト `katana-test`・コンテナ `katana-test-db` |
| 接続先 | `localhost:5433`・DB `katana` | `127.0.0.1` または `localhost`、ポート `5434`、DB `katana_test`、ユーザー `katana_test_user` |
| 設定ファイル | `.env` | `.env.test`（アプリ用・管理用のパスワード）、`.env.test.readonly`（`katana_test_ro`）、`.env.e2e`（E2E 用のユーザーのパスワード `KATANA_E2E_USER_PASSWORD` だけ。Step 4-13C） |
| データ | ボリュームに保存 | tmpfs（コンテナを作り直すと消える） |

`.env.test`・`.env.test.readonly` は、ユーザーが作成し、権限は `-rw-------` にします。中身は表示しません。

### テストDB の識別

テストDB に接続する経路は、接続の前と後に、次のことを確かめます。

- **接続の前（`lib/db/testDatabaseGuard.ts`）：** URL のホスト・ポート・DB 名・ユーザーが上の値と一致すること、開発用DB の URL と同じでないこと、パスワードが見本の値でないこと。
- **接続の後（読み取り専用のトランザクションの中）：** `current_database()` が `katana_test`、`current_user`・`session_user` が想定のロール、DB のコメントが `katana-test-db` であること。`search_path` は、そのトランザクションの中だけ `pg_catalog` に固定します。
- **Docker（`testdb:identity`）：** Docker のコンテキストが `desktop-linux`、Compose のラベル、ポート `127.0.0.1:5434` だけの公開、tmpfs とマウント、稼働中・healthy、イメージ、開発用ボリュームの記録。

### 状態 A・B・C

`testdb:verify` などは、テストDB を次の3つに分けます（`lib/testing/testDbState.ts`。判定するだけで、DB は変更しません）。

- **A：** migration を1件も適用していない、完全に空の DB
- **B：** 途中まで適用した・失敗した・想定外のものがある DB（A にも C にも当たらないものすべて）
- **C：** 期待する migration をすべて正常に適用し、アプリのテーブルが空の DB

最後に確認した状態（2026-11-14、Step 3-12B-5E-9A-9-7）は **C** です（migration 8件）。→（2026-11-23 更新）Step 4-8B でコンテナを作り直し（前のコンテナは停止していた）、Step 4-10 の統合テストの後の確認（2026-11-23）でも **C** です。過去の記録から推定せず、使う前に `testdb:verify` で確かめます。

### migration 履歴の検証の範囲

| 検証 | 方法 | 最後の結果 |
|---|---|---|
| 適用の状態（名前・成功・重複・不足・余分） | 状態 C の判定（`testdb:verify`） | 2026-11-14 に一致 |
| checksum | `testdb:checksums -- --verify`（ゲートが必要） | 2026-11-09（Step 3-12B-5C-3C）に8件すべて一致。それ以降は再照合していない |
| PostgreSQL 固有の定義・enum | カタログの監査（`testdb:catalog -- --verify`、ゲートが必要。`--verify-created` の FP にも含まれる） | 2026-11-14 に `passed` |
| `schema.prisma` との定義の一致 | schemaDiff（`testdb:schema-diff -- --live`、ゲートが必要） | 2026-11-14 に `no-diff`（Prisma が比較できる範囲だけ） |

### 読み取り専用ロール `katana_test_ro`

- schemaDiff（Prisma CLI）で接続するための、SELECT しかできないロールです（16テーブル）。
- 作成は Step 3-12B-5E-6 で1回だけ行いました。データ領域が tmpfs なので、**コンテナを作り直すとロールは消えます。** そのときは、PLAN の Step 3-12B-5E の手順（作成のゲートの有効化・作成・独立した検証・ゲートの無効化を、それぞれ承認を得て）でもう一度作ります。
- 作成後の状態は、`testdb:ro-role:verify-created`（読み取り専用）で確かめられます。

### 固定ゲート

実DB・Docker・Prisma CLI に到達する経路は、スクリプトのコードに書いた固定の値（ゲート）で止めています。**環境変数や引数では解除できません。** 有効にするには、承認を得てスクリプトを変更し、commit する必要があります。

| ゲート | スクリプト | 止める操作 | 今の状態 |
|---|---|---|---|
| `LIVE_DATABASE_DISABLED` | `scripts/testdb-migrate.mts` | `--apply`（migration の適用） | 無効 |
| `CHECKSUM_DATABASE_DISABLED` | `scripts/testdb-checksums.mts` | `--verify`（checksum の実DB照合） | 無効 |
| `CATALOG_AUDIT_DATABASE_DISABLED` | `scripts/testdb-catalog.mts` | `--verify`（カタログの監査） | 無効 |
| `SCHEMA_DIFF_DISABLED` | `scripts/testdb-schema-diff.mts` | `--live`（schemaDiff） | 無効 |
| `RO_ROLE_CREATE_DISABLED` | `scripts/testdb-ro-role.mts` | `--create --apply`（`katana_test_ro` の作成） | 無効 |
| `RO_ROLE_GRANT_SYNC_DISABLED` | `scripts/testdb-ro-role.mts` | `--grant-sync --apply`（権限の補完） | 無効 |
| `INTEGRATION_DATABASE_DISABLED` | 定数は `lib/testing/integrationDatabaseSetup.ts`。適用箇所は2か所：`lib/testing/integrationGlobalSetup.ts`（globalSetup）と `lib/testing/integrationSetup.ts`（setupFiles） | `npm run test:integration`（統合テストのDBへの接続。Step 4-3 で追加、Step 4-4 で setupFiles にも適用） | 無効（2か所とも） |
| `E2E_DEV_SERVER_DISABLED` | `scripts/e2e-dev-server.mts`（定数は `lib/testing/e2eDevServer.ts`） | `npm run e2e:dev-server -- --start`（E2E 用の開発サーバーの起動。テストDB に書き込める。Step 4-13B で追加） | 無効 |
| `E2E_FIXTURE_DISABLED` | `scripts/testdb-e2e.mts`（定数は `lib/testing/testDbE2eFixtures.ts`） | `npm run testdb:e2e -- --op <操作> --apply`（E2E 用のテストデータの準備と、シナリオごとの DB の変更。Step 4-13C で追加） | 無効 |

ゲートが無効の場合、これらの操作は、事前の検証の後、Docker・DB・Prisma CLI に触れる前に、それぞれのエラー（`TESTDB_MIGRATION_LIVE_DISABLED`・`CHECKSUM_LIVE_DISABLED`・`CATALOG_AUDIT_LIVE_DISABLED`・`SCHEMA_DIFF_LIVE_DISABLED`・`RO_ROLE_CREATE_DISABLED`・`RO_ROLE_GRANT_SYNC_DISABLED`・`INTEGRATION_DATABASE_LIVE_DISABLED`・`E2E_DEV_SERVER_LIVE_DISABLED`・`E2E_FIXTURE_LIVE_DISABLED`）で止まります。

第7のゲート（`INTEGRATION_DATABASE_DISABLED`）は、2か所の適用箇所が**それぞれ**接続を拒否します。有効化・無効化は、承認を得て、**2か所を同じ commit で変え、両方を確かめます**（2か所の値が同じであることは、`lib/testing/integrationWorkerCheck.test.ts` の静的テストで確かめています）。環境変数や引数でゲートを有効にする仕組みは作りません。

`testdb:verify` の読み取り専用の接続は、上の9つとは別の固定の許可（`readOnlyDatabase`。Step 3-11B で承認済み）で、有効です。

---

## 3. コマンドの一覧

### 承認なしで実行できるもの（Docker・DB に触れない）

| コマンド | 内容 |
|---|---|
| `npx vitest run <ファイル>` | ファイルを指定した通常テスト。DB・Docker・子プロセスに触れないことを確かめたファイルだけ |
| `npx tsc --noEmit -p .` | 型検査 |
| `npx eslint <ファイル>` | ESLint |
| `npm run test:integration:check` | 統合テストの runner の検証と、子プロセスの設定の表示だけ（Vitest を起動しない） |
| `npm run e2e:dev-server` | E2E 用の開発サーバーの予行（`.env.test` の検証と、起動予定のコマンド・環境変数の表示だけ。開発サーバーを起動しない。DB・Docker に触れない） |
| `npm run testdb:e2e` / `npm run testdb:e2e -- --op <操作>` | E2E 用のテストデータの操作の一覧と、予行（`.env.test` と、`seed` のときは `.env.e2e` の検証と、実行予定の SQL の種類・件数の表示だけ。パスワードのハッシュを作らない。DB・Docker に触れない） |
| `npm run testdb:migrate` / `testdb:migrate:check` | migration の予行・確認（Prisma CLI を起動しない） |
| `npm run testdb:checksums` | ローカルの checksum の計算だけ |
| `npm run testdb:catalog` | リポジトリのファイルからの期待値の構築だけ |
| `npm run testdb:ro-role:create` / `testdb:ro-role:grant-sync` | 予行（実行予定の docker exec の表示だけ） |
| `npm run testdb:schema-diff` | schemaDiff の予行（`.env.test`・`.env.test.readonly` の検証、CLI・engine の SHA-256 の照合、実行予定のコマンドの表示）。Prisma CLI は起動しない |

`npm test`（`vitest run` を引数なし）は、`vitest.config.ts` で統合テスト（`*.integration.test.*`）を除外し、ダミーの `DATABASE_URL` を設定しています。ただし、実行のたびに承認を得ます（2026-11-07 以降のユーザーの方針）。

### 承認が必要なもの（読み取りだけ）

| コマンド | 触れるもの | 内容 |
|---|---|---|
| `npm run testdb:check` | Docker | `docker context show`・`docker compose config` で、`.env.test` と Compose の定義を照合する（コンテナは操作しない） |
| `npm run testdb:status` | Docker | テストDB のコンテナ・ボリュームと、開発用ボリュームの状態を読む |
| `npm run testdb:identity` | Docker | テストDB のコンテナの識別情報を照合する（DB には接続しない） |
| `npm run testdb:up` / `testdb:down`（`--apply` なし） | Docker | 確認と、実行予定のコマンドの表示だけ（コンテナは操作しない） |
| `npm run testdb:verify` | DB | 本人確認・状態 A/B/C・migration に必要な権限・サーバーの識別情報（`BEGIN READ ONLY` の中の SELECT・SHOW と ROLLBACK だけ） |
| `npm run testdb:ro-role:preflight-create` | Docker・DB | `katana_test_ro` の作成前の読み取り専用の検証 |
| `npm run testdb:ro-role:verify-created` | Docker・DB | 作成後の独立した検証（D1・F1・FP-created・A1・R-full・FP-recheck・D2。docker exec はしない） |

### 承認が必要なもの（変更を伴う、または固定ゲートが必要）

| コマンド | 内容 | 今の状態 |
|---|---|---|
| `node scripts/testdb.mts --up --apply` | テストDB のコンテナを作成・起動する | 実行できる（承認が必要） |
| `node scripts/testdb.mts --down --apply` | `katana-test` のコンテナを停止・削除する（tmpfs のデータとロールは消える） | 実行できる（承認が必要） |
| `npm run testdb:migrate -- --apply` | migration の適用 | ゲートが無効なので止まる |
| `npm run testdb:checksums -- --verify` | checksum の実DB照合 | ゲートが無効なので止まる |
| `npm run testdb:catalog -- --verify` | カタログの監査 | ゲートが無効なので止まる |
| `node scripts/testdb-schema-diff.mts --live` | schemaDiff（Prisma CLI） | ゲートが無効なので止まる |
| `node scripts/testdb-ro-role.mts --create --apply` / `--grant-sync --apply` | `katana_test_ro` の作成・補完 | ゲートが無効なので止まる |
| `npm run test:integration` | 統合テスト | **まだ使えない（実DBでは一度も実行していない）。**（→ 2026-11-23 更新・Step 4-10：承認を得てゲートを一時的に有効にし、1回実行して成功。今はゲートが無効なので、再び止まる） globalSetup（`lib/testing/integrationGlobalSetup.ts`）は、接続前の検証（R14-1）の後、第7の固定ゲート `INTEGRATION_DATABASE_DISABLED` で、DB に接続する前・テストを始める前に必ず停止する（`INTEGRATION_DATABASE_LIVE_DISABLED`）。setupFiles（`lib/testing/integrationSetup.ts`）も同じゲートで、Prisma を読み込む前に止まる。ゲートが有効なときだけ、読み取り専用で状態 C とサーバーの識別情報を確かめ、終了後に再確認する（データの削除・reset はしない）。詳細は「5. 統合テストの経路」 |
| `npm run e2e:dev-server -- --start` | E2E 用の開発サーバーの起動（テストDB に書き込める。Step 4-13B） | **ゲートが無効なので止まる**（検証の後、起動の前に `E2E_DEV_SERVER_LIVE_DISABLED`）。まだ一度も起動していない。詳細は「7. E2E 用の開発サーバー」 |
| `npm run testdb:e2e -- --op <操作> --apply` | E2E 用のテストデータの準備・シナリオごとの DB の変更（Step 4-13C） | **ゲートが無効なので止まる**（検証の後、読み取り専用の検査・接続の前に `E2E_FIXTURE_LIVE_DISABLED`）。まだ一度も実行していない。詳細は「7. E2E 用の開発サーバー」 |

### 使わないもの

- **テストDB に対して Prisma CLI を直接実行しない**（`npx prisma migrate deploy`・`migrate reset`・`db push`・`studio` など）。`KATANA_DB_TARGET=test` を付けずに実行すると、`.env` の開発用DB に接続します（PLAN の R3）。migration は `testdb:migrate`、定義の照合は `testdb:schema-diff` を使います。
- **`docker compose` を直接実行しない。** テストDB の操作は、`scripts/testdb.mts` のラッパーからだけ行います（PLAN の R14）。
- `testdb:reset` はまだありません（未実装）。

### 失敗したときの対応

- 自動で再実行・修復しません（コンテナの再作成、migration の適用・reset、ロール・ACL の変更をしない）。
- 出力（伏せ字の処理を通したもの）を記録し、ユーザーに報告して、個別の承認を待ちます。
- 事後の検査が失敗した場合や、判定が `interrupted`・`cleanup-failed`・`post-check-failed` の場合は、DB が変わっていないことを保証しません。
- 状態 B が見つかった場合、自動では直しません。

---

## 4. schemaDiff の運用

### 方式A の構成

Prisma CLI の `migrate diff` を、`katana_test_ro` の接続URL で実行します（Step 3-12B-5E-9A で決定・実装）。

| ファイル | 役割 |
|---|---|
| `scripts/testdb-schema-diff.mts` | 入出力をつなぐだけ。固定ゲートを渡し、最初に SIGINT・SIGTERM の受け付けを登録する |
| `lib/testing/testDbSchemaDiffRunner.ts` | 手順と最終判定 |
| `lib/testing/schemaDiff.ts` | 固定のコマンド、子プロセスの環境変数、CLI・engine の SHA-256 の照合、プロセスグループごとの起動・タイムアウト・中断、伏せ字、終了コードの分類 |
| `prisma.schemadiff.config.ts` | schemaDiff 専用の Prisma の設定ファイル（`dotenv/config` を読まない）。ガードを通った `katana_test_ro` の URL だけを使う |
| `lib/db/prismaCliGuard.ts`（`resolvePrismaCliReadOnlyTarget`） | Prisma CLI のプロセスの中のガード。接続先モード・`NODE_OPTIONS`・argv・環境変数の許可リスト（macOS の `__CF_USER_TEXT_ENCODING` は名前と値の形式を限定して許す）・固定の値・`.env.test.readonly` の検証・URL の SHA-256 の照合 |

runner は URL を子プロセスの環境変数に入れず、URL の SHA-256 だけを渡します。既存の `prisma.config.ts`（開発用・migration 用）は使いません。

### 手順と判定

1. 事前の検証（ファイルの読み取り、CLI・engine の SHA-256）
2. **事前の検査：** D1（Docker の識別）→ F1（状態 C・本人確認）→ FP1（カタログの監査と fingerprint）→ A1（ACL）→ R1（`katana_test_ro` 本人の権限）→ D2（D1 と一致）
3. CLI・engine の SHA-256 の再照合 → Prisma CLI の起動（shell なし・新しいプロセスグループ・タイムアウト120秒）
4. **事後の検査：** CLI の成否にかかわらず、D3・F2・FP2（FP1 と一致）・R2 をすべて試す

事前の検査は、正しいコンテナ・DB・ロールに対して、想定どおりの状態で実行することを確かめるためのものです。事後の検査は、実行の間に Docker・DB・カタログ・権限が変わっていないことを確かめるためのものです。

| 判定 | 終了コード | 意味 |
|---|---|---|
| `no-diff` | 0 | Prisma が比較できる範囲で差分がなく、事前・事後の検査がすべて成功 |
| `diff` | 2 | Prisma が比較できる範囲で差分がある（自動では直さない） |
| `cli-failed` | 1 | CLI または engine の実行に失敗 |
| `interrupted` | 1 | SIGINT・SIGTERM を受けた |
| `cleanup-failed` | 1 | CLI のプロセスグループの停止を確かめられなかった |
| `post-check-failed` | 1 | 事後の検査が失敗した |

判定の優先順は `post-check-failed` → `cleanup-failed` → `interrupted` → CLI の結果です。`no-diff` 以外では、DB が変わっていないことを保証しません。中断の後の事後の検査は60秒が上限で、2回目の中断か上限を超えたら、プロセスグループに SIGKILL を送って終了コード1で終わります。

### 実行の手順（毎回）

1. ゲートの一時有効化について承認を得て、`scripts/testdb-schema-diff.mts` の `access` と、静的テスト（`lib/testing/schemaDiff.test.ts` のテスト13）を変える commit を作る。テスト・型検査・静的検査を通す。
2. 実行の前に、Git の状態・ゲート・`.env*` などのハッシュ・`testdb:identity`・予行を確かめる。想定と違えば実行しない。
3. `--live` は、明示的な承認を得てから1回だけ実行する。失敗しても、再実行・引数や環境変数を変えた再試行・DB の修復はしない。
4. 実行の後に、独立した読み取り専用の事後検証（`testdb:status`・`testdb:identity`・`testdb:verify`・`testdb:ro-role:verify-created`）を行う。
5. ゲートを `SCHEMA_DIFF_DISABLED` に戻す commit を作り、結果を PLAN に記録する。

### Prisma の比較の範囲

- **比較する：** テーブル、列の型（ネイティブ型の引数を含む）、NULL 可否、既定値（例外あり）、autoincrement、主キー、外部キー、インデックス、拡張機能。
- **比較しない：** `_prisma_migrations` と PostGIS のテーブル、列の順序、collation、identity・generated の詳細、CHECK・EXCLUDE の式、部分インデックスの条件、INCLUDE 列、NULLS NOT DISTINCT、一意制約と一意インデックスの違い、NOT VALID、MATCH の種類、所有者と ACL。
- **比較するか未確認：** DEFERRABLE・DEFERRED、コメント、enum の値。
- 比較しない項目の一部（enum の値と順序、CHECK・EXCLUDE・制約トリガー・部分インデックス・式インデックスが0件であること、行セキュリティ、所有者と ACL）は、カタログの監査・FP1/FP2・A1 で補っています。列の順序・collation・identity・generated・DEFERRABLE・インデックスの定義は、FP1/FP2 の前後の比較だけで、期待値とは照合していません。

### 残余リスク

- migration の checksum は、2026-11-09 以降、実DB で再照合していない。`no-diff` は migration の履歴全体の整合性の証明ではない。
- fingerprint の4区分（columns・constraints・indexes・relations）は、期待値との照合が限定的。
- 方式A では、Prisma CLI が `katana_test_ro` のパスワードを含む URL を schema engine の起動引数に渡す（ローカルの専用テストDB と最小権限のロールに限って受け入れた残余リスク）。
- schema engine の起動と DB への接続は、直接は観測していない（終了コードと実装の経路からの推論）。
- CLI・engine の SHA-256 の照合と実行の間の差し替え（TOCTOU）は防げない。
- SIGKILL・OOM などで親のプロセスが突然終わると、後始末と事後の検査を行えない。
- 結果は、実行した時点のスナップショット。

詳細は PLAN の「Step 3-12B-5E-9A」以降の節にあります。

---

## 5. 統合テストの経路（Phase 4。2026-11-23・Step 4-1〜4-4）

**この節は、経路と安全装置の説明です。手順書ではありません。** 統合テストは、第7の固定ゲート（`INTEGRATION_DATABASE_DISABLED`）が2か所とも無効なので、今は DB に接続する前に必ず止まります。**実DBでは一度も実行していません。**（→ 2026-11-23 更新・Step 4-10：ゲートを一時的に有効にして1回実行し、6ファイル・54件が成功。事後の確認でも状態 C。PLAN の 4-A の「Step 4-10 の実施記録」）実行するには、事前の確認と、ゲートの有効化・実行・無効化のそれぞれについて、個別の承認が必要です（PLAN の4章）。

### 実行の経路と、各段階の責務

| 段階 | ファイル | プロセス | 責務 |
|---|---|---|---|
| runner | `scripts/test-integration.mts`（`lib/testing/integrationEnv.ts`） | 親 | `.env.test` を読み、接続先とパスワードを検証し、許可リストの環境変数だけで Vitest を起動する。DB には接続しない |
| globalSetup | `lib/testing/integrationGlobalSetup.ts`（本体は `lib/testing/integrationDatabaseSetup.ts`） | Vitest のメインプロセス（1回） | 接続前の検証 → 第7のゲート → 独立した pg の接続1回で、読み取り専用の検査（状態 C・サーバーの識別情報）→ teardown を返す |
| setupFiles | `lib/testing/integrationSetup.ts`（本体は `lib/testing/integrationWorkerCheck.ts`） | ワーカー（テストファイルごと） | 接続前の検証 → 第7のゲート → テストが使う Prisma Client（`@/lib/prisma`）を動的 import し、SELECT 1文で本人確認 |
| Prisma Client | `lib/prisma.ts` | ワーカー | Vitest の中では、`PrismaPg`・`PrismaClient` を作る前に、通常テストなら拒否し、統合テストのモードなら接続前の検証を行う |

- **接続前の検証**（`lib/db/testDatabaseGuard.ts` の `assertIntegrationRuntime`）は、globalSetup・setupFiles・`lib/prisma.ts` で同じ条件です：実行モードと runner の目印、`NODE_OPTIONS` がないこと、`.env.test` があること、接続先がテストDB であること（`PG*`・`DOTENV_*`・開発用DB との比較を含む）、`DATABASE_URL` が `.env.test` の値と完全に一致すること、`.env.test` のパスワード（見本の値でない、URL と一致、管理用と共用しない）。runner を通さずに起動しても、この条件を満たさなければ止まります（R14-1 の対策）。
- **globalSetup の検査**は、`BEGIN READ ONLY` の中で `search_path` を `pg_catalog` に固定してから、本人確認・状態の判定・サーバーの識別情報（`inet_server_addr()`・`inet_server_port()`・`pg_postmaster_start_time()`）を読み、ROLLBACK して接続を閉じます。途中で失敗しても、ROLLBACK と接続の終了は必ず行います。
- **Prisma による本人確認**（setupFiles）は、`pg_catalog.current_database()`・`current_user`・`session_user`・DB のコメントを、関数・演算子を `pg_catalog` で修飾した SELECT 1文で読み、`katana_test`・`katana_test_user`・`katana-test-db` と照合します。1行でなければ、または1項目でも違えば止まります。

### 状態 C 以外では実行しない

- globalSetup は、状態 C（期待する migration がすべて適用済みで、アプリのテーブルが空）でなければ、テストを始めずに止まります（`INTEGRATION_STATE_NOT_C`）。状態 A・B を自動では直しません。
- サーバーの内部ポートが 5432 でなければ止まります。

### 逐次実行と bail

- `vitest.integration.config.ts` は `fileParallelism: false`・`maxWorkers: 1`・`maxConcurrency: 1`・`sequence: { concurrent: false, shuffle: false }` で、テストファイルもテストも1つずつ実行します。
- `bail: 1` で、最初に失敗したテストの後、残りのテストファイルを実行しません。そのとき、実行しなかったファイルは「未実施」として扱います。

### teardown（読み取り専用の再確認）

- テストの終了後、globalSetup が返した teardown が、同じ接続先をもう一度読み取り専用で検査します。
- サーバーの識別情報（アドレス・ポート・postmaster の起動時刻）が開始時と1つでも違えば `INTEGRATION_TEARDOWN_SERVER_CHANGED`、状態 C でなければ（テストデータが残っているなど）`INTEGRATION_TEARDOWN_STATE_NOT_C` で失敗します。

### テストが失敗したとき・データが残ったとき

- **自動では削除しません。** TRUNCATE・DELETE・DROP・migration・reset・Docker の操作は、統合テストの経路のどこにもありません。
- データが残ると、次の実行は globalSetup の開始前の検査（状態 C でない）で止まります。元に戻す方法は、テストDB の作り直しだけです（`testdb:reset` は未実装。手作業の作り直しには、Docker の操作・migration・`katana_test_ro` の再作成と、それぞれの承認・固定ゲートが必要）。**復旧の方法は、統合テストを実行する前に決めます**（PLAN の4章の「Phase 4 の残余リスク」）。→（2026-11-23・Step 4-6）既存のコマンドによる段階的な手動復旧（案2）に決めました。手順は「6. 統合テスト失敗後のテストDB復旧」。
- 失敗の出力は記録し、報告して、承認を待ちます（「失敗したときの対応」と同じ）。

---

## 6. 統合テスト失敗後のテストDB復旧（2026-11-23・Step 4-6 で決定、Step 4-7 で記録）

**この節は、承認を得て1つずつ行う手順の記録です。まとめて実行するスクリプトではなく、自動では実行しません。** 復旧の方式は、既存のコマンドによる段階的な手動復旧（PLAN の Step 4-6 の案2）です。専用の `testdb:reset` は作っていません（延期）。テストで作ったデータだけを SQL で削除する方法は採りません（「SQL による削除をしない」方針のため）。

統合テストは、まだ実DBで一度も実行していません。この手順も、統合テストのための復旧としては、まだ実施していません（同じ down・up・migration の組み合わせは、2026-11-07〜08 に Phase 3 で1回実施しています。PLAN の 3-12B-2・3-12B-3）。→（2026-11-23 更新）この手順1〜10を、Step 4-8B で1回実施しました（テストDB のコンテナが停止していたため。状態 A → C。PLAN の「Step 4-8B の実施記録」）。その後の統合テスト（Step 4-10）は成功し、データは残らなかったので、統合テストの後の復旧は行っていません。

### A. 復旧が必要になる状況

- テストデータが残った（teardown の `INTEGRATION_TEARDOWN_STATE_NOT_C`、または次の実行の globalSetup の `INTEGRATION_STATE_NOT_C`）
- DB が状態 B になった（データの残り、migration の不一致、想定外のオブジェクト）
- teardown が失敗した（`INTEGRATION_TEARDOWN_INSPECTION_FAILED`。DB の状態は不明）
- プロセスの異常終了（SIGKILL など）で teardown が動かず、DB の状態が不明
- コンテナが再起動した（`INTEGRATION_TEARDOWN_SERVER_CHANGED`、`testdb:identity` の StartedAt・RestartCount の変化。tmpfs のため、データとロールは消えている）
- migration が途中で失敗した（`testdb:migrate` が止まった。一部だけ適用された可能性がある）

### B. 復旧を始める前の確認

1. **Git の状態：** ブランチ・HEAD・未commit の変更が想定どおりであること。
2. **固定ゲート：** 7つ（第7のゲートは2か所とも）が無効であること（2026-11-23・Step 4-13B 以降は、8つ目の `E2E_DEV_SERVER_DISABLED` を含めて8つ。E2E 用の開発サーバーも止めておく。2026-11-24・Step 4-13C 以降は、9つ目の `E2E_FIXTURE_DISABLED` を含めて9つ）。統合テストのために第7のゲートを有効にしていた場合は、先に無効に戻す commit を作る（統合テストと復旧を同時に行わない）。
3. **Docker の対象の同一性：** `npm run testdb:status`・`npm run testdb:identity`（Docker の読み取り。承認が必要）。プロジェクト `katana-test`・コンテナ `katana-test-db` だけで、開発用ボリュームの記録が変わっていないこと。
4. **DB と postmaster の同一性：** `npm run testdb:verify`（DB の読み取り。承認が必要）。本人確認の4項目、状態 A・B・C、`pg_postmaster_start_time()`・`inet_server_addr()` を記録する。
5. **ほかのプロセスによる操作がないこと：** ほかの端末・セッションで、統合テスト・`testdb:*` の操作を行っていないこと。**これを検出する仕組み（ロックなど）はなく、運用で守ります。**
6. **開発用DB への影響がないこと：** 復旧の手順は、開発用のコンテナ・ボリューム・DB を操作の対象にしません（下の「開発用DB の保護」）。Phase 4 の件数の照合（開始時・終了時）で、最終的に確かめます。

### C. 状態ごとの対応

| `testdb:verify` の結果 | 対応 |
|---|---|
| 状態 C | 復旧は不要。独立した `testdb:verify` をもう一度行って確かめ、記録する |
| 状態 A | 本人確認の4項目が成功していることを先に確かめる。そのうえで、D の手順7〜10（migration のゲートの有効化 → `migrate --apply` を1回 → ゲートを無効に戻す → `verify`）で C にする。down・up はしない |
| 状態 B | 承認を得て、D の手順1から（down・up からやり直す）。B のまま migration を実行しない（runner も B では止まる） |
| 状態が分からない（`verify` が本人確認・接続・SQL で失敗した、識別情報が想定と違う） | 原因を読み取りだけで調べ、復旧の方法を決めるまで止まる。推測で down・up・migration を行わない |

### D. 復旧の手順（案2）

**それぞれの手順は、個別の承認を得てから行います。手順を自動で続けて実行しません。どの手順でも、失敗したら、そこで止まり、次の手順に進みません**（自動の再試行・修復・推測による変更をしない。終了コードと、失敗した手順を記録して、承認を待つ）。

| # | 操作 | 触れるもの | 固定ゲート | 止まる条件（主なもの） |
|---|---|---|---|---|
| 1 | `npm run testdb:status`・`npm run testdb:identity`・`npm run testdb:verify` | Docker・DB（読み取り） | 不要 | プロジェクトにほかのコンテナがある、識別の照合の失敗、本人確認の失敗 |
| 2 | `npm run testdb:down`（`--apply` なしの予行） | Docker（読み取り） | 不要 | コンテナ・マウントが想定と違う（`CONTAINER_INSPECT_MISMATCH`）、プロジェクトの中身が想定と違う |
| 3 | `npm run testdb:down -- --apply` | Docker（`katana-test` のコンテナの停止・削除。tmpfs のデータとロールは消える） | なし（`--apply` と個別の承認） | 2 と同じ確認。停止後の照合の失敗（`POST_CHECK_FAILED`。作り直さない） |
| 4 | `npm run testdb:up`（`--apply` なしの予行） | Docker（読み取り） | 不要 | コンテナが残っている（`TEST_CONTAINER_EXISTS`）、5434番が使われている、イメージ `postgres:15` がない（取得しない） |
| 5 | `npm run testdb:up -- --apply` | Docker（`katana-test-db` の作成・起動） | なし（`--apply` と個別の承認） | 4 と同じ確認。起動後の照合の失敗（tmpfs・ポート・healthy・ボリューム・開発用の記録。何も削除しない） |
| 6 | `npm run testdb:status`・`npm run testdb:identity`・`npm run testdb:verify` | Docker・DB（読み取り） | 不要 | **状態 A でなければ止まる**。新しいコンテナの識別情報を記録する |
| 7 | migration のゲート `LIVE_DATABASE_DISABLED`（`scripts/testdb-migrate.mts`）を有効にする commit | コードの変更 | migration のゲート | 個別の承認と、対応する静的テストの更新が必要。ほかのゲートは変えない |
| 8 | `npm run testdb:migrate -- --apply` を1回だけ | Docker（読み取り）・DB（migration） | migration のゲート（手順7） | 状態 B（状態 C なら CLI を起動せずに成功とする）、権限の不足（`MIGRATION_PRIVILEGES_INSUFFICIENT`）、D1・F1・D2 の不一致（CLI の起動前）。CLI の失敗・F2・D3 の不一致（起動後。一部適用の可能性。自動の再実行・reset はしない） |
| 9 | migration のゲートを無効に戻す commit | コードの変更 | — | 手順8が失敗しても、必ず行う |
| 10 | 独立した `npm run testdb:verify`（あわせて `testdb:identity`） | Docker・DB（読み取り） | 不要 | 状態 C でなければ、復旧は未完了 |

- `npm run testdb:migrate`（引数なし）は予行で、Docker・DB に触れず、Prisma CLI も起動しません（承認なしで実行できます）。手順7の前の確認に使えます。
- migration のゲートを有効にしているあいだ、第7のゲート（統合テスト）は有効にしません。
- 手順3の後は、手順5が成功するまで、テストDB はありません（統合テストも、ほかの `testdb:*` の DB への接続もできません）。

### E. 読み取り専用ロール `katana_test_ro`

- `katana_test_ro` は schemaDiff でだけ使い、統合テストでは使いません。**統合テストのための復旧の対象には含めません。**
- down・up の後は、ロールはありません（tmpfs）。schemaDiff を行う前に、必要なら、別の承認で作り直して確かめます（`npm run testdb:ro-role:preflight-create` → create のゲート `RO_ROLE_CREATE_DISABLED` の有効化 → `npm run testdb:ro-role:create -- --apply` → ゲートを無効に戻す → `npm run testdb:ro-role:verify-created`）。

### F. 復旧の完了条件

次のすべてを、**復旧の後に新しく実行した結果で**確かめます（過去の検証結果で代えない）。

- Docker の対象の同一性：`testdb:identity` が成功（プロジェクト・ラベル・`127.0.0.1:5434` だけ・tmpfs・マウント・healthy・イメージ・開発用の記録）
- 正しい DB と postmaster：`testdb:verify` の本人確認の4項目が成功し、postmaster の識別情報を記録した
- migration の8件が、名前で完全に一致し、失敗・ロールバック・重複がない（`testdb:verify` の状態 C の判定に含まれる）
- 状態 C（15テーブルが空、想定外のオブジェクトがない）
- 開発用DB への影響がない（up・down の事後の照合と、Phase 4 の件数の照合）
- 固定ゲートが7つとも無効（migration のゲートを戻した）。Step 4-13B 以降は8つとも無効、Step 4-13C 以降は9つとも無効
- 復旧の結果（実行した手順、終了コード、識別情報、状態）を、PLAN に記録した

### 開発用DB の保護（この手順で働く既存の仕組み）

- Docker の操作は `scripts/testdb.mts` からだけ行い、Compose のプロジェクト（`katana-test`）・ファイル（`docker-compose.test.yml`）・ディレクトリ・env ファイルを必ず固定する。開発用の `docker-compose.yml` は使わない。
- `--volumes`・`--remove-orphans`・`--rmi` などの引数は使わない（拒否する）。`DOCKER_HOST`・`DOCKER_CONTEXT` があれば止まり、コンテキスト `desktop-linux` を照合する。
- 開発用のコンテナ `katana-db` と開発用ボリュームには、読み取りしかしない。開発用ボリュームの記録を、操作の前後で比べる。
- DB への接続は、接続前のガード（`127.0.0.1:5434`・`katana_test`・`katana_test_user`、開発用DB の URL の拒否）と、接続後の本人確認を通る。

---

## 7. E2E 用の開発サーバー（Phase 4。2026-11-23・Step 4-13A・4-13B。準備中）

**この節は、経路と安全装置の説明です。手順書ではありません。** E2E 用の開発サーバーは、8つ目の固定ゲート（`E2E_DEV_SERVER_DISABLED`）が無効なので、今は起動の前に必ず止まります。**まだ一度も起動していません。** データの準備用のスクリプトと E2E の手順書は、まだありません（PLAN の Step 4-13C 以降）。

- **起動の経路：** `npm run e2e:dev-server`（予行）／`npm run e2e:dev-server -- --start`（ゲートが有効なときだけ起動）。本体は `lib/testing/e2eDevServer.ts`、入口は `scripts/e2e-dev-server.mts`。テストDB を使う開発サーバーを、このスクリプトを通さずに手で起動しない。
- **起動するもの：** `next dev --hostname 127.0.0.1 --port 3100`（shell を使わない。自分の PC からだけ。開発用の `localhost:3000` とは別）。
- **渡す環境変数：** 親の許可リストの変数と、`DATABASE_URL`（`.env.test` の値）・`KATANA_DB_TARGET=test`・`AUTH_SECRET`（起動のたびに作る乱数。保存も表示もしない。`.env.local` の値は使わない）・`NEXT_TELEMETRY_DISABLED=1` だけ。親の `DATABASE_URL`・`AUTH_SECRET`・`AUTH_URL`・`PG*`・`DOTENV_*`・`PORT` などは渡さない。親に `NODE_OPTIONS` があれば止まる。
- **アプリの中のガード（P9。`lib/prisma.ts`）：** Vitest の外で `KATANA_DB_TARGET` が設定されていれば、`PrismaPg`・`PrismaClient` を作る前に `assertAppDatabaseTarget()` で確かめる。`test` なら、`DATABASE_URL` が `.env.test` の値と完全に一致し、テストDB を指し、`.env.test` のパスワードが正しいこと。それ以外の値は拒否する。未設定のとき（開発・本番の通常の起動）は何もしない。
- **有効化・無効化：** 承認を得て、`scripts/e2e-dev-server.mts` のゲートの行を変える commit で行う（対応する静的テスト `lib/testing/e2eDevServer.test.ts` も同じ commit で更新する）。E2E が終わったら、開発サーバーを止めて、ゲートを無効に戻す。環境変数や引数でゲートを有効にする仕組みは作らない。
- **E2E の後：** テストDB を、「6. 統合テスト失敗後のテストDB復旧」の手順で作り直す（E2E で作ったデータは、SQL で削除しない）。

### E2E 用のテストデータ（2026-11-24・Step 4-13C。準備中）

**まだ一度も `--apply` で実行していません。** 9つ目の固定ゲート（`E2E_FIXTURE_DISABLED`）が無効なので、`--apply` でも、検証の後、DB に接続する前に止まります。

- **経路：** `npm run testdb:e2e`（操作の一覧）／`npm run testdb:e2e -- --op <操作>`（予行）／`npm run testdb:e2e -- --op <操作> --apply`（ゲートが有効なときだけ実行）。本体は `lib/testing/testDbE2eFixtures.ts`、入口は `scripts/testdb-e2e.mts`。E2E のデータを、このスクリプトの固定の操作以外の SQL や Prisma で書き込まない。
- **操作（固定の名前だけ）：** `seed`（状態 C の空のテストDB に、店舗 A〜D・ユーザー7人・商品4件・取り込み2件・マスタ2件）、`e2e01-deactivate-shop-a`、`e2e02-activate-shop-a`、`e2e03-delete-user`、`e2e04-move-user-to-shop-b`、`e2e05-demote-admin`、`e2e06-deactivate-shop-d`。SQL は固定の文字列で、変更の操作は、固定の ID と今の値の条件で、ちょうど1行だけを対象にする（同じ操作を2回行うと、2回目は0件で ROLLBACK して止まる）。削除は `e2e03-delete-user` のユーザー1件だけ（取り込み・商品・履歴の参照がないことが条件）。
- **`--apply` の流れ：** 検証（引数、Node の起動オプション、`NODE_OPTIONS`、`.env.test` の接続先とパスワード、親の `PG*`・`DOTENV_*`、`seed` のときは `.env.e2e`）→ 9つ目の固定ゲート → 読み取り専用の検査（`seed` は状態 C、それ以外は「データがあるだけの B」）→ 1回の接続で BEGIN・search_path の固定・本人確認・固定の SQL（件数を確かめる）・COMMIT（途中で失敗したら ROLLBACK）→ 事後の読み取り専用の検査（「データがあるだけの B」で、サーバーが同じ）。TRUNCATE・DROP・ALTER・GRANT・migration・Docker の操作はしない。
- **E2E 用のユーザー：** メールアドレスは `e2e-01@example.invalid` などの、実在しないドメイン。パスワードは `.env.e2e`（キーは `KATANA_E2E_USER_PASSWORD` だけ。16文字以上、`[A-Za-z0-9_-]` だけ、見本の値でない、テストDB のパスワードと違う。`.env*` なので Git の対象外）に、ユーザーが作って置く（Step 4-13C の時点では、まだない）。DB には `bcryptjs` のハッシュ（コスト10）だけを入れる。パスワードとハッシュは表示しない。
- **E2E の後：** テストDB を、「6. 統合テスト失敗後のテストDB復旧」の手順で作り直す（E2E で作ったデータは、SQL で削除しない）。
