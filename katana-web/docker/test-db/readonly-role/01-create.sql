-- 読み取り専用ロール katana_test_ro の初回作成（操作1。Step 3-12B-5E-3。docs/PLAN-test-db-isolation.md）。
--
-- 初期化スクリプト（docker/test-db/init/）ではない。状態 C（migration の適用済み）のテストDBに対して、
-- scripts/testdb-ro-role.mts が固定の引数の docker exec で、標準入力から1回だけ流す（psql -X -q --single-transaction -f -）。
-- 変更の文の前に、本人確認・状態・対象のテーブルの照合をすべて行う。1つでも違えば RAISE で止まり、トランザクション全体が戻る。
-- 値は psql の \getenv で環境変数から受け取り、DO ブロックの外の文でだけ :'名前' の形で展開する
-- （psql は引用符・ドル引用符の中では変数を展開しない）。DO ブロックの中では、SET LOCAL した独自の設定を読む。
-- SCRAM の検証子は、CREATE ROLE の1か所でだけ展開する（独自の設定には入れない）。メッセージに値を含めない。

-- 文を記録するサーバーの設定を、このセッションだけ止める（検証子を含む文をログに残さない）
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET search_path = pg_catalog;

\getenv ro_verifier KATANA_TEST_RO_SCRAM_VERIFIER
\getenv ro_verifier_sha256 KATANA_TEST_RO_VERIFIER_SHA256
\getenv expected_postmaster_start KATANA_TEST_EXPECTED_POSTMASTER_START
\getenv expected_tables KATANA_TEST_EXPECTED_TABLES
\getenv grant_targets KATANA_TEST_GRANT_TARGETS

SET LOCAL katana.ro_verifier_sha256 = :'ro_verifier_sha256';
SET LOCAL katana.expected_postmaster_start = :'expected_postmaster_start';
SET LOCAL katana.expected_tables = :'expected_tables';
SET LOCAL katana.grant_targets = :'grant_targets';

-- 本人確認（変更の前）：DB・セッションのユーザー・DBのコメント・UNIX ソケットの接続・postmaster の起動時刻（F1 と同じ式）・migration の履歴
DO $$
BEGIN
  IF pg_catalog.current_database() <> 'katana_test' THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: unexpected database';
  END IF;
  IF session_user <> 'postgres' OR current_user <> 'postgres'
     OR NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user) THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: unexpected session user';
  END IF;
  IF pg_catalog.shobj_description((SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()), 'pg_database')
       IS DISTINCT FROM 'katana-test-db' THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the test database marker does not match';
  END IF;
  IF pg_catalog.inet_server_addr() IS NOT NULL THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: not a local socket connection';
  END IF;
  IF pg_catalog.to_char(pg_catalog.pg_postmaster_start_time() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
       IS DISTINCT FROM pg_catalog.current_setting('katana.expected_postmaster_start') THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the postmaster start time differs from F1';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public._prisma_migrations)
     OR EXISTS (SELECT 1 FROM public._prisma_migrations m WHERE m.finished_at IS NULL OR m.rolled_back_at IS NOT NULL) THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the migration history is not complete';
  END IF;
END
$$;

-- 対象のテーブルの照合（変更の前）：public のリレーションが期待する一覧と完全に一致し、すべて通常のテーブル。
-- sequence・ほかのスキーマのリレーション・列単位の権限・既定の権限の設定がない。ACL が未設定のテーブルが付与の対象と一致する
DO $$
DECLARE
  found_tables text;
BEGIN
  SELECT pg_catalog.string_agg(c.relname::text, ',' ORDER BY c.relname::text COLLATE "C") INTO found_tables
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f');
  IF found_tables IS DISTINCT FROM pg_catalog.current_setting('katana.expected_tables') THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the public relations do not match the expected tables';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('p', 'v', 'm', 'f', 'S')) THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: public has relations that are not plain tables';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname NOT IN ('public', 'pg_catalog', 'information_schema')
                AND n.nspname NOT LIKE 'pg\_toast%' AND n.nspname NOT LIKE 'pg\_temp\_%'
                AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')) THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: relations exist outside public';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
               JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND a.attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: column privileges exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl) THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: default privilege settings exist';
  END IF;
  SELECT pg_catalog.string_agg(c.relname::text, ',' ORDER BY c.relname::text COLLATE "C") INTO found_tables
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relacl IS NULL;
  IF found_tables IS DISTINCT FROM pg_catalog.current_setting('katana.grant_targets') THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the tables without privileges do not match the grant targets';
  END IF;
END
$$;

-- 初回作成だけの前提：すべてのテーブルが付与の対象（16件）、ロールが存在しない、DB の ACL が初期値のまま
DO $$
BEGIN
  IF pg_catalog.current_setting('katana.grant_targets') <> pg_catalog.current_setting('katana.expected_tables')
     OR pg_catalog.array_length(pg_catalog.string_to_array(pg_catalog.current_setting('katana.expected_tables'), ','), 1) <> 16 THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the initial creation must cover exactly the 16 expected tables';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'katana_test_ro') THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: katana_test_ro already exists';
  END IF;
  IF (SELECT d.datacl FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database()) IS NOT NULL THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the database privileges are not the initial ones';
  END IF;
