import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, type Mock, vi } from "vitest";
import { IntegrationDatabaseCheckError } from "./integrationDatabaseCheck";
import {
  assertSchemaDiffCommand,
  buildSchemaDiffCommand,
  buildSchemaDiffSpawnOptions,
  classifySchemaDiffResult,
  FORBIDDEN_SCHEMA_DIFF_ARGS,
  prepareSchemaDiff,
  readOnlyPrivilegeViolations,
  redactSecrets,
  runSchemaDiffCheck,
  SCHEMA_DIFF_DISABLED,
  SCHEMA_DIFF_TIMEOUT_MS,
  type SchemaDiffDeps,
  SchemaDiffError,
  type SchemaDiffErrorCode,
  type SchemaDiffProcessResult,
  schemaDiffSucceeded,
} from "./schemaDiff";
import type { TestDatabaseServerIdentity, TestDbDockerIdentity } from "./testDbIdentity";
import { type InspectDatabase, LIVE_DATABASE_DISABLED, type ReadDockerIdentity } from "./testDbMigrate";
import type { TestDatabasePrivileges, TestDatabaseState } from "./testDbState";

// Prisma CLI を起動せず、DBにも Docker にも接続しない。子プロセス・DBの判定・Docker の読み取りは、すべて偽の関数で置き換える
const ROOT = "/fake/katana-web";
const EXEC_PATH = "/fake/bin/node";
const PASSWORD = "diff-dummy-pass";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "dev-dummy-pass";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
const ADMIN_PASSWORD = "diff-dummy-admin";
const SECRETS = [PASSWORD, ADMIN_PASSWORD, DEV_PASSWORD, TEST_URL, DEV_URL, "postgresql://katana", "postgres://"];
/** 伏せる値として渡すもの（prepareSchemaDiff の secrets と同じ種類。汎用の接頭辞は含めない） */
const REDACT = [TEST_URL, PASSWORD, ADMIN_PASSWORD, DEV_URL, DEV_PASSWORD];
const GOOD_TEST_ENV = { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD };
const REPO_ROOT = path.resolve(__dirname, "../..");

const EXPECTED_ARGS = [
  `${ROOT}/node_modules/prisma/build/index.js`,
  "migrate",
  "diff",
  "--from-config-datasource",
  "--to-schema",
  `${ROOT}/prisma/schema.prisma`,
  "--exit-code",
  "--config",
  `${ROOT}/prisma.config.ts`,
];

const STATE_C: TestDatabaseState = { state: "C", tables: ["Shop"], migrations: ["m1"], schemaDiff: "not-verified" };
const STATE_A: TestDatabaseState = { state: "A" };
const STATE_B: TestDatabaseState = { state: "B", reasons: ["unexpected objects"] };
/** 仮の読み取り専用のロール（CREATE・所有者なし）。今の katana_test_user ではない */
const READ_ONLY: TestDatabasePrivileges = { publicUsage: true, publicCreate: false, databaseOwner: false, databaseCreate: false };
/** 今の katana_test_user（migration 用にすべてある） */
const CURRENT_USER: TestDatabasePrivileges = { publicUsage: true, publicCreate: true, databaseOwner: true, databaseCreate: true };
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
const exit = (code: number | null, stdout = "", stderr = "", signal: string | null = null): SchemaDiffProcessResult => ({ kind: "exit", code, signal, stdout, stderr });

type Fake = { deps: SchemaDiffDeps; spawn: Mock<SchemaDiffDeps["spawnCapture"]>; inspectDb: Mock<InspectDatabase>; docker: Mock<ReadDockerIdentity>; logs: string[]; calls: string[] };

