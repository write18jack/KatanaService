#!/usr/bin/env bash
# テスト専用DB（docker-compose.test.yml）の初期化。PostgreSQL 公式イメージが、データディレクトリが空のときだけ1回実行する。
# 開発用の docker-compose.yml にはマウントしない。対象が katana_test でなければ、何もせずに失敗する。
#
# アプリ・テストが使う katana_test_user を、スーパーユーザーではないログイン用ロールとして作り、katana_test の所有者にする。
# PostgreSQL 15 では public スキーマの所有者が pg_database_owner なので、DBの所有者は migration（テーブルの作成）を実行できる。
# パスワードは環境変数 KATANA_TEST_DB_PASSWORD（.env.test から Compose が渡す）から受け取り、表示しない。
set -Eeuo pipefail

if [ "${POSTGRES_DB:-}" != "katana_test" ]; then
  echo "[test-db init] refusing: POSTGRES_DB is not katana_test." >&2
  exit 1
fi
if [ -z "${KATANA_TEST_DB_PASSWORD:-}" ]; then
  echo "[test-db init] refusing: KATANA_TEST_DB_PASSWORD is empty." >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --no-psqlrc --username "$POSTGRES_USER" --dbname katana_test \
  --set=app_password="$KATANA_TEST_DB_PASSWORD" <<'SQL'
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
