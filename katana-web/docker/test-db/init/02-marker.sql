-- テスト専用DBの識別コメント（2-1）。lib/testing/integrationDatabaseCheck.ts の TEST_DATABASE_MARKER と同じ値。
-- PostgreSQL 公式イメージが、データディレクトリが空のときだけ、01-app-role.sh の後に実行する（初期化の最後の手順）。
-- このコメントがあることを、初期化がすべて終わったことの印にする。対象が katana_test でなければ失敗する。
DO $$
BEGIN
  IF current_database() <> 'katana_test' THEN
    RAISE EXCEPTION 'refusing to set the test database marker on %', current_database();
  END IF;
END
$$;

COMMENT ON DATABASE katana_test IS 'katana-test-db';