function fake(
  o: {
    enabled?: boolean;
    files?: Record<string, Record<string, string> | undefined>;
    parentEnv?: Record<string, string | undefined>;
    execArgv?: string[];
    missingPaths?: string[];
    states?: (TestDatabaseState | Error)[];
    privileges?: TestDatabasePrivileges;
    servers?: TestDatabaseServerIdentity[];
    dockers?: (TestDbDockerIdentity | Error)[];
    result?: SchemaDiffProcessResult | Error;
    buildCommand?: SchemaDiffDeps["buildCommand"];
  } = {},
): Fake {
  const calls: string[] = [];
  const logs: string[] = [];
  const files = { ".env.test": GOOD_TEST_ENV, ".env": { DATABASE_URL: DEV_URL }, ...o.files };
  const states = [...(o.states ?? [STATE_C, STATE_C])];
  const servers = [...(o.servers ?? [SERVER])];
  const dockers = [...(o.dockers ?? [DOCKER])];
  const inspectDb = vi.fn<InspectDatabase>(async () => {
    calls.push("inspect");
    const next = states.shift();
    if (next === undefined) throw new Error("unexpected inspect call");
    if (next instanceof Error) throw next;
    const server = servers.length > 1 ? (servers.shift() as TestDatabaseServerIdentity) : servers[0];
    return { state: next, privileges: o.privileges ?? READ_ONLY, server };
  });
  const docker = vi.fn<ReadDockerIdentity>(async () => {
    calls.push("docker");
    const next = dockers.length > 1 ? dockers.shift() : dockers[0];
    if (next instanceof Error) throw next;
    return next as TestDbDockerIdentity;
  });
  const spawn = vi.fn<SchemaDiffDeps["spawnCapture"]>(async () => {
    calls.push("spawn");
    const r = o.result ?? exit(0);
    if (r instanceof Error) throw r;
    return r;
  });
  const deps: SchemaDiffDeps = {
    root: ROOT,
    execArgv: o.execArgv ?? [],
    execPath: EXEC_PATH,
    parentEnv: o.parentEnv ?? { PATH: "/usr/bin", HOME: "/home/u" },
    readEnvFile: (p) => files[path.relative(ROOT, p) as keyof typeof files],
    pathExists: (p) => !(o.missingPaths ?? []).includes(path.relative(ROOT, p)),
    access: o.enabled === false ? SCHEMA_DIFF_DISABLED : { mode: "enabled" },
    readDockerIdentity: docker,
    inspectDatabase: inspectDb,
    spawnCapture: spawn,
    buildCommand: o.buildCommand,
    log: (t) => logs.push(t),
  };
  return { deps, spawn, inspectDb, docker, logs, calls };
}

async function expectError(f: Fake, code: SchemaDiffErrorCode): Promise<Error> {
  const caught = await runSchemaDiffCheck(f.deps).catch((e: unknown) => e);
  expect(caught).toBeInstanceOf(SchemaDiffError);
  expect((caught as SchemaDiffError).code).toBe(code);
  for (const s of SECRETS) {
    expect((caught as Error).message).not.toContain(s);
    for (const line of f.logs) expect(line).not.toContain(s);
  }
  return caught as Error;
}

async function expectStopsBeforeLive(f: Fake, code: SchemaDiffErrorCode) {
  await expectError(f, code);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.inspectDb).not.toHaveBeenCalled();
  expect(f.docker).not.toHaveBeenCalled();
}

