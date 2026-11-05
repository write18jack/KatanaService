#!/usr/bin/env bash
# テスト専用DB（docker-compose.test.yml）の初期化。PostgreSQL 公式イメージが、データディレクトリが空のときだけ1回実行する。
# 開発用の docker-compose.yml にはマウントしない。対象が katana_test でなければ、何もせずに失敗する。
#
# アプリ・テストが使う katana_test_user を、スーパーユーザーではないログイン用ロールとして作り、katana_test の所有者にする。
# PostgreSQL 15 では public スキーマの所有者が pg_database_owner なので、DBの所有者は migration（テーブルの作成）を実行できる。
# パスワードは環境変数 KATANA_TEST_DB_PASSWORD（.env.test から Compose が渡す）から受け取り、表示しない。
# - psql のコマンドライン引数には渡さない（\getenv で環境変数から読む。psql 15 以降）。シェルのトレース（set -x）や psql の ECHO も使わない。
# - SQL が失敗しても、パスワードを含む文をログに残さない。このセッションだけ、文を記録するサーバーの設定を止め、
#   psql のエラー表示を文の抜粋（LINE 1: ...）のない形にする。失敗したときは ON_ERROR_STOP と set -e で初期化を止める。
set -Eeuo pipefail

if [ "${POSTGRES_DB:-}" != "katana_test" ]; then
  echo "[test-db init] refusing: POSTGRES_DB is not katana_test." >&2
  exit 1
fi
if [ -z "${KATANA_TEST_DB_PASSWORD:-}" ]; then
  echo "[test-db init] refusing: KATANA_TEST_DB_PASSWORD is empty." >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 -v VERBOSITY=terse -v SHOW_CONTEXT=never --no-psqlrc --username "$POSTGRES_USER" --dbname katana_test <<'SQL'
-- 失敗した文・時間のかかった文の全文を、サーバーのログに出さない（このセッションだけ。管理用のスーパーユーザーで変更できる）
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
\getenv app_password KATANA_TEST_DB_PASSWORD

DO $$
BEGIN
  IF current_database() <> 'katana_test' THEN
    RAISE EXCEPTION 'refusing to initialize database %', current_database();
  END IF;
END
$$;

CREATE ROLE katana_test_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
ALTER DATABASE katana_test OWNER TO katana_test_user;
-- 管理用の postgres DB には、アプリのロールから接続させない
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
SQL
