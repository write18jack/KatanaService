import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertReadOnlyTestDatabaseCredentials,
  assertReadOnlyTestDatabaseTarget,
  assertTestDatabaseTarget,
  ReadOnlyTestDatabaseCredentialsError,
  TestDatabaseGuardError,
} from "../db/testDatabaseGuard";
import { type IntegrationDbClient } from "./integrationDatabaseCheck";
import { type CatalogFingerprint, loadCatalogAuditExpectation, type ReadOnlyRoleSnapshot } from "./testDbCatalogAudit";
import { EXPECTED_DOCKER_CONTEXT, TEST_CONTAINER } from "./testDbDocker";
import type { TestDatabaseServerIdentity, TestDbDockerIdentity } from "./testDbIdentity";
import {
  assertReadOnlyRoleExecArgs,
  assertReadOnlyRoleFingerprintChange,
  buildReadOnlyRoleExecArgs,
  buildReadOnlyRoleExecEnv,
  canonicalAcl,
  classifyReadOnlyRoleBase,
  classifyReadOnlyRoleFull,
  createScramVerifier,
  deriveScramKeys,
  encodeTableList,
  EXEC_ENV,
  EXEC_ENV_KEYS,
  EXPECTED_INITIAL_TABLE_COUNT,
  EXPECTED_PRE_CHANGE_SCHEMAS,
  EXPECTED_PRE_CHANGE_SYSTEM_DATABASES,
  EXPECTED_PRE_CHANGE_TEST_DATABASE,
  EXPECTED_ROLE_CONFIG_MD5,
  expectedReadOnlyRoleTables,
  initialCreationPreconditionViolations,
  loadReadOnlyRoleSql,
  type PreChangeAclObservation,
  preChangeAclViolations,
  PRE_CHANGE_DATABASES_SQL,
  PRE_CHANGE_SCHEMAS_SQL,
  PSQL_ARGS,
  READ_ONLY_ROLE_SQL_FILES,
  READ_ONLY_ROLE_SQL_SHA256,
  ReadOnlyRoleError,
  type ReadOnlyRoleObservation,
  RO_DOCKER_CONTEXT,
  RO_ROLE_CREATE_DISABLED,
  RO_ROLE_GRANT_SYNC_DISABLED,
  RO_TEST_CONTAINER,
  runPreChangeAclCheck,
  runReadOnlyRoleCheck,
  SCRAM_VERIFIER_PATTERN,
  sha256Hex,
  tablesWithoutAcl,
} from "./testDbReadOnlyRole";
import { SERVER_IDENTITY_SQL } from "./testDbState";

// DB にも Docker にも接続しない。SQL ファイルは読むだけ（実行しない）。DB の応答は偽のクライアントで作る
const REPO_ROOT = path.resolve(__dirname, "../..");
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");
const CREATE_SQL = read(READ_ONLY_ROLE_SQL_FILES.create);
const SYNC_SQL = read(READ_ONLY_ROLE_SQL_FILES["grant-sync"]);
const EXPECTATION = loadCatalogAuditExpectation(REPO_ROOT);
const TABLES = expectedReadOnlyRoleTables(EXPECTATION);

const APP_PASSWORD = "ro-test-app-dummy-password";
const ADMIN_PASSWORD = "ro-test-admin-dummy-password";
const RO_PASSWORD = "ro_test_dummy_password_0123456789abcdef";
const APP_URL = `postgresql://katana_test_user:${APP_PASSWORD}@127.0.0.1:5434/katana_test`;
const RO_URL = `postgresql://katana_test_ro:${RO_PASSWORD}@127.0.0.1:5434/katana_test`;
const RO_ENV = { KATANA_TEST_RO_DATABASE_URL: RO_URL, KATANA_TEST_DB_RO_PASSWORD: RO_PASSWORD };
const APP = { databaseUrl: APP_URL, appPassword: APP_PASSWORD, adminPassword: ADMIN_PASSWORD };

const DOCKER: TestDbDockerIdentity = {
  containerId: "a".repeat(64),
  imageId: `sha256:${"b".repeat(64)}`,
  startedAt: "2026-11-06T22:46:49.619782389Z",
  restartCount: 0,
  networkId: "c".repeat(64),
  networkIp: "172.18.0.2",
  volumes: ["katana-web_postgres_data"],
  developmentVolume: ["katana-web_postgres_data"],
  portPublishers: ["katana-test-db"],
};
const SERVER: TestDatabaseServerIdentity = { serverAddress: "172.18.0.2", serverPort: 5432, postmasterStartTime: "2026-11-06T22:46:51.123456Z" };

/** SQL から、コメント行とドル引用符の本体（DO ブロック）を除いた、psql がそのまま扱う部分 */
function outsideDollarQuotes(sql: string): string {
  return sql
    .replace(/\$\$[\s\S]*?\$\$/g, "$$$$")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}
const dollarBodies = (sql: string) => [...sql.matchAll(/\$\$([\s\S]*?)\$\$/g)].map((m) => m[1]);
const withoutComments = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