describe("固定のコマンド", () => {
  it("1. 正しい固定コマンドを組み立てる（Prisma CLI のエントリ・migrate diff・--from-config-datasource・--to-schema・--exit-code・--config）", () => {
    const command = buildSchemaDiffCommand({ root: ROOT, execPath: EXEC_PATH });
    expect(command.command).toBe(EXEC_PATH);
    expect(command.args).toEqual(EXPECTED_ARGS);
    for (const flag of ["--script", "--output", "-o", "--from-migrations", "--to-migrations"]) expect(command.args).not.toContain(flag);
  });

  it("2. shell: false・標準入力なし・タイムアウト付きの起動オプション", () => {
    const options = buildSchemaDiffSpawnOptions(ROOT, { PATH: "/usr/bin", DATABASE_URL: TEST_URL });
    expect(options.shell).toBe(false);
    expect(options.cwd).toBe(ROOT);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(options.timeoutMs).toBe(SCHEMA_DIFF_TIMEOUT_MS);
    expect(Object.isFrozen(options)).toBe(true);
  });

  it("3. 引数を追加する経路がない（組み立ての関数は root・execPath だけを受け取り、結果は凍結されている）", () => {
    const command = buildSchemaDiffCommand({ root: ROOT, execPath: EXEC_PATH, extra: ["--script"] } as never);
    expect(command.args).toEqual(EXPECTED_ARGS);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.args)).toBe(true);
    expect(() => (command.args as string[]).push("--script")).toThrow();
  });

  it("3. 固定のコマンドに引数を足した・差し替えたものは拒否する", () => {
    const expected = buildSchemaDiffCommand({ root: ROOT, execPath: EXEC_PATH });
    for (const args of [[...EXPECTED_ARGS, "--script"], [...EXPECTED_ARGS, "--output", "/tmp/x"], EXPECTED_ARGS.slice(0, -1), [...EXPECTED_ARGS].reverse()]) {
      expect(() => assertSchemaDiffCommand({ command: EXEC_PATH, args }, expected)).toThrow(SchemaDiffError);
    }
    expect(() => assertSchemaDiffCommand({ command: "/bin/sh", args: EXPECTED_ARGS }, expected)).toThrow(SchemaDiffError);
    expect(() => assertSchemaDiffCommand(expected, expected)).not.toThrow();
  });

  it("4. 変更系のコマンド（migrate deploy・migrate dev・migrate reset・migrate resolve・db push・db execute）は拒否する", () => {
    const expected = buildSchemaDiffCommand({ root: ROOT, execPath: EXEC_PATH });
    const entry = EXPECTED_ARGS[0];
    for (const sub of [["migrate", "deploy"], ["migrate", "dev"], ["migrate", "reset", "--force"], ["migrate", "resolve"], ["db", "push"], ["db", "execute", "--stdin"]]) {
      const command = { command: EXEC_PATH, args: [entry, ...sub, "--config", EXPECTED_ARGS.at(-1) as string] };
      expect(() => assertSchemaDiffCommand(command, expected)).toThrow(/COMMAND_REJECTED/);
      // 期待値そのものが改ざんされていても、禁止の引数で止まる
      expect(() => assertSchemaDiffCommand(command, command)).toThrow(/COMMAND_REJECTED/);
    }
    for (const word of ["deploy", "dev", "push", "reset", "resolve", "--script", "--output", "--from-migrations", "--to-migrations"]) {
      expect(FORBIDDEN_SCHEMA_DIFF_ARGS.has(word)).toBe(true);
    }
  });

  it("4. 組み立ての関数が改ざんされても、Prisma CLI を起動しない", async () => {
    const f = fake({
      buildCommand: ({ execPath }) => ({ command: execPath, args: [EXPECTED_ARGS[0], "migrate", "deploy"] }),
    });
    await expectStopsBeforeLive(f, "COMMAND_REJECTED");
  });
});

describe("終了コードの分類", () => {
  it("5. 0 は差分なし（成功）", () => {
    const outcome = classifySchemaDiffResult(exit(0, "No difference detected."), REDACT);
    expect(outcome).toEqual({ outcome: "no-diff" });
    expect(schemaDiffSucceeded(outcome)).toBe(true);
  });

  it("6. 1 は CLI のエラー（差分ありとは別）", () => {
    const outcome = classifySchemaDiffResult(exit(1, "", "Error: P1001"), REDACT);
    expect(outcome.outcome).toBe("cli-error");
    expect(schemaDiffSucceeded(outcome)).toBe(false);
  });

  it("7. 2 は差分あり（エラーとは別。要約を返す）", () => {
    const outcome = classifySchemaDiffResult(exit(2, "[*] Changed the `Shop` table"), REDACT);
    expect(outcome).toEqual({ outcome: "diff", summary: "[*] Changed the `Shop` table" });
    expect(schemaDiffSucceeded(outcome)).toBe(false);
  });

  it("8. 未知の終了コード（3・101・-1・null・小数）は想定外として拒否する", () => {
    for (const code of [3, 101, -1, 255, null, 1.5]) {
      const outcome = classifySchemaDiffResult(exit(code), REDACT);
      expect(outcome.outcome).toBe("unexpected-exit");
      expect(schemaDiffSucceeded(outcome)).toBe(false);
    }
  });

  it("9. 起動の失敗は spawn-failed（コードだけ。パス・メッセージは含めない）", () => {
    expect(classifySchemaDiffResult({ kind: "spawn-error", errorCode: "ENOENT" }, REDACT)).toEqual({ outcome: "spawn-failed", errorCode: "ENOENT" });
    expect(classifySchemaDiffResult({ kind: "spawn-error", errorCode: `bad ${TEST_URL}` }, REDACT)).toEqual({ outcome: "spawn-failed", errorCode: "unknown" });
  });

  it("10. タイムアウト・シグナルでの終了は、どちらも成功ではない（終了コード 0 と一緒でもシグナルを優先する）", () => {
    expect(classifySchemaDiffResult({ kind: "timeout", stdout: "", stderr: "" }, REDACT).outcome).toBe("timeout");
    expect(classifySchemaDiffResult(exit(null, "", "", "SIGKILL"), REDACT)).toEqual({ outcome: "signal", signal: "SIGKILL" });
    expect(classifySchemaDiffResult(exit(0, "", "", "SIGTERM"), REDACT).outcome).toBe("signal");
    expect(classifySchemaDiffResult(exit(null, "", "", "weird"), REDACT)).toEqual({ outcome: "signal", signal: "unknown" });
  });

  it("12. CLI の出力の接続URL・パスワードを伏せる（知らない接続URLも伏せる。長い出力は切り詰める）", () => {
    const noisy = `Error: P1000 Authentication failed for ${TEST_URL} password=${PASSWORD} admin=${ADMIN_PASSWORD} dev=${DEV_URL} other=postgres://x:y@h/db`;
    for (const outcome of [classifySchemaDiffResult(exit(1, noisy, noisy), REDACT), classifySchemaDiffResult(exit(2, noisy), REDACT), classifySchemaDiffResult({ kind: "timeout", stdout: noisy, stderr: "" }, REDACT), classifySchemaDiffResult(exit(7, noisy), REDACT)]) {
      const text = JSON.stringify(outcome);
      for (const s of [...SECRETS, "x:y@h"]) expect(text).not.toContain(s);
    }
    expect(redactSecrets("a".repeat(20_000), []).length).toBeLessThan(9_000);
  });
});

