-- 読み取り専用ロール katana_test_ro の SELECT 権限の補完（操作2。Step 3-12B-5E-3。docs/PLAN-test-db-isolation.md）。
--
-- 将来の migration でテーブルが増えたときに、既存の katana_test_ro に、足りない SELECT だけを付与する。初回作成（01-create.sql）とは別の操作。
-- scripts/testdb-ro-role.mts が、R-base（読み取り専用ロールの事前の検査）で補完の対象が1件以上あるときだけ、
-- 固定の引数の docker exec で標準入力から1回だけ流す（psql -X -q --single-transaction -f -）。
-- 既存の権限は上書きしない：ロールの属性・設定・所属・依存・DB の ACL・付与済みのテーブルの ACL が、初回作成の後の値と完全に一致し、
-- ACL が未設定のテーブルが付与の対象と一致する場合だけ、GRANT を実行する。1つでも違えば RAISE で止まり、トランザクション全体が戻る。
-- このファイルはパスワード・検証子を受け取らない。値は \getenv で受け取り、DO ブロックの外の SET LOCAL でだけ :'名前' の形で展開する。

-- 文を記録するサーバーの設定を、このセッションだけ止める（初回作成と同じ）
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET search_path = pg_catalog;

\getenv expected_postmaster_start KATANA_TEST_EXPECTED_POSTMASTER_START
\getenv expected_tables KATANA_TEST_EXPECTED_TABLES
\getenv grant_targets KATANA_TEST_GRANT_TARGETS

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

-- クラスタの DB と、スキーマの ACL の照合（変更の前。Step 3-12B-5E-5A）。DB は4つだけで、katana_test の所有者は katana_test_user。
-- template0・template1・postgres の所有者・接続の可否・ACL（未設定なら acldefault で展開して比べる）・PUBLIC の実効権限が、
-- PostgreSQL 15 の initdb（template0・template1 から PUBLIC の CREATE・TEMPORARY を取り上げる）と初期化スクリプト
-- （postgres から PUBLIC の権限をすべて取り上げる）の結果と一致する。template1 の PUBLIC の CONNECT だけは許容する。
-- 非システムのスキーマは public だけで、所有者・ACL・PUBLIC の実効権限が PostgreSQL 15 の既定と一致する。
-- 期待値は lib/testing/testDbReadOnlyRole.ts の EXPECTED_PRE_CHANGE_SYSTEM_DATABASES・EXPECTED_PRE_CHANGE_SCHEMAS と同じ（テストで一致を確かめる）
DO $$
DECLARE
  found text;
BEGIN
  SELECT pg_catalog.string_agg(d.datname::text, ',' ORDER BY d.datname::text COLLATE "C") INTO found FROM pg_catalog.pg_database d;
  IF found IS DISTINCT FROM 'katana_test,postgres,template0,template1' THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the cluster databases are not the expected ones';
  END IF;
  IF (SELECT pg_catalog.pg_get_userbyid(d.datdba)::text || '|' || d.datallowconn::text FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
       IS DISTINCT FROM 'katana_test_user|true' THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the test database owner is not the expected one';
  END IF;
  SELECT pg_catalog.string_agg(x, ';' ORDER BY x COLLATE "C") INTO found
    FROM (SELECT d.datname::text || '|' || pg_catalog.pg_get_userbyid(d.datdba)::text || '|' || d.datallowconn::text || '|' || (d.datacl IS NULL)::text || '|'
                 || COALESCE((SELECT pg_catalog.string_agg(i, ',' ORDER BY i COLLATE "C")
                                FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
                                             || ':' || a.privilege_type || ':' || pg_catalog.pg_get_userbyid(a.grantor)::text
                                             || CASE WHEN a.is_grantable THEN ':GRANTABLE' ELSE '' END AS i
                                        FROM pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba))) a) items), '')
                 || '|' || pg_catalog.has_database_privilege('public', d.oid, 'CONNECT')::text
                 || '|' || pg_catalog.has_database_privilege('public', d.oid, 'TEMPORARY')::text
                 || '|' || pg_catalog.has_database_privilege('public', d.oid, 'CREATE')::text AS x
            FROM pg_catalog.pg_database d WHERE d.datname IN ('postgres', 'template0', 'template1')) dbs;
  IF found IS DISTINCT FROM
       'postgres|postgres|true|false|postgres:CONNECT:postgres,postgres:CREATE:postgres,postgres:TEMPORARY:postgres|false|false|false;'
       || 'template0|postgres|false|false|PUBLIC:CONNECT:postgres,postgres:CONNECT:postgres,postgres:CREATE:postgres,postgres:TEMPORARY:postgres|true|false|false;'
       || 'template1|postgres|true|false|PUBLIC:CONNECT:postgres,postgres:CONNECT:postgres,postgres:CREATE:postgres,postgres:TEMPORARY:postgres|true|false|false' THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the privileges of the other databases are not the expected ones';
  END IF;
  SELECT pg_catalog.string_agg(x, ';' ORDER BY x COLLATE "C") INTO found
    FROM (SELECT n.nspname::text || '|' || pg_catalog.pg_get_userbyid(n.nspowner)::text || '|' || (n.nspacl IS NULL)::text || '|'
                 || COALESCE((SELECT pg_catalog.string_agg(i, ',' ORDER BY i COLLATE "C")
                                FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
                                             || ':' || a.privilege_type || ':' || pg_catalog.pg_get_userbyid(a.grantor)::text
                                             || CASE WHEN a.is_grantable THEN ':GRANTABLE' ELSE '' END AS i
                                        FROM pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a) items), '')
                 || '|' || pg_catalog.has_schema_privilege('public', n.oid, 'USAGE')::text
                 || '|' || pg_catalog.has_schema_privilege('public', n.oid, 'CREATE')::text AS x
            FROM pg_catalog.pg_namespace n WHERE n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\_%') schemas;
  IF found IS DISTINCT FROM
       'public|pg_database_owner|false|PUBLIC:USAGE:pg_database_owner,pg_database_owner:CREATE:pg_database_owner,pg_database_owner:USAGE:pg_database_owner|true|false' THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the schemas or their privileges are not the expected ones';
  END IF;