describe("固定の SQL ファイル（静的な検査。実行しない）", () => {
  it.each(["create", "grant-sync"] as const)("%s：SHA-256 が定数と一致し、loadReadOnlyRoleSql が中身をそのまま返す", (operation) => {
    const sql = read(READ_ONLY_ROLE_SQL_FILES[operation]);
    expect(sha256Hex(sql)).toBe(READ_ONLY_ROLE_SQL_SHA256[operation]);
    expect(loadReadOnlyRoleSql(REPO_ROOT, operation, (p) => readFileSync(p, "utf8"))).toBe(sql);
  });

  it("中身が1文字でも違えば SQL_FILE_MISMATCH（実行しない）", () => {
    expect(() => loadReadOnlyRoleSql(REPO_ROOT, "create", () => `${CREATE_SQL} `)).toThrow(/SQL_FILE_MISMATCH/);
  });

  it("init/ の外に置く（初期化では実行されない）", () => {
    for (const file of Object.values(READ_ONLY_ROLE_SQL_FILES)) expect(file.startsWith(path.join("docker", "test-db", "init"))).toBe(false);
  });

  it.each([
    ["create", CREATE_SQL],
    ["grant-sync", SYNC_SQL],
  ])("%s：トランザクションの制御・シェルやファイルのメタコマンド・危険な文がない", (_, sql) => {
    const outside = outsideDollarQuotes(sql);
    for (const pattern of [/\bBEGIN\b/i, /\bCOMMIT\b/i, /\bROLLBACK\b/i, /\bSAVEPOINT\b/i, /\bSTART\s+TRANSACTION\b/i, /\bEND\s*;/i]) {
      expect(outside, String(pattern)).not.toMatch(pattern);
    }
    for (const meta of ["\\!", "\\o", "\\w", "\\copy", "\\c ", "\\connect", "\\i", "\\ir", "\\set", "\\gexec", "\\setenv", "\\g ", "\\if", "\\cd", "\\lo_"]) {
      expect(withoutComments(sql), meta).not.toContain(meta);
    }
    const code = withoutComments(sql);
    for (const forbidden of [/DEFAULT\s+PRIVILEGES/i, /OWNER\s+TO/i, /\bDROP\b/i, /\bTRUNCATE\s+(TABLE\s+)?\w/i, /\bDELETE\s+FROM\b/i, /\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bWITH\s+GRANT\s+OPTION\b/i]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    // DO ブロックの中でも、トランザクションの制御はしない
    for (const body of dollarBodies(sql)) expect(body).not.toMatch(/\b(COMMIT|ROLLBACK|SAVEPOINT)\b/i);
  });

  it.each([
    ["create", CREATE_SQL],
    ["grant-sync", SYNC_SQL],
  ])("%s：最初の文はログの停止。psql の変数は DO ブロックの中にない", (_, sql) => {
    const statements = outsideDollarQuotes(sql)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    expect(statements.slice(0, 5)).toEqual([
      "SET log_statement = 'none';",
      "SET log_min_error_statement = 'panic';",
      "SET log_min_duration_statement = -1;",
      "SET log_min_duration_sample = -1;",
      "SET search_path = pg_catalog;",
    ]);
    // psql は引用符・ドル引用符の中では変数を展開しないので、DO ブロックの中に :'名前'・:"名前"・:名前 を書かない
    // （期待値の文字列 'katana_test_ro:SELECT:…' の `:S` などは変数ではないので、引用符付きの形と、変数の名前の形だけを調べる）
    for (const body of dollarBodies(sql)) {
      expect(body).not.toMatch(/:'[A-Za-z_]|:"[A-Za-z_]/);
      expect(body).not.toMatch(/:(ro_verifier|ro_verifier_sha256|expected_postmaster_start|expected_tables|grant_targets)\b/);
    }
  });

  it("\\getenv は操作ごとの EXEC_ENV_KEYS と同じ変数だけ。検証子は create だけが受け取る", () => {
    const getenv = (sql: string) => [...sql.matchAll(/^\\getenv (\w+) (\w+)$/gm)].map((m) => m[2]).sort();
    expect(getenv(CREATE_SQL)).toEqual([...EXEC_ENV_KEYS.create].sort());
    expect(getenv(SYNC_SQL)).toEqual([...EXEC_ENV_KEYS["grant-sync"]].sort());
    expect(SYNC_SQL).not.toContain(EXEC_ENV.verifier);
    expect(SYNC_SQL).not.toContain("ro_verifier");
    expect(SYNC_SQL).not.toMatch(/CREATE ROLE|ALTER ROLE|REVOKE/);
  });

  it("検証子（:'ro_verifier'）は CREATE ROLE の1か所でだけ展開し、独自の設定（SET LOCAL）には入れない", () => {
    const uses = withoutComments(CREATE_SQL).split("\n").filter((l) => l.includes(":'ro_verifier'"));
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatch(/^CREATE ROLE katana_test_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT -1 PASSWORD :'ro_verifier';$/);
    const setLocal = withoutComments(CREATE_SQL).split("\n").filter((l) => l.startsWith("SET LOCAL"));
    expect(setLocal).toEqual([
      "SET LOCAL katana.ro_verifier_sha256 = :'ro_verifier_sha256';",
      "SET LOCAL katana.expected_postmaster_start = :'expected_postmaster_start';",
      "SET LOCAL katana.expected_tables = :'expected_tables';",
      "SET LOCAL katana.grant_targets = :'grant_targets';",
    ]);
  });

  it("変更の文は、create は4文、grant-sync は GRANT の1文だけ", () => {
    const changes = (sql: string) =>
      outsideDollarQuotes(sql)
        .split("\n")
        .filter((l) => /^(CREATE|ALTER|GRANT|REVOKE)\b/.test(l));
    expect(changes(CREATE_SQL)).toEqual([
      expect.stringMatching(/^CREATE ROLE katana_test_ro /),
      "ALTER ROLE katana_test_ro SET default_transaction_read_only = on;",
      "REVOKE TEMPORARY ON DATABASE katana_test FROM PUBLIC;",
      "GRANT SELECT ON ALL TABLES IN SCHEMA public TO katana_test_ro;",
    ]);
    expect(changes(SYNC_SQL)).toEqual(["GRANT SELECT ON ALL TABLES IN SCHEMA public TO katana_test_ro;"]);
  });

  it.each([
    ["create", CREATE_SQL],
    ["grant-sync", SYNC_SQL],
  ])("%s：本人確認とテーブルの照合が、変更の文より前にある。照合の順序は本人確認 → テーブル → 変更 → 事後", (_, sql) => {
    const firstChange = sql.search(/^(CREATE ROLE|GRANT SELECT)/m);
    expect(sql.indexOf("refusing: unexpected database")).toBeGreaterThan(0);
    expect(sql.indexOf("refusing: unexpected database")).toBeLessThan(sql.indexOf("refusing: the public relations do not match"));
    expect(sql.indexOf("refusing: the public relations do not match")).toBeLessThan(firstChange);
    expect(sql.indexOf("refusing: the tables without privileges do not match the grant targets")).toBeLessThan(firstChange);
    // クラスタの DB・スキーマの ACL の照合（Step 3-12B-5E-5A）も、最初の変更の文より前
    for (const refusal of [
      "refusing: the cluster databases are not the expected ones",
      "refusing: the test database owner is not the expected one",
      "refusing: the privileges of the other databases are not the expected ones",
      "refusing: the schemas or their privileges are not the expected ones",
    ]) {
      expect(sql.indexOf(refusal), refusal).toBeGreaterThan(sql.indexOf("refusing: the public relations do not match"));
      expect(sql.indexOf(refusal), refusal).toBeLessThan(firstChange);
    }
    expect(sql.lastIndexOf("the table privileges are not the expected ones")).toBeGreaterThan(firstChange);
    expect(sql.lastIndexOf("the privilege dependencies do not match the expected tables")).toBeGreaterThan(firstChange);
  });

  it("postmaster の起動時刻は、F1（SERVER_IDENTITY_SQL）と同じ式の文字列で比べる", () => {
    const expression = /pg_catalog\.to_char\(pg_catalog\.pg_postmaster_start_time\(\) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\)/;
    expect(SERVER_IDENTITY_SQL).toMatch(expression);
    expect(CREATE_SQL).toMatch(expression);
    expect(SYNC_SQL).toMatch(expression);
  });

  it("本人確認とテーブルの照合のブロックは、2つのファイルで同じ文面", () => {
    const block = (sql: string) => sql.slice(sql.indexOf("-- 本人確認（変更の前）"), sql.search(/^-- (初回作成だけの前提|補完だけの前提)/m));
    expect(block(CREATE_SQL).length).toBeGreaterThan(1000);
    expect(block(SYNC_SQL)).toBe(block(CREATE_SQL));
  });

  it("クラスタの ACL の照合は、2つのファイルで同じ文面の範囲にあり、期待値は TS の EXPECTED_PRE_CHANGE_* と同じ", () => {
    const block = (sql: string) => sql.slice(sql.indexOf("-- 本人確認（変更の前）"), sql.search(/^-- (初回作成だけの前提|補完だけの前提)/m));
    expect(block(CREATE_SQL)).toContain("refusing: the privileges of the other databases are not the expected ones");
    // SQL の行の形：名前|所有者|接続の可否|ACL が未設定か|展開した ACL|PUBLIC の CONNECT|TEMPORARY|CREATE（スキーマは USAGE|CREATE）
    const dbRows = [...EXPECTED_PRE_CHANGE_SYSTEM_DATABASES]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((d) => [d.name, d.owner, d.allowConnections, d.aclNull, d.acl, d.publicConnect, d.publicTemporary, d.publicCreate].join("|"));
    const schemaRows = EXPECTED_PRE_CHANGE_SCHEMAS.map((n) => [n.name, n.owner, n.aclNull, n.acl, n.publicUsage, n.publicCreate].join("|"));
    for (const sql of [CREATE_SQL, SYNC_SQL]) {
      const literal = (start: string) => {
        const from = sql.indexOf(start);
        const end = sql.indexOf(" THEN", from);
        return [...sql.slice(from, end).matchAll(/'([^']*)'/g)].map((m) => m[1]).join("");
      };
      expect(literal("IF found IS DISTINCT FROM\n       'postgres|")).toBe(dbRows.join(";"));
      expect(literal("IF found IS DISTINCT FROM\n       'public|")).toBe(schemaRows.join(";"));
      expect(sql).toContain("IF found IS DISTINCT FROM 'katana_test,postgres,template0,template1' THEN");
      expect(sql).toContain(`IS DISTINCT FROM '${EXPECTED_PRE_CHANGE_TEST_DATABASE.create.owner}|${EXPECTED_PRE_CHANGE_TEST_DATABASE.create.allowConnections}' THEN`);
      // NULL の ACL は既定の ACL に展開して比べる（NULL と明示的な ACL を区別するため、未設定かどうかも行に含める）
      expect(sql).toContain("pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba)))");
      expect(sql).toContain("pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner)))");
    }
    // TS の固定の SELECT も、同じ展開の式と PUBLIC の実効権限を使う
    expect(PRE_CHANGE_DATABASES_SQL).toContain("pg_catalog.aclexplode(COALESCE(d.datacl, pg_catalog.acldefault('d', d.datdba)))");
    expect(PRE_CHANGE_DATABASES_SQL).toContain("pg_catalog.has_database_privilege('public', d.oid, 'TEMPORARY')");
    expect(PRE_CHANGE_SCHEMAS_SQL).toContain("pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner)))");
    expect(PRE_CHANGE_SCHEMAS_SQL).toContain("NOT LIKE 'pg\\_%'");
    for (const sql of [PRE_CHANGE_DATABASES_SQL, PRE_CHANGE_SCHEMAS_SQL]) {
      expect(sql.trimStart().startsWith("SELECT ")).toBe(true);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT|REVOKE|DROP|SET)\b(?!')/);
    }
  });

  it("初回作成は16テーブルちょうどを SQL の中でも求める（EXPECTED_INITIAL_TABLE_COUNT と同じ値）。補完は件数を固定しない", () => {
    expect(EXPECTED_INITIAL_TABLE_COUNT).toBe(16);
    expect(TABLES).toHaveLength(EXPECTED_INITIAL_TABLE_COUNT);
    expect(CREATE_SQL).toContain("'katana.expected_tables'), ','), 1) <> 16");
    expect(SYNC_SQL).not.toMatch(/<> 16\b/);
  });
});

describe("SCRAM-SHA-256 の検証子", () => {
  // RFC 7677 のテストベクタ（ユーザー user・パスワード pencil）。ClientProof と ServerSignature が一致すれば、鍵の導出が正しい
  it("RFC 7677 の ClientProof・ServerSignature を再現できる", () => {
    const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
    const { clientKey, storedKey, serverKey } = deriveScramKeys("pencil", salt, 4096);
    const authMessage =
      "n=user,r=rOprNGfwEbeRWgbNEkqO," +
      "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096," +
      "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
    const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
    const proof = Buffer.from(clientKey.map((b, i) => b ^ clientSignature[i]));
    expect(proof.toString("base64")).toBe("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=");
    expect(createHmac("sha256", serverKey).update(authMessage).digest("base64")).toBe("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
    expect(storedKey.equals(createHash("sha256").update(clientKey).digest())).toBe(true);
  });

  it("PostgreSQL の形式で、パスワードを含まない。salt が違えば値も違う", () => {
    const a = createScramVerifier(RO_PASSWORD, Buffer.alloc(16, 1));
    const b = createScramVerifier(RO_PASSWORD, Buffer.alloc(16, 2));
    expect(a).toMatch(SCRAM_VERIFIER_PATTERN);
    expect(a.startsWith(`SCRAM-SHA-256$4096:${Buffer.alloc(16, 1).toString("base64")}$`)).toBe(true);
    expect(a).not.toContain(RO_PASSWORD);
    expect(a).not.toBe(b);
    expect(createScramVerifier(RO_PASSWORD)).toMatch(SCRAM_VERIFIER_PATTERN);
  });

  it("使えない文字・短い salt は拒否する", () => {
    expect(() => createScramVerifier("pa ss")).toThrow(ReadOnlyRoleError);
    expect(() => createScramVerifier(RO_PASSWORD, Buffer.alloc(8))).toThrow(ReadOnlyRoleError);
  });
});

describe("テーブルの一覧（expected_tables・grant_targets で共通の形）", () => {
  it("識別子の形・重複なし・コードポイントの順で、`,` でつなぐ", () => {
    expect(encodeTableList(["b", "A", "_x", "a"])).toBe("A,_x,a,b");
    expect(encodeTableList(TABLES)).toBe([...TABLES].sort().join(","));
    expect(TABLES).toContain("_prisma_migrations");
  });

  it.each([[[]], [["a,b"]], [["a b"]], [["a", "a"]], [['a"']], [["1a"]]])("%j は拒否する", (names) => {
    expect(() => encodeTableList(names)).toThrow(ReadOnlyRoleError);
  });
});

describe("固定の docker exec", () => {
  it("context・コンテナ名は testDbDocker.ts と同じ値", () => {
    expect(RO_DOCKER_CONTEXT).toBe(EXPECTED_DOCKER_CONTEXT);
    expect(RO_TEST_CONTAINER).toBe(TEST_CONTAINER);
  });

  it("create：context を明示し、-e は名前だけ、Container ID、固定の psql の引数（--single-transaction と -f -）", () => {
    expect(buildReadOnlyRoleExecArgs("create", DOCKER.containerId)).toEqual([
      "--context",
      "desktop-linux",
      "exec",
      "-i",
      "--user",
      "postgres",
      "-e",
      "KATANA_TEST_RO_SCRAM_VERIFIER",
      "-e",
      "KATANA_TEST_RO_VERIFIER_SHA256",
      "-e",
      "KATANA_TEST_EXPECTED_POSTMASTER_START",
      "-e",
      "KATANA_TEST_EXPECTED_TABLES",
      "-e",
      "KATANA_TEST_GRANT_TARGETS",
      DOCKER.containerId,
      "psql",
      "-X",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=terse",
      "-v",
      "SHOW_CONTEXT=never",
      "--single-transaction",
      "-U",
      "postgres",
      "-d",
      "katana_test",
      "-f",
      "-",
    ]);
    expect(PSQL_ARGS).not.toContain("-h");
    expect(PSQL_ARGS).not.toContain("-a");
    expect(PSQL_ARGS).not.toContain("-e");
    expect(Object.isFrozen(PSQL_ARGS)).toBe(true);
  });

  it("grant-sync は検証子の変数を渡さない", () => {
    const args = buildReadOnlyRoleExecArgs("grant-sync", DOCKER.containerId);
    expect(args).not.toContain(EXEC_ENV.verifier);
    expect(args).not.toContain(EXEC_ENV.verifierSha256);
    expect(args.filter((a) => a === "-e")).toHaveLength(3);
  });

  it("D1・D2 と同じ Container ID の固定の引数だけを通す", () => {
    const args = buildReadOnlyRoleExecArgs("create", DOCKER.containerId);
    expect(() => assertReadOnlyRoleExecArgs(args, "create", DOCKER, DOCKER)).not.toThrow();
    const other = { ...DOCKER, containerId: "d".repeat(64) };
    expect(() => assertReadOnlyRoleExecArgs(args, "create", DOCKER, other)).toThrow(/EXEC_ARGS_REJECTED/);
    expect(() => assertReadOnlyRoleExecArgs(buildReadOnlyRoleExecArgs("create", other.containerId), "create", DOCKER, DOCKER)).toThrow(/EXEC_ARGS_REJECTED/);
    expect(() => assertReadOnlyRoleExecArgs(args, "grant-sync", DOCKER, DOCKER)).toThrow(/EXEC_ARGS_REJECTED/);
  });

  it.each([
    ["引数の追加", (a: string[]) => [...a, "-c", "SELECT 1"]],
    ["-t の追加", (a: string[]) => [...a.slice(0, 4), "-t", ...a.slice(4)]],
    ["値付きの -e", (a: string[]) => a.map((x) => (x === "KATANA_TEST_GRANT_TARGETS" ? "KATANA_TEST_GRANT_TARGETS=x" : x))],
    ["コンテナ名", (a: string[]) => a.map((x) => (x === DOCKER.containerId ? "katana-test-db" : x))],
    ["ON_ERROR_STOP の変更", (a: string[]) => a.map((x) => (x === "ON_ERROR_STOP=1" ? "ON_ERROR_STOP=0" : x))],
    ["-f の変更", (a: string[]) => [...a.slice(0, -1), "/tmp/x.sql"]],
    ["--single-transaction の削除", (a: string[]) => a.filter((x) => x !== "--single-transaction")],
    ["context の削除", (a: string[]) => a.slice(2)],
  ])("%s は拒否する", (_, mutate) => {
    const args = mutate([...buildReadOnlyRoleExecArgs("create", DOCKER.containerId)]);
    expect(() => assertReadOnlyRoleExecArgs(args, "create", DOCKER, DOCKER)).toThrow(/EXEC_ARGS_REJECTED/);
  });

  it("Container ID は64桁の16進だけ", () => {
    for (const id of ["a".repeat(12), "katana-test-db", `${"a".repeat(63)}G`, ""]) expect(() => buildReadOnlyRoleExecArgs("create", id)).toThrow(/EXEC_ARGS_REJECTED/);
  });
});

describe("docker exec の環境変数", () => {
  const tables = encodeTableList(TABLES);
  const verifier = createScramVerifier(RO_PASSWORD, Buffer.alloc(16, 7));
  const createValues = { postmasterStart: SERVER.postmasterStartTime, expectedTables: tables, grantTargets: tables, verifier, verifierSha256: sha256Hex(verifier) };
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    DATABASE_URL: APP_URL,
    PGPASSWORD: "x",
    DOCKER_HOST: "tcp://x",
    KATANA_TEST_DB_PASSWORD: APP_PASSWORD,
    KATANA_TEST_DB_RO_PASSWORD: RO_PASSWORD,
    KATANA_TEST_RO_DATABASE_URL: RO_URL,
    NODE_OPTIONS: "--x",
  };

  it("create：許可リストの親の変数と、5つの変数だけ。パスワード・接続URL・DOCKER_* は含まない", () => {
    const env = buildReadOnlyRoleExecEnv(parent, "create", createValues);
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH", ...EXEC_ENV_KEYS.create].sort());
    const text = JSON.stringify(env);
    for (const secret of [APP_PASSWORD, RO_PASSWORD, APP_URL, RO_URL, "tcp://x"]) expect(text).not.toContain(secret);
    expect(env[EXEC_ENV.postmasterStart]).toBe("2026-11-06T22:46:51.123456Z");
  });

  it("grant-sync：3つの変数だけ。検証子を渡すと拒否する", () => {
    const env = buildReadOnlyRoleExecEnv(parent, "grant-sync", { postmasterStart: SERVER.postmasterStartTime, expectedTables: tables, grantTargets: "_prisma_migrations" });
    expect(Object.keys(env).filter((k) => k.startsWith("KATANA_")).sort()).toEqual([...EXEC_ENV_KEYS["grant-sync"]].sort());
    expect(() => buildReadOnlyRoleExecEnv(parent, "grant-sync", { ...createValues, grantTargets: "_prisma_migrations" })).toThrow(/VALUE_INVALID/);
  });

  it.each([
    ["起動時刻がミリ秒", { postmasterStart: "2026-11-06T22:46:51.123Z" }],
    ["起動時刻が7桁", { postmasterStart: "2026-11-06T22:46:51.1234567Z" }],
    ["起動時刻が +00:00", { postmasterStart: "2026-11-06T22:46:51.123456+00:00" }],
    ["並びの違う一覧", { expectedTables: [...TABLES].reverse().join(",") }],
    ["初回作成で対象が一部", { grantTargets: "_prisma_migrations" }],
    ["期待しないテーブルが対象", { grantTargets: `${tables},Zzz` }],
    ["検証子の形式", { verifier: "plain-password", verifierSha256: sha256Hex("plain-password") }],
    ["検証子のハッシュの不一致", { verifierSha256: "0".repeat(64) }],
    ["検証子なし", { verifier: undefined }],
  ])("%s は拒否する", (_, override) => {
    expect(() => buildReadOnlyRoleExecEnv(parent, "create", { ...createValues, ...override })).toThrow(ReadOnlyRoleError);
  });
});

// ---- R-base・R-full ----

function goodSnapshot(tables = TABLES): ReadOnlyRoleSnapshot {
  return {
    role: {
      currentUser: "katana_test_ro",
      sessionUser: "katana_test_ro",
      superuser: false,
      inherit: false,
      createRole: false,
      createDb: false,
      replication: false,
      bypassRls: false,
      defaultReadOnly: "on",
    },
    memberships: [],
    ownership: ["relation", "type", "schema", "routine", "database", "large object", "default privileges"].map((kind) => ({ kind, count: 0 })),
    database: { databaseCreate: false, databaseTemporary: false, schemaCreate: false, schemaUsage: true },
    tables: tables.map((table) => ({ table, select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false })),
    sequences: [],
    catalogColumns: tables.map((table) => ({ table, column: "id" })),
    visibleColumns: tables.map((table) => ({ table, column: "id" })),
  };
}

function goodObservation(granted = TABLES): ReadOnlyRoleObservation {
  const snapshot = goodSnapshot();
  const grantedSet = new Set(granted);
  return {
    snapshot: {
      ...snapshot,
      tables: snapshot.tables.map((t) => ({ ...t, select: grantedSet.has(t.table) })),
      visibleColumns: snapshot.visibleColumns.filter((c) => grantedSet.has(c.table)),
    },
    dependencies: granted.map((objectName) => ({ database: "katana_test", catalog: "pg_class", subId: 0, type: "a", objectName })),
    databases: [
      { name: "katana_test", allowConnections: true, connect: true, temporary: false, create: false, explicitGrants: 0 },
      { name: "postgres", allowConnections: true, connect: false, temporary: false, create: false, explicitGrants: 0 },
      { name: "template0", allowConnections: false, connect: true, temporary: false, create: false, explicitGrants: 0 },
      { name: "template1", allowConnections: true, connect: true, temporary: false, create: false, explicitGrants: 0 },
    ],
    tableAcl: TABLES.map((table) => ({ table, aclNull: !grantedSet.has(table) })),
  };
}

describe("R-full（期待するテーブルすべてに SELECT）", () => {
  it("すべて正しければ passed（template1 の CONNECT は許容する残存リスク）", () => {
    expect(classifyReadOnlyRoleFull(goodObservation(), TABLES)).toEqual({ passed: true, findings: [] });
  });

  it.each<[string, (o: ReadOnlyRoleObservation) => void, RegExp]>([
    ["SELECT のないテーブル", (o) => (o.snapshot.tables[0].select = false), /no table-level SELECT/],
    ["INSERT", (o) => (o.snapshot.tables[0].insert = true), /INSERT/],
    ["所属", (o) => o.snapshot.memberships.push("katana_test_user"), /member of role/],
    ["large object の所有（katana_test）", (o) => (o.snapshot.ownership[5].count = 1), /owns large object/],
    ["所有の依存（template1 の large object・既定の権限）", (o) => o.dependencies.push({ database: "template1", catalog: "other", subId: 0, type: "o", objectName: null }), /dependency o in template1/],
    ["ほかの DB の ACL の依存", (o) => o.dependencies.push({ database: "template1", catalog: "other", subId: 0, type: "a", objectName: null }), /dependency a in template1/],
    ["共有オブジェクトの依存", (o) => o.dependencies.push({ database: "", catalog: "other", subId: 0, type: "a", objectName: null }), /\(shared\)/],
    ["列単位の付与の依存", (o) => o.dependencies.push({ database: "katana_test", catalog: "pg_class", subId: 2, type: "a", objectName: TABLES[0] }), /column/],
    ["ポリシーの依存", (o) => o.dependencies.push({ database: "katana_test", catalog: "other", subId: 0, type: "r", objectName: null }), /dependency r/],
    ["依存の欠け", (o) => o.dependencies.pop(), /privilege dependencies do not match/],
    ["template1 への明示的な付与", (o) => (o.databases[3].explicitGrants = 1), /template1: explicit privileges/],
    ["template1 の TEMPORARY", (o) => (o.databases[3].temporary = true), /template1: TEMPORARY/],
    ["postgres の CONNECT", (o) => (o.databases[1].connect = true), /postgres: CONNECT/],
    ["template0 が接続を受け付ける", (o) => (o.databases[2].allowConnections = true), /template0 accepts connections/],
    ["想定外の DB", (o) => o.databases.push({ name: "other", allowConnections: true, connect: true, temporary: false, create: false, explicitGrants: 0 }), /unexpected databases/],
    ["katana_test の TEMPORARY", (o) => (o.databases[0].temporary = true), /katana_test: TEMPORARY/],
    ["default_transaction_read_only が off", (o) => (o.snapshot.role.defaultReadOnly = "off"), /default_transaction_read_only/],
  ])("%s は失敗", (_, mutate, pattern) => {
    const o = goodObservation();
    mutate(o);
    const verdict = classifyReadOnlyRoleFull(o, TABLES);
    expect(verdict.passed).toBe(false);
    expect(verdict.findings.join("\n")).toMatch(pattern);
  });
});

describe("R-base（補完の前。SELECT の不足だけを補完の対象にする）", () => {
  const added = TABLES.filter((t) => t !== "_prisma_migrations").slice(0, 2);
  const granted = TABLES.filter((t) => !added.includes(t));

  it("ACL が未設定で SELECT のない、期待するテーブルだけが補完の対象。同じ観測で R-full は失敗する", () => {
    const o = goodObservation(granted);
    const base = classifyReadOnlyRoleBase(o, TABLES);
    expect(base).toEqual({ passed: true, findings: [], candidates: [...added].sort() });
    expect(classifyReadOnlyRoleFull(o, TABLES).passed).toBe(false);
  });

  it("不足がなければ対象は0件で passed", () => {
    expect(classifyReadOnlyRoleBase(goodObservation(), TABLES)).toEqual({ passed: true, findings: [], candidates: [] });
  });

  it.each<[string, (o: ReadOnlyRoleObservation) => void, RegExp]>([
    ["ACL が設定されているのに SELECT がない", (o) => (o.tableAcl.find((t) => t.table === added[0])!.aclNull = false), /privileges are set but there is no SELECT/],
    ["補完の対象に書き込みの権限", (o) => (o.snapshot.tables.find((t) => t.table === added[0])!.insert = true), /INSERT/],
    ["付与済みのテーブルに書き込みの権限", (o) => (o.snapshot.tables.find((t) => t.table === granted[0])!.update = true), /UPDATE/],
    ["所属", (o) => o.snapshot.memberships.push("pg_read_all_data"), /member of role/],
    ["所有の依存", (o) => o.dependencies.push({ database: "katana_test", catalog: "other", subId: 0, type: "o", objectName: null }), /dependency o/],
    ["補完の対象への依存（ACL があるのに SELECT がない）", (o) => o.dependencies.push({ database: "katana_test", catalog: "pg_class", subId: 0, type: "a", objectName: added[0] }), /privilege dependencies/],
    ["期待しないテーブル", (o) => {
      o.snapshot.tables.push({ table: "Extra", select: false, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false });
      o.tableAcl.push({ table: "Extra", aclNull: true });
    }, /UNEXPECTED_OBJECT: table Extra/],
    ["ACL の状態の一覧の食い違い", (o) => o.tableAcl.pop(), /table privilege states do not match/],
  ])("%s は失敗（補完しない）", (_, mutate, pattern) => {
    const o = goodObservation(granted);
    mutate(o);
    const base = classifyReadOnlyRoleBase(o, TABLES);
    expect(base.passed).toBe(false);
    expect(base.findings.join("\n")).toMatch(pattern);
  });
});

describe("runReadOnlyRoleCheck（偽のクライアント）", () => {
  type Answer = (sql: string) => Record<string, unknown>[];
  function client(answer: Answer, log: string[]): IntegrationDbClient {
    return {
      query: async (sql) => {
        log.push(sql.split("\n")[0].trim());
        return { rows: answer(sql) };
      },
      end: async () => {
        log.push("end");
      },
    };
  }
  const identity = (user: string): Answer => (sql) => {
    if (sql.startsWith("BEGIN READ ONLY") || sql === "ROLLBACK") return [];
    if (sql.includes("set_config('search_path'")) return [{ searchPath: "pg_catalog" }];
    if (sql === "SHOW transaction_read_only") return [{ transaction_read_only: "on" }];
    if (sql.includes("current_database() AS database")) return [{ database: "katana_test", currentUser: user, sessionUser: user, marker: "katana-test-db", serverPort: 5432 }];
    if (sql.includes("inet_server_addr")) return [{ serverAddress: SERVER.serverAddress, serverPort: SERVER.serverPort, postmasterStartTime: SERVER.postmasterStartTime }];
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };

  it("katana_test_ro 以外のユーザーなら、権限を読まずに IDENTITY_CHECK_FAILED。ROLLBACK と接続の解放は行う", async () => {
    const log: string[] = [];
    await expect(
      runReadOnlyRoleCheck({ databaseUrl: RO_URL, developmentDatabaseUrl: undefined, connect: async () => client(identity("katana_test_user"), log), expectedServer: { docker: DOCKER, server: SERVER } }),
    ).rejects.toThrow(/IDENTITY_CHECK_FAILED/);
    expect(log).toContain("ROLLBACK");
    expect(log.at(-1)).toBe("end");
    expect(log.some((l) => l.includes("pg_shdepend") || l.includes("rolsuper"))).toBe(false);
  });

  it("別のサーバーなら、権限を読まずに SERVER_IDENTITY_MISMATCH", async () => {
    const log: string[] = [];
    await expect(
      runReadOnlyRoleCheck({
        databaseUrl: RO_URL,
        developmentDatabaseUrl: undefined,
        connect: async () => client(identity("katana_test_ro"), log),
        expectedServer: { docker: DOCKER, server: { ...SERVER, postmasterStartTime: "2026-11-06T22:46:51.123457Z" } },
      }),
    ).rejects.toThrow(/SERVER_IDENTITY_MISMATCH/);
    expect(log.some((l) => l.includes("rolsuper"))).toBe(false);
  });

  it("katana_test_user の URL は、接続する前に TARGET_REJECTED", async () => {
    let connected = false;
    await expect(
      runReadOnlyRoleCheck({ databaseUrl: APP_URL, developmentDatabaseUrl: undefined, connect: async () => ((connected = true), client(identity("x"), [])), expectedServer: { docker: DOCKER, server: SERVER } }),
    ).rejects.toThrow(/TARGET_REJECTED/);
    expect(connected).toBe(false);
  });
});

// ---- A0（変更の前の ACL） ----

// PostgreSQL 15 の initdb・初期化スクリプトの結果を、期待値の定数とは別に書いた観測（create の前）
function observedAcl(): PreChangeAclObservation {
  const pg = "postgres:CONNECT:postgres,postgres:CREATE:postgres,postgres:TEMPORARY:postgres";
  const u = "katana_test_user";
  return {
    databases: [
      { name: "katana_test", owner: u, allowConnections: true, aclNull: true, acl: `PUBLIC:CONNECT:${u},PUBLIC:TEMPORARY:${u},${u}:CONNECT:${u},${u}:CREATE:${u},${u}:TEMPORARY:${u}`, publicConnect: true, publicTemporary: true, publicCreate: false },
      { name: "postgres", owner: "postgres", allowConnections: true, aclNull: false, acl: pg, publicConnect: false, publicTemporary: false, publicCreate: false },
      { name: "template0", owner: "postgres", allowConnections: false, aclNull: false, acl: `PUBLIC:CONNECT:postgres,${pg}`, publicConnect: true, publicTemporary: false, publicCreate: false },
      { name: "template1", owner: "postgres", allowConnections: true, aclNull: false, acl: `PUBLIC:CONNECT:postgres,${pg}`, publicConnect: true, publicTemporary: false, publicCreate: false },
    ],
    schemas: [
      { name: "public", owner: "pg_database_owner", aclNull: false, acl: "PUBLIC:USAGE:pg_database_owner,pg_database_owner:CREATE:pg_database_owner,pg_database_owner:USAGE:pg_database_owner", publicUsage: true, publicCreate: false },
    ],
  };
}

describe("A0：変更の前の ACL の判定（preChangeAclViolations）", () => {
  it("create の前の期待値（initdb と初期化スクリプトの結果）と一致すれば違反なし", () => {
    expect(preChangeAclViolations(observedAcl(), "create")).toEqual([]);
  });

  it("grant-sync の前は、katana_test の PUBLIC の TEMPORARY を取り上げた形だけが一致する", () => {
    const o = observedAcl();
    expect(preChangeAclViolations(o, "grant-sync")).toEqual(["database katana_test: aclNull differs", "database katana_test: acl differs", "database katana_test: publicTemporary differs"]);
    const u = "katana_test_user";
    Object.assign(o.databases[0], { aclNull: false, acl: `PUBLIC:CONNECT:${u},${u}:CONNECT:${u},${u}:CREATE:${u},${u}:TEMPORARY:${u}`, publicTemporary: false });
    expect(preChangeAclViolations(o, "grant-sync")).toEqual([]);
    expect(preChangeAclViolations(o, "create")).not.toEqual([]);
  });

  const at = (o: PreChangeAclObservation, name: string) => o.databases.find((d) => d.name === name) ?? o.databases[0];
  it.each<[string, (o: PreChangeAclObservation) => void, string]>([
    ["template1 の ACL が未設定（既定の ACL では PUBLIC に TEMPORARY）", (o) => Object.assign(at(o, "template1"), { aclNull: true, acl: "PUBLIC:CONNECT:postgres,PUBLIC:TEMPORARY:postgres,postgres:CONNECT:postgres,postgres:CREATE:postgres,postgres:TEMPORARY:postgres", publicTemporary: true }), "database template1: aclNull differs"],
    ["template1 の PUBLIC の TEMPORARY（ACL の文字列が同じでも実効権限で検出）", (o) => Object.assign(at(o, "template1"), { publicTemporary: true }), "database template1: publicTemporary differs"],
    ["template1 の PUBLIC の CREATE", (o) => Object.assign(at(o, "template1"), { acl: `PUBLIC:CONNECT:postgres,PUBLIC:CREATE:postgres,${"postgres:CONNECT:postgres,postgres:CREATE:postgres,postgres:TEMPORARY:postgres"}` }), "database template1: acl differs"],
    ["template1 への明示的な付与", (o) => Object.assign(at(o, "template1"), { acl: `${at(o, "template1").acl},katana_test_user:CONNECT:postgres` }), "database template1: acl differs"],
    ["postgres の ACL が未設定（PUBLIC に CONNECT・TEMPORARY）", (o) => Object.assign(at(o, "postgres"), { aclNull: true }), "database postgres: aclNull differs"],
    ["postgres の PUBLIC の CONNECT", (o) => Object.assign(at(o, "postgres"), { publicConnect: true }), "database postgres: publicConnect differs"],
    ["postgres の PUBLIC の TEMPORARY", (o) => Object.assign(at(o, "postgres"), { publicTemporary: true }), "database postgres: publicTemporary differs"],
    ["template0 が接続を受け付ける", (o) => Object.assign(at(o, "template0"), { allowConnections: true }), "database template0: allowConnections differs"],
    ["katana_test の ACL が明示的（初期値でない）", (o) => Object.assign(at(o, "katana_test"), { aclNull: false }), "database katana_test: aclNull differs"],
    ["katana_test の所有者", (o) => Object.assign(at(o, "katana_test"), { owner: "postgres" }), "database katana_test: owner differs"],
    ["DB の所有者（template1）", (o) => Object.assign(at(o, "template1"), { owner: "katana_test_user" }), "database template1: owner differs"],
    ["付与の権限（GRANTABLE）", (o) => Object.assign(at(o, "template1"), { acl: at(o, "template1").acl.replace("PUBLIC:CONNECT:postgres", "PUBLIC:CONNECT:postgres:GRANTABLE") }), "database template1: acl differs"],
    ["想定外の DB", (o) => o.databases.push({ ...at(o, "template1"), name: "extra" }), "the databases are not the expected ones"],
    ["DB が足りない", (o) => o.databases.splice(1, 1), "the databases are not the expected ones"],
    ["public の ACL が未設定", (o) => Object.assign(o.schemas[0], { aclNull: true }), "schema public: aclNull differs"],
    ["public の PUBLIC の CREATE", (o) => Object.assign(o.schemas[0], { publicCreate: true }), "schema public: publicCreate differs"],
    ["public の所有者", (o) => Object.assign(o.schemas[0], { owner: "katana_test_user" }), "schema public: owner differs"],
    ["public の ACL への追加", (o) => Object.assign(o.schemas[0], { acl: `${o.schemas[0].acl},katana_test_ro:USAGE:pg_database_owner` }), "schema public: acl differs"],
    ["public 以外のスキーマ", (o) => o.schemas.push({ ...o.schemas[0], name: "extra" }), "the schemas are not the expected ones"],
    ["public がない", (o) => o.schemas.splice(0, 1), "the schemas are not the expected ones"],
  ])("%s は違反", (_, change, expected) => {
    const o = observedAcl();
    change(o);
    expect(preChangeAclViolations(o, "create")).toContain(expected);
  });
});

describe("runPreChangeAclCheck（偽のクライアント）", () => {
  type Answer = (sql: string) => Record<string, unknown>[];
  function client(answer: Answer, log: string[]): IntegrationDbClient {
    return {
      query: async (sql) => {
        log.push(sql.split("\n")[0].trim());
        return { rows: answer(sql) };
      },
      end: async () => {
        log.push("end");
      },
    };
  }
  const answers = (user: string, acl: PreChangeAclObservation = observedAcl()): Answer => (sql) => {
    if (sql.startsWith("BEGIN READ ONLY") || sql === "ROLLBACK") return [];
    if (sql.includes("set_config('search_path'")) return [{ searchPath: "pg_catalog" }];
    if (sql === "SHOW transaction_read_only") return [{ transaction_read_only: "on" }];
    if (sql.includes("current_database() AS database")) return [{ database: "katana_test", currentUser: user, sessionUser: user, marker: "katana-test-db", serverPort: 5432 }];
    if (sql.includes("inet_server_addr")) return [{ serverAddress: SERVER.serverAddress, serverPort: SERVER.serverPort, postmasterStartTime: SERVER.postmasterStartTime }];
    if (sql === PRE_CHANGE_DATABASES_SQL) return acl.databases.map((d) => ({ ...d }));
    if (sql === PRE_CHANGE_SCHEMAS_SQL) return acl.schemas.map((n) => ({ ...n }));
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };
  const input = (connect: () => Promise<IntegrationDbClient>, over: Partial<{ databaseUrl: string; server: typeof SERVER }> = {}) => ({
    databaseUrl: over.databaseUrl ?? APP_URL,
    developmentDatabaseUrl: undefined,
    connect,
    expectedServer: { docker: DOCKER, server: over.server ?? SERVER },
  });

  it("katana_test_user で、読み取り専用のトランザクションの中で固定の SELECT 2つだけを読み、ROLLBACK して接続を解放する", async () => {
    const log: string[] = [];
    const result = await runPreChangeAclCheck(input(async () => client(answers("katana_test_user"), log)));
    expect(result).toEqual(observedAcl());
    expect(preChangeAclViolations(result, "create")).toEqual([]);
    expect(log[0]).toMatch(/^BEGIN READ ONLY/);
    expect(log).toContain("ROLLBACK");
    expect(log.at(-1)).toBe("end");
    expect(log.filter((l) => /^(INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT|REVOKE|DROP|COMMIT)\b/.test(l))).toEqual([]);
  });

  it("katana_test_user 以外なら、ACL を読まずに IDENTITY_CHECK_FAILED", async () => {
    const log: string[] = [];
    await expect(runPreChangeAclCheck(input(async () => client(answers("katana_test_ro"), log)))).rejects.toThrow(/IDENTITY_CHECK_FAILED/);
    expect(log.some((l) => l.includes("datname::text AS name") || l.includes("nspname::text AS name"))).toBe(false);
    expect(log.at(-1)).toBe("end");
  });

  it("別のサーバーなら、ACL を読まずに SERVER_IDENTITY_MISMATCH", async () => {
    const log: string[] = [];
    await expect(
      runPreChangeAclCheck(input(async () => client(answers("katana_test_user"), log), { server: { ...SERVER, postmasterStartTime: "2026-11-06T22:46:51.123457Z" } })),
    ).rejects.toThrow(/SERVER_IDENTITY_MISMATCH/);
    expect(log.some((l) => l.includes("datname::text AS name"))).toBe(false);
  });

  it("katana_test_ro の URL は、接続する前に TARGET_REJECTED", async () => {
    let connected = false;
    await expect(runPreChangeAclCheck(input(async () => ((connected = true), client(answers("x"), [])), { databaseUrl: RO_URL }))).rejects.toThrow(/TARGET_REJECTED/);
    expect(connected).toBe(false);
  });

  it("結果の形が違えば INVALID_RESULT（判定しない）", async () => {
    const broken = observedAcl();
    (broken.databases[0] as unknown as Record<string, unknown>).publicTemporary = "t";
    await expect(runPreChangeAclCheck(input(async () => client(answers("katana_test_user", broken), [])))).rejects.toThrow(/INVALID_RESULT/);
  });

  it("照会の失敗は CHECK_QUERY_FAILED（メッセージに接続URL・パスワードを含めない）", async () => {
    const failing: Answer = (sql) => {
      if (sql === PRE_CHANGE_SCHEMAS_SQL) throw Object.assign(new Error(`boom ${APP_URL}`), { code: "42501" });
      return answers("katana_test_user")(sql);
    };
    const error = await runPreChangeAclCheck(input(async () => client(failing, []))).catch((e: unknown) => e as Error);
    expect(String(error)).toMatch(/CHECK_QUERY_FAILED/);
    expect(String(error)).not.toContain(APP_PASSWORD);
  });
});

// ---- fingerprint の期待差分 ----

const row = (fields: Record<string, unknown>) => JSON.stringify(Object.keys(fields).sort().map((k) => [k, fields[k]]));
const key = (...parts: string[]) => JSON.stringify(parts);
const relation = (name: string, acl: string | null) => [key("public", name), row({ schema: "public", name, kind: "r", persistence: "p", rowSecurity: false, forceRowSecurity: false, owner: "katana_test_user", acl })] as const;
const TABLE_ACL = "{katana_test_user=arwdDxt/katana_test_user,katana_test_ro=r/katana_test_user}";
const DB_ACL = "{=c/katana_test_user,katana_test_user=CTc/katana_test_user}";

function fp(o: { granted?: readonly string[]; created?: boolean; extra?: Record<string, (readonly [string, string])[]>; sha?: string } = {}): CatalogFingerprint {
  const granted = new Set(o.granted ?? []);
  const sections: Record<string, (readonly [string, string])[]> = {
    database: [[key("katana_test"), row({ name: "katana_test", owner: "katana_test_user", acl: o.created ? DB_ACL : null, comment: "katana-test-db" })]],
    relations: TABLES.map((t) => relation(t, granted.has(t) ? TABLE_ACL : null)),
    roles: [
      [key("katana_test_user"), row({ name: "katana_test_user", superuser: false, inherit: true, createRole: false, createDb: false, login: true, replication: false, bypassRls: false, connectionLimit: -1, config: null })],
      ...(o.created
        ? [[key("katana_test_ro"), row({ name: "katana_test_ro", superuser: false, inherit: false, createRole: false, createDb: false, login: true, replication: false, bypassRls: false, connectionLimit: -1, config: EXPECTED_ROLE_CONFIG_MD5 })] as const]
        : []),
    ],
    dbRoleSettings: o.created ? [[key("all", "", "one", "katana_test_ro"), row({ databaseScope: "all", database: "", roleScope: "one", role: "katana_test_ro", configHash: EXPECTED_ROLE_CONFIG_MD5 })]] : [],
    schemas: [[key("public"), row({ name: "public", owner: "pg_database_owner", acl: "{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}" })]],
    defaultPrivileges: [],
    roleMemberships: [],
    largeObjects: [],
    ...o.extra,
  };
  for (const [name, entries] of Object.entries(sections)) sections[name] = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { meaning: "observed-catalog-definition", sha256: o.sha ?? sha256Hex(JSON.stringify(sections)), sections };
}

describe("fingerprint の期待差分", () => {
  const BEFORE = fp();
  const AFTER = fp({ created: true, granted: TABLES });

  it("ACL の文字列は、並びと権限の文字の順に依存しない形にする", () => {
    expect(canonicalAcl("{b=rw/x,=c/x}")).toEqual(["=c/x", "b=rw/x"]);
    expect(canonicalAcl("{b=wr/x}")).toEqual(canonicalAcl("{b=rw/x}"));
    expect(canonicalAcl(null)).toBeNull();
    expect(() => canonicalAcl('{"a b"=r/x}')).toThrow(ReadOnlyRoleError);
  });

  it("create：想定した区分・キー・項目だけが変われば通る", () => {
    expect(initialCreationPreconditionViolations(BEFORE, TABLES)).toEqual([]);
    expect(() => assertReadOnlyRoleFingerprintChange(BEFORE, AFTER, { operation: "create", grantedTables: TABLES })).not.toThrow();
  });

  it.each<[string, () => CatalogFingerprint]>([
    ["public schema の ACL", () => fp({ created: true, granted: TABLES, extra: { schemas: [[key("public"), row({ name: "public", owner: "pg_database_owner", acl: "{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner,katana_test_ro=U/pg_database_owner}" })]] } })],
    ["既定の権限の設定", () => fp({ created: true, granted: TABLES, extra: { defaultPrivileges: [[key("katana_test_ro", "", "r"), row({ role: "katana_test_ro", schema: "", objectType: "r", acl: "{}" })]] } })],
    ["所属", () => fp({ created: true, granted: TABLES, extra: { roleMemberships: [[key("pg_read_all_data", "katana_test_ro"), row({ role: "pg_read_all_data", member: "katana_test_ro", admin: false })]] } })],
    ["large object", () => fp({ created: true, granted: TABLES, extra: { largeObjects: [[key("katana_test_ro"), row({ owner: "katana_test_ro", count: 1 })]] } })],
    ["付与が一部のテーブルだけ", () => fp({ created: true, granted: TABLES.slice(1) })],
    ["DB の ACL が変わらない", () => ({ ...AFTER, sections: { ...AFTER.sections, database: BEFORE.sections.database } })],
  ])("create：%s の差分は失敗", (_, after) => {
    expect(() => assertReadOnlyRoleFingerprintChange(BEFORE, after(), { operation: "create", grantedTables: TABLES })).toThrow(/FINGERPRINT_UNEXPECTED_CHANGE/);
  });

  it("create：ロールの属性・設定・ACL の値が違えば失敗", () => {
    const variants: CatalogFingerprint[] = [
      { ...AFTER, sections: { ...AFTER.sections, roles: AFTER.sections.roles.map(([k, v]) => [k, k === key("katana_test_ro") ? v.replace('["inherit",false]', '["inherit",true]') : v] as const) } },
      { ...AFTER, sections: { ...AFTER.sections, dbRoleSettings: AFTER.sections.dbRoleSettings.map(([k, v]) => [k, v.replace(EXPECTED_ROLE_CONFIG_MD5, "0".repeat(32))] as const) } },
      { ...AFTER, sections: { ...AFTER.sections, relations: AFTER.sections.relations.map(([k, v], i) => [k, i === 0 ? v.replace("katana_test_ro=r/", "katana_test_ro=r*/") : v] as const) } },
      { ...AFTER, sections: { ...AFTER.sections, database: AFTER.sections.database.map(([k, v]) => [k, v.replace("=c/katana_test_user", "=Tc/katana_test_user")] as const) } },
      { ...AFTER, sections: { ...AFTER.sections, relations: AFTER.sections.relations.map(([k, v], i) => [k, i === 0 ? v.replace('"owner","katana_test_user"', '"owner","katana_test_ro"') : v] as const) } },
    ];
    for (const after of variants) expect(() => assertReadOnlyRoleFingerprintChange(BEFORE, after, { operation: "create", grantedTables: TABLES })).toThrow(/FINGERPRINT_UNEXPECTED_CHANGE/);
  });

  it("FP0 の前提：ロール・設定・ACL・既定の権限があれば、初回作成を始めない", () => {
    expect(initialCreationPreconditionViolations(AFTER, TABLES).join("\n")).toMatch(/already exists[\s\S]*role settings[\s\S]*database ACL[\s\S]*already has privileges/);
    expect(initialCreationPreconditionViolations(fp({ extra: { defaultPrivileges: [[key("x", "", "r"), row({ role: "x", schema: "", objectType: "r", acl: "{}" })]] } }), TABLES)).toEqual(["default privilege settings exist"]);
  });

  it("grant-sync：補完したテーブルの ACL だけが変われば通る。ほかの差分は失敗", () => {
    const added = TABLES.slice(0, 2);
    const before = fp({ created: true, granted: TABLES.slice(2) });
    expect(tablesWithoutAcl(before, TABLES)).toEqual([...added].sort());
    const after = fp({ created: true, granted: TABLES });
    expect(() => assertReadOnlyRoleFingerprintChange(before, after, { operation: "grant-sync", grantedTables: added })).not.toThrow();
    expect(() => assertReadOnlyRoleFingerprintChange(before, after, { operation: "grant-sync", grantedTables: added.slice(1) })).toThrow(/FINGERPRINT_UNEXPECTED_CHANGE/);
    const extra = fp({ created: true, granted: TABLES, extra: { largeObjects: [[key("katana_test_ro"), row({ owner: "katana_test_ro", count: 1 })]] } });
    expect(() => assertReadOnlyRoleFingerprintChange(before, extra, { operation: "grant-sync", grantedTables: added })).toThrow(/FINGERPRINT_UNEXPECTED_CHANGE/);
    expect(() => assertReadOnlyRoleFingerprintChange(before, before, { operation: "grant-sync", grantedTables: [] })).toThrow(/FINGERPRINT_UNEXPECTED_CHANGE/);
  });

  it("失敗のメッセージに、ハッシュ・行の値を含めない", () => {
    try {
      assertReadOnlyRoleFingerprintChange(BEFORE, fp({ created: true, granted: TABLES.slice(1) }), { operation: "create", grantedTables: TABLES });
    } catch (error) {
      expect((error as Error).message).not.toContain(EXPECTED_ROLE_CONFIG_MD5);
      expect((error as Error).message).not.toContain("arwdDxt");
      return;
    }
    throw new Error("expected a failure");
  });
});

describe("固定のゲートと、読み取り専用ロールの接続先・認証情報のガード", () => {
  it("2つのゲートは、別の凍結された無効値", () => {
    expect(RO_ROLE_CREATE_DISABLED).toEqual({ mode: "disabled" });
    expect(RO_ROLE_GRANT_SYNC_DISABLED).toEqual({ mode: "disabled" });
    expect(Object.isFrozen(RO_ROLE_CREATE_DISABLED)).toBe(true);
    expect(Object.isFrozen(RO_ROLE_GRANT_SYNC_DISABLED)).toBe(true);
    expect(RO_ROLE_CREATE_DISABLED).not.toBe(RO_ROLE_GRANT_SYNC_DISABLED);
  });

  it("assertReadOnlyTestDatabaseTarget は katana_test_ro だけを通し、assertTestDatabaseTarget は今までどおり katana_test_user だけ", () => {
    expect(assertReadOnlyTestDatabaseTarget({ databaseUrl: RO_URL, env: {}, developmentDatabaseUrl: undefined })).toEqual({ host: "127.0.0.1", port: "5434", database: "katana_test", user: "katana_test_ro" });
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return (error as TestDatabaseGuardError).code;
      }
      return "ok";
    };
    expect(code(() => assertReadOnlyTestDatabaseTarget({ databaseUrl: APP_URL, env: {}, developmentDatabaseUrl: undefined }))).toBe("USER_NOT_ALLOWED");
    expect(code(() => assertTestDatabaseTarget({ databaseUrl: RO_URL, env: {}, developmentDatabaseUrl: undefined }))).toBe("USER_NOT_ALLOWED");
    expect(code(() => assertTestDatabaseTarget({ databaseUrl: APP_URL, env: {}, developmentDatabaseUrl: undefined }))).toBe("ok");
    expect(code(() => assertReadOnlyTestDatabaseTarget({ databaseUrl: `${RO_URL}?host=x`, env: {}, developmentDatabaseUrl: undefined }))).toBe("QUERY_NOT_ALLOWED");
    expect(code(() => assertReadOnlyTestDatabaseTarget({ databaseUrl: RO_URL.replace("5434", "5433"), env: {}, developmentDatabaseUrl: undefined }))).toBe("PORT_NOT_ALLOWED");
    expect(code(() => assertReadOnlyTestDatabaseTarget({ databaseUrl: RO_URL, env: { PGHOST: "x" }, developmentDatabaseUrl: undefined }))).toBe("PG_ENV_PRESENT");
  });

  it("認証情報：正しい値なら URL とパスワードを返す", () => {
    expect(assertReadOnlyTestDatabaseCredentials(RO_ENV, APP)).toEqual({ databaseUrl: RO_URL, password: RO_PASSWORD });
  });

  it.each<[string, Record<string, string | undefined>, typeof APP, string]>([
    ["余分なキー", { ...RO_ENV, DATABASE_URL: APP_URL }, APP, "RO_ENV_UNEXPECTED_KEY"],
    ["URL なし", { KATANA_TEST_DB_RO_PASSWORD: RO_PASSWORD }, APP, "RO_URL_INVALID"],
    ["パスワードなし", { KATANA_TEST_RO_DATABASE_URL: RO_URL }, APP, "RO_PASSWORD_MISSING"],
    ["見本の値", { KATANA_TEST_RO_DATABASE_URL: RO_URL.replace(RO_PASSWORD, "CHANGE_ME_ro_password_0123456789abcdef"), KATANA_TEST_DB_RO_PASSWORD: "CHANGE_ME_ro_password_0123456789abcdef" }, APP, "RO_PASSWORD_PLACEHOLDER"],
    ["使えない文字", { KATANA_TEST_RO_DATABASE_URL: RO_URL.replace(RO_PASSWORD, "a%21".padEnd(40, "a")), KATANA_TEST_DB_RO_PASSWORD: "a%21".padEnd(40, "a") }, APP, "RO_PASSWORD_CHARSET"],
    ["短い", { KATANA_TEST_RO_DATABASE_URL: RO_URL.replace(RO_PASSWORD, "short_password_1"), KATANA_TEST_DB_RO_PASSWORD: "short_password_1" }, APP, "RO_PASSWORD_TOO_SHORT"],
    ["URL との不一致", { ...RO_ENV, KATANA_TEST_DB_RO_PASSWORD: `${RO_PASSWORD}x` }, APP, "RO_URL_PASSWORD_MISMATCH"],
    ["アプリ用と同じ", RO_ENV, { ...APP, appPassword: RO_PASSWORD }, "RO_PASSWORD_REUSED"],
    ["管理用と同じ", RO_ENV, { ...APP, adminPassword: RO_PASSWORD }, "RO_PASSWORD_REUSED"],
    ["アプリ用の URL と同じ", RO_ENV, { ...APP, databaseUrl: RO_URL }, "RO_URL_SAME_AS_APP"],
  ])("%s は拒否する（メッセージにパスワード・URL を含めない）", (_, env, app, expected) => {
    try {
      assertReadOnlyTestDatabaseCredentials(env, app);
    } catch (error) {
      expect(error).toBeInstanceOf(ReadOnlyTestDatabaseCredentialsError);
      expect((error as ReadOnlyTestDatabaseCredentialsError).code).toBe(expected);
      for (const secret of [RO_PASSWORD, RO_URL, APP_PASSWORD, APP_URL]) expect((error as Error).message).not.toContain(secret);
      return;
    }
    throw new Error(`expected ${expected}`);
  });
});