END
$$;

-- 変更（この4文だけ）
CREATE ROLE katana_test_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT -1 PASSWORD :'ro_verifier';
ALTER ROLE katana_test_ro SET default_transaction_read_only = on;
REVOKE TEMPORARY ON DATABASE katana_test FROM PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO katana_test_ro;

-- 変更の後の照合（同じトランザクション。COMMIT の前）。違えば RAISE で全体が戻る
DO $$
DECLARE
  ro_oid oid;
  found_tables text;
BEGIN
  SELECT r.oid INTO ro_oid FROM pg_catalog.pg_roles r
   WHERE r.rolname = 'katana_test_ro' AND NOT r.rolsuper AND NOT r.rolinherit AND NOT r.rolcreaterole AND NOT r.rolcreatedb
     AND r.rolcanlogin AND NOT r.rolreplication AND NOT r.rolbypassrls AND r.rolconnlimit = -1 AND r.rolvaliduntil IS NULL
     AND r.rolconfig = ARRAY['default_transaction_read_only=on']::text[];
  IF ro_oid IS NULL THEN
    RAISE EXCEPTION 'katana-ro-role: the role attributes are not the expected ones';
  END IF;
  -- サーバーが検証子をそのまま保存したこと（平文として受け取っていないこと）
  IF (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(a.rolpassword, 'UTF8')), 'hex') FROM pg_catalog.pg_authid a WHERE a.oid = ro_oid)
       IS DISTINCT FROM pg_catalog.current_setting('katana.ro_verifier_sha256') THEN
    RAISE EXCEPTION 'katana-ro-role: the stored password is not the given verifier';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = ro_oid) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
                     WHERE s.setrole = ro_oid AND s.setdatabase = 0 AND s.setconfig = ARRAY['default_transaction_read_only=on']::text[]) THEN
    RAISE EXCEPTION 'katana-ro-role: the role settings are not the expected ones';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = ro_oid OR m.roleid = ro_oid) THEN
    RAISE EXCEPTION 'katana-ro-role: the role has memberships';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend s
              WHERE s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND s.refobjid = ro_oid
                AND (s.deptype <> 'a' OR s.dbid <> (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
                     OR s.classid <> 'pg_catalog.pg_class'::pg_catalog.regclass OR s.objsubid <> 0)) THEN
    RAISE EXCEPTION 'katana-ro-role: the role has unexpected dependencies';
  END IF;
  SELECT pg_catalog.string_agg(c.relname::text, ',' ORDER BY c.relname::text COLLATE "C") INTO found_tables
    FROM pg_catalog.pg_shdepend s JOIN pg_catalog.pg_class c ON c.oid = s.objid
   WHERE s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND s.refobjid = ro_oid AND s.deptype = 'a';
  IF found_tables IS DISTINCT FROM pg_catalog.current_setting('katana.expected_tables') THEN
    RAISE EXCEPTION 'katana-ro-role: the privilege dependencies do not match the expected tables';
  END IF;
  IF (SELECT pg_catalog.string_agg(x, ',' ORDER BY x COLLATE "C")
        FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
                     || ':' || a.privilege_type || ':' || pg_catalog.pg_get_userbyid(a.grantor)::text AS x
                FROM pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) a
               WHERE d.datname = pg_catalog.current_database()) items)
       IS DISTINCT FROM 'PUBLIC:CONNECT:katana_test_user,katana_test_user:CONNECT:katana_test_user,katana_test_user:CREATE:katana_test_user,katana_test_user:TEMPORARY:katana_test_user' THEN
    RAISE EXCEPTION 'katana-ro-role: the database privileges are not the expected ones';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r'
                AND (SELECT pg_catalog.string_agg(x, ',' ORDER BY x COLLATE "C")
                       FROM (SELECT pg_catalog.pg_get_userbyid(a.grantee)::text || ':' || a.privilege_type || ':' || pg_catalog.pg_get_userbyid(a.grantor)::text AS x
                               FROM pg_catalog.aclexplode(c.relacl) a) items)
                    IS DISTINCT FROM 'katana_test_ro:SELECT:katana_test_user,katana_test_user:DELETE:katana_test_user,katana_test_user:INSERT:katana_test_user,katana_test_user:REFERENCES:katana_test_user,katana_test_user:SELECT:katana_test_user,katana_test_user:TRIGGER:katana_test_user,katana_test_user:TRUNCATE:katana_test_user,katana_test_user:UPDATE:katana_test_user') THEN
    RAISE EXCEPTION 'katana-ro-role: the table privileges are not the expected ones';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a WHERE a.grantee IN (0, ro_oid) AND a.is_grantable)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) a WHERE a.grantee IN (0, ro_oid) AND a.is_grantable)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) a WHERE a.grantee = ro_oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a WHERE a.grantee = ro_oid) THEN
    RAISE EXCEPTION 'katana-ro-role: unexpected privileges for the role or PUBLIC';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
                  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                 WHERE n.nspname = 'public' AND a.attacl IS NOT NULL) THEN
    RAISE EXCEPTION 'katana-ro-role: unexpected default or column privileges';
  END IF;
END
$$;