END
$$;

-- 補完だけの前提（変更の前）：付与の対象が1件以上。ロールの属性・設定・所属・依存・DB の ACL が初回作成の後の値のまま。
-- 付与済みのテーブルの ACL が期待値と完全に一致し、依存（ACL）の一覧が付与済みのテーブルと一致する
DO $$
DECLARE
  ro_oid oid;
  found_tables text;
  granted_tables text;
BEGIN
  IF pg_catalog.current_setting('katana.grant_targets') = '' THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: there are no grant targets';
  END IF;
  SELECT r.oid INTO ro_oid FROM pg_catalog.pg_roles r
   WHERE r.rolname = 'katana_test_ro' AND NOT r.rolsuper AND NOT r.rolinherit AND NOT r.rolcreaterole AND NOT r.rolcreatedb
     AND r.rolcanlogin AND NOT r.rolreplication AND NOT r.rolbypassrls AND r.rolconnlimit = -1 AND r.rolvaliduntil IS NULL
     AND r.rolconfig = ARRAY['default_transaction_read_only=on']::text[];
  IF ro_oid IS NULL THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: katana_test_ro does not exist or its attributes are not the expected ones';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = ro_oid) <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
                     WHERE s.setrole = ro_oid AND s.setdatabase = 0 AND s.setconfig = ARRAY['default_transaction_read_only=on']::text[]) THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the role settings are not the expected ones';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = ro_oid OR m.roleid = ro_oid) THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the role has memberships';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_shdepend s
              WHERE s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND s.refobjid = ro_oid
                AND (s.deptype <> 'a' OR s.dbid <> (SELECT d.oid FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())
                     OR s.classid <> 'pg_catalog.pg_class'::pg_catalog.regclass OR s.objsubid <> 0)) THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the role has unexpected dependencies';
  END IF;
  SELECT pg_catalog.string_agg(c.relname::text, ',' ORDER BY c.relname::text COLLATE "C") INTO found_tables
    FROM pg_catalog.pg_shdepend s JOIN pg_catalog.pg_class c ON c.oid = s.objid
   WHERE s.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass AND s.refobjid = ro_oid AND s.deptype = 'a';
  SELECT pg_catalog.string_agg(c.relname::text, ',' ORDER BY c.relname::text COLLATE "C") INTO granted_tables
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relacl IS NOT NULL;
  IF found_tables IS DISTINCT FROM granted_tables THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the privilege dependencies do not match the granted tables';
  END IF;
  IF (SELECT pg_catalog.string_agg(x, ',' ORDER BY x COLLATE "C")
        FROM (SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END
                     || ':' || a.privilege_type || ':' || pg_catalog.pg_get_userbyid(a.grantor)::text AS x
                FROM pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) a
               WHERE d.datname = pg_catalog.current_database()) items)
       IS DISTINCT FROM 'PUBLIC:CONNECT:katana_test_user,katana_test_user:CONNECT:katana_test_user,katana_test_user:CREATE:katana_test_user,katana_test_user:TEMPORARY:katana_test_user' THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the database privileges are not the expected ones';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relacl IS NOT NULL
                AND (SELECT pg_catalog.string_agg(x, ',' ORDER BY x COLLATE "C")
                       FROM (SELECT pg_catalog.pg_get_userbyid(a.grantee)::text || ':' || a.privilege_type || ':' || pg_catalog.pg_get_userbyid(a.grantor)::text AS x
                               FROM pg_catalog.aclexplode(c.relacl) a) items)
                    IS DISTINCT FROM 'katana_test_ro:SELECT:katana_test_user,katana_test_user:DELETE:katana_test_user,katana_test_user:INSERT:katana_test_user,katana_test_user:REFERENCES:katana_test_user,katana_test_user:SELECT:katana_test_user,katana_test_user:TRIGGER:katana_test_user,katana_test_user:TRUNCATE:katana_test_user,katana_test_user:UPDATE:katana_test_user') THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: the existing table privileges are not the expected ones';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a WHERE a.grantee IN (0, ro_oid) AND a.is_grantable)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) a WHERE a.grantee IN (0, ro_oid) AND a.is_grantable)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) a WHERE a.grantee = ro_oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a WHERE a.grantee = ro_oid) THEN
    RAISE EXCEPTION 'katana-ro-role: refusing: unexpected privileges for the role or PUBLIC';
  END IF;
END
$$;

-- 変更（この1文だけ。付与済みのテーブルは、上の照合で期待値どおりと確かめてあるので変わらない）
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
