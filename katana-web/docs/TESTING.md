# テストとテストDB

このファイルは、テストの実行方法と、テスト専用DBの扱いをまとめたものです。設計・経緯・検証の記録は [PLAN-test-db-isolation.md](PLAN-test-db-isolation.md) にあります。両者が食い違う場合は、PLAN の記録と実装（`scripts/`・`lib/testing/`・`lib/db/`）が正です。

記載は 2026-11-15 時点（HEAD `0c1702b`）の状態に基づきます。**固定ゲートは6つともすべて無効です。**

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
| 設定ファイル | `.env` | `.env.test`（アプリ用・管理用のパスワード）、`.env.test.readonly`（`katana_test_ro`） |
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

最後に確認した状態（2026-11-14、Step 3-12B-5E-9A-9-7）は **C** です（migration 8件）。

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

ゲートが無効の場合、これらの操作は、事前の検証の後、Docker・DB・Prisma CLI に触れる前に、それぞれのエラー（`TESTDB_MIGRATION_LIVE_DISABLED`・`CHECKSUM_LIVE_DISABLED`・`CATALOG_AUDIT_LIVE_DISABLED`・`SCHEMA_DIFF_LIVE_DISABLED`・`RO_ROLE_CREATE_DISABLED`・`RO_ROLE_GRANT_SYNC_DISABLED`）で止まります。

`testdb:verify` の読み取り専用の接続は、上の6つとは別の固定の許可（`readOnlyDatabase`。Step 3-11B で承認済み）で、有効です。

---

## 3. コマンドの一覧

### 承認なしで実行できるもの（Docker・DB に触れない）

| コマンド | 内容 |
|---|---|
| `npx vitest run <ファイル>` | ファイルを指定した通常テスト。DB・Docker・子プロセスに触れないことを確かめたファイルだけ |
| `npx tsc --noEmit -p .` | 型検査 |
| `npx eslint <ファイル>` | ESLint |
| `npm run test:integration:check` | 統合テストの runner の検証と、子プロセスの設定の表示だけ（Vitest を起動しない） |
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
| `npm run test:integration` | 統合テスト | **まだ使えない。** globalSetup（`lib/testing/integrationGlobalSetup.ts`）が、テストを始めずに必ず停止する |

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