describe("接続先の保護（11. 接続先が不正なら、Docker・DB・Prisma CLI に触れない）", () => {
  it("開発用DBと同じ接続先は拒否する", async () => {
    await expectStopsBeforeLive(fake({ files: { ".env": { DATABASE_URL: TEST_URL } } }), "TARGET_REJECTED");
  });

  it("テストDB以外の接続先・クエリ文字列付きのURL（options=… を含む）は拒否する", async () => {
    for (const url of [DEV_URL, `${TEST_URL}?options=-c%20default_transaction_read_only%3Don`, `postgresql://katana_test_user:${PASSWORD}@db.example.com:5434/katana_test`]) {
      await expectStopsBeforeLive(fake({ files: { ".env.test": { ...GOOD_TEST_ENV, DATABASE_URL: url } } }), "TARGET_REJECTED");
    }
  });

  it(".env.test がない・パスワードが不正なら止まる", async () => {
    await expectStopsBeforeLive(fake({ files: { ".env.test": undefined } }), "TEST_ENV_MISSING");
    await expectStopsBeforeLive(fake({ files: { ".env.test": { ...GOOD_TEST_ENV, KATANA_TEST_DB_PASSWORD: "other" } } }), "CREDENTIALS_REJECTED");
  });

  it("親の PG*・DOTENV_*・NODE_OPTIONS・Node の起動オプションは拒否する", async () => {
    await expectStopsBeforeLive(fake({ parentEnv: { PATH: "/usr/bin", PGHOST: "elsewhere" } }), "UNSAFE_PARENT_ENV");
    await expectStopsBeforeLive(fake({ parentEnv: { PATH: "/usr/bin", DOTENV_CONFIG_PATH: ".env" } }), "UNSAFE_PARENT_ENV");
    await expectStopsBeforeLive(fake({ parentEnv: { NODE_OPTIONS: "--require x" } }), "NODE_OPTIONS_PRESENT");
    await expectStopsBeforeLive(fake({ execArgv: ["--import", "x"] }), "NODE_EXEC_ARGV_PRESENT");
  });

  it("必要なファイルがなければ止まる", async () => {
    await expectStopsBeforeLive(fake({ missingPaths: ["prisma/schema.prisma"] }), "REQUIRED_FILE_MISSING");
  });

  it("子プロセスの環境変数は、検証済みの DATABASE_URL・KATANA_DB_TARGET=test と許可リストだけ（親の DATABASE_URL・PRISMA_*・PG* は渡さない）", () => {
    const prepared = prepareSchemaDiff({
      testEnv: GOOD_TEST_ENV,
      developmentEnv: { DATABASE_URL: DEV_URL },
      parentEnv: { PATH: "/usr/bin", DATABASE_URL: DEV_URL, PRISMA_SCHEMA_ENGINE_BINARY: "/evil", KATANA_DB_TARGET: "x", SECRET_TOKEN: "t" },
    });
    expect(prepared.childEnv).toEqual({ PATH: "/usr/bin", DATABASE_URL: TEST_URL, KATANA_DB_TARGET: "test" });
    expect(prepared.secrets).toEqual(expect.arrayContaining([TEST_URL, PASSWORD, ADMIN_PASSWORD, DEV_URL, DEV_PASSWORD]));
  });

  it("固定のゲートが無効なら、検証の後で、Docker・DB・Prisma CLI に触れずに止まる", async () => {
    const f = fake({ enabled: false });
    await expectStopsBeforeLive(f, "SCHEMA_DIFF_LIVE_DISABLED");
    expect(SCHEMA_DIFF_DISABLED).toEqual({ mode: "disabled" });
    expect(Object.isFrozen(SCHEMA_DIFF_DISABLED)).toBe(true);
    expect(SCHEMA_DIFF_DISABLED).not.toBe(LIVE_DATABASE_DISABLED);
  });
});

describe("実行の手順（偽の関数だけ。D1 → F1 → 権限 → D2 → CLI → F2 → D3）", () => {
  it("すべて通れば、この順で呼び、終了コード 0 を差分なしとする", async () => {
    const f = fake();
    expect(await runSchemaDiffCheck(f.deps)).toEqual({ outcome: "no-diff" });
    expect(f.calls).toEqual(["docker", "inspect", "docker", "spawn", "inspect", "docker"]);
    const [command, args, options] = f.spawn.mock.calls[0];
    expect(command).toBe(EXEC_PATH);
    expect(args).toEqual(EXPECTED_ARGS);
    expect(options.shell).toBe(false);
    expect(options.env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", DATABASE_URL: TEST_URL, KATANA_DB_TARGET: "test" });
    for (const line of f.logs) for (const s of SECRETS) expect(line).not.toContain(s);
  });

  it("差分あり（2）・CLI のエラー（1）を区別して返す", async () => {
    expect((await runSchemaDiffCheck(fake({ result: exit(2, "[+] Added tables") }).deps)).outcome).toBe("diff");
    expect((await runSchemaDiffCheck(fake({ result: exit(1) }).deps)).outcome).toBe("cli-error");
  });

  it("9. spawn が例外を投げても、成功とは扱わない（コードだけ）", async () => {
    const outcome = await runSchemaDiffCheck(fake({ result: Object.assign(new Error(`spawn ${TEST_URL}`), { code: "ENOENT" }) }).deps);
    expect(outcome).toEqual({ outcome: "spawn-failed", errorCode: "ENOENT" });
  });

  it("10. タイムアウト・シグナルでの終了は、成功ではない", async () => {
    expect((await runSchemaDiffCheck(fake({ result: { kind: "timeout", stdout: "", stderr: "" } }).deps)).outcome).toBe("timeout");
    expect((await runSchemaDiffCheck(fake({ result: exit(null, "", "", "SIGTERM") }).deps)).outcome).toBe("signal");
  });

  it("今の katana_test_user の権限（CREATE・所有者）では、読み取り専用が強制されていないので、Prisma CLI を起動しない", async () => {
    const f = fake({ privileges: CURRENT_USER });
    const error = await expectError(f, "READ_ONLY_NOT_ENFORCED");
    expect(error.message).toContain("public CREATE");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(readOnlyPrivilegeViolations(CURRENT_USER)).toEqual(["public CREATE", "database CREATE", "database owner"]);
    expect(readOnlyPrivilegeViolations(READ_ONLY)).toEqual([]);
  });

  it("状態 C 以外（A・B）・F1 の失敗・D1 の失敗では、Prisma CLI を起動しない", async () => {
    for (const state of [STATE_A, STATE_B]) {
      const f = fake({ states: [state] });
      await expectError(f, "DATABASE_STATE_NOT_C");
      expect(f.spawn).not.toHaveBeenCalled();
    }
    const f1 = fake({ states: [new IntegrationDatabaseCheckError("CURRENT_USER_MISMATCH", `bad ${TEST_URL}`)] });
    expect((await expectError(f1, "STATE_CHECK_FAILED")).message).toContain("CURRENT_USER_MISMATCH");
    expect(f1.spawn).not.toHaveBeenCalled();
    const d1 = fake({ dockers: [Object.assign(new Error(TEST_URL), { code: "DOCKER_UNAVAILABLE" })] });
    await expectError(d1, "DOCKER_IDENTITY_FAILED");
    expect(d1.spawn).not.toHaveBeenCalled();
  });

  it("F1 と D1 が合わない・D2 が D1 と違うなら、Prisma CLI を起動しない（防止）", async () => {
    const port = fake({ servers: [{ ...SERVER, serverPort: 5433 }] });
    await expectError(port, "SERVER_IDENTITY_MISMATCH");
    expect(port.spawn).not.toHaveBeenCalled();
    const d2 = fake({ dockers: [DOCKER, { ...DOCKER, containerId: "d".repeat(64) }] });
    await expectError(d2, "DOCKER_IDENTITY_MISMATCH");
    expect(d2.spawn).not.toHaveBeenCalled();
  });

  it("F2・D3 の不一致・失敗、CLI の後の状態の変化は、差分なし（0）でも成功と扱わない（事後の検出）", async () => {
    await expectError(fake({ servers: [SERVER, { ...SERVER, postmasterStartTime: "2026-11-06T23:00:00.000000Z" }] }), "POST_DIFF_IDENTITY_MISMATCH");
    await expectError(fake({ dockers: [DOCKER, DOCKER, { ...DOCKER, restartCount: 1 }] }), "POST_DIFF_IDENTITY_MISMATCH");
    await expectError(fake({ dockers: [DOCKER, DOCKER, new Error("x")] }), "DOCKER_IDENTITY_FAILED");
    await expectError(fake({ states: [STATE_C, new Error("lost")] }), "POST_DIFF_CHECK_FAILED");
    await expectError(fake({ states: [STATE_C, STATE_B] }), "POST_DIFF_STATE_MISMATCH");
  });
});

describe("静的な確認（ソース）", () => {
  const code = (file: string) =>
    readFileSync(path.join(REPO_ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\s\/\/ .*$/gm, "");

  it("DB ドライバ・Prisma Client・child_process を読み込まず、ファイルに書き込まない", () => {
    const source = code("lib/testing/schemaDiff.ts");
    for (const forbidden of ['from "pg"', "@prisma/client", "@/lib/prisma", "testDbConnection", "child_process", "testDbDocker", "writeFile", "appendFile", "rmSync", "unlink", "mkdir"]) {
      expect(source).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/shell:\s*true/);
  });

  it("13. migration 用の固定ゲートは変えない（スクリプトは LIVE_DATABASE_DISABLED のまま、schemaDiff はゲートを参照しない）", () => {
    expect(code("scripts/testdb-migrate.mts")).toMatch(/^ {2}liveDatabase: LIVE_DATABASE_DISABLED,$/m);
    expect(code("lib/testing/schemaDiff.ts")).not.toContain("LIVE_DATABASE_DISABLED");
    expect(LIVE_DATABASE_DISABLED).toEqual({ mode: "disabled" });
  });

  it("14. どのスクリプト・runner からも呼ばない（実DBでの実行経路は Step 3-12B-5C で承認の後に組み込む）", () => {
    for (const file of ["scripts/testdb-migrate.mts", "scripts/testdb.mts", "scripts/test-integration.mts", "lib/testing/testDbMigrate.ts", "lib/testing/integrationGlobalSetup.ts", "prisma.config.ts"]) {
      // testDbMigrate.ts・testDbState.ts には、状態 C の schemaDiff: "not-verified" という既存のフィールド名がある。import だけを調べる
      expect(readFileSync(path.join(REPO_ROOT, file), "utf8")).not.toMatch(/["'][^"']*\/schemaDiff(\.ts)?["']/);
    }
    const pkg = readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
    expect(pkg).not.toMatch(/schemaDiff/i);
    expect(pkg).not.toMatch(/migrate diff/);
  });
});
