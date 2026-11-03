import path from "node:path";
import { describe, expect, it, type Mock, vi } from "vitest";
import {
  buildTestDbMigrateEnv,
  parseTestDbMigrateArgs,
  runTestDbMigrate,
  type TestDbMigrateDeps,
  TestDbMigrateError,
  type TestDbMigrateErrorCode,
} from "./testDbMigrate";

// Prisma CLI を起動せず、DBにも接続しない。ファイル・子プロセス・本人確認は、すべて偽の関数で置き換える
const ROOT = "/fake/katana-web";
const EXEC_PATH = "/fake/bin/node";
const PASSWORD = "migrate-dummy-pass";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "dev-dummy-pass";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
const SECRETS = [PASSWORD, DEV_PASSWORD, TEST_URL, DEV_URL, "postgresql://", "postgres://"];

type Fake = {
  deps: TestDbMigrateDeps;
  spawn: Mock<TestDbMigrateDeps["spawn"]>;
  verifyDatabaseIdentity: Mock<TestDbMigrateDeps["verifyDatabaseIdentity"]>;
  logs: string[];
  /** 呼ばれた順の記録 */
  calls: string[];
};

function fake(
  overrides: {
    argv?: string[];
    execArgv?: string[];
    parentEnv?: Record<string, string | undefined>;
    files?: Record<string, Record<string, string> | undefined>;
    missingPaths?: string[];
  } = {},
): Fake {
  const calls: string[] = [];
  const logs: string[] = [];
  const files: Record<string, Record<string, string> | undefined> = {
    ".env.test": { DATABASE_URL: TEST_URL },
    ".env": { DATABASE_URL: DEV_URL },
    ...overrides.files,
  };
  const readEnvFile = (absolutePath: string) => {
    const name = path.relative(ROOT, absolutePath);
    calls.push(`read:${name}`);
    return files[name];
  };
  const verifyDatabaseIdentity = vi.fn<TestDbMigrateDeps["verifyDatabaseIdentity"]>(async () => {
    calls.push("verifyDatabaseIdentity");
  });
  const spawn = vi.fn<TestDbMigrateDeps["spawn"]>(async () => {
    calls.push("spawn");
    return 0;
  });
  const deps: TestDbMigrateDeps = {
    root: ROOT,
    argv: overrides.argv ?? [],
    execArgv: overrides.execArgv ?? [],
    execPath: EXEC_PATH,
    parentEnv: overrides.parentEnv ?? { PATH: "/usr/bin", HOME: "/home/u" },
    readEnvFile,
    pathExists: (absolutePath) => {
      calls.push(`exists:${path.relative(ROOT, absolutePath)}`);
      return !(overrides.missingPaths ?? []).includes(path.relative(ROOT, absolutePath));
    },
    verifyDatabaseIdentity,
    spawn,
    log: (text) => logs.push(text),
  };
  return { deps, spawn, verifyDatabaseIdentity, logs, calls };
}

/** 指定したコードで止まり、子プロセスも本人確認も呼ばれず、メッセージに秘密情報が含まれないこと */
async function expectStopped(f: Fake, code: TestDbMigrateErrorCode) {
  let caught: unknown;
  try {
    await runTestDbMigrate(f.deps);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TestDbMigrateError);
  expect((caught as TestDbMigrateError).code).toBe(code);
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.verifyDatabaseIdentity).not.toHaveBeenCalled();
  for (const secret of SECRETS) expect((caught as Error).message).not.toContain(secret);
  for (const line of f.logs) for (const secret of SECRETS) expect(line).not.toContain(secret);
  return caught as Error;
}

const EXPECTED_ARGS = [
  path.join(ROOT, "node_modules/prisma/build/index.js"),
  "migrate",
  "deploy",
  "--config",
  path.join(ROOT, "prisma.config.ts"),
];

describe("parseTestDbMigrateArgs", () => {
  it("引数なしは通常実行、--check だけは確認モード", () => {
    expect(parseTestDbMigrateArgs([])).toBe("run");
    expect(parseTestDbMigrateArgs(["--check"])).toBe("check");
  });

  it.each([[["--check", "--check"]], [["--schema", "x"]], [["reset"]], [["--", "migrate", "reset"]], [["--CHECK"]], [["--force"]]])(
    "%j は拒否する（Prisma CLI へ引数を渡さない）",
    (args) => {
      expect(() => parseTestDbMigrateArgs(args)).toThrow(TestDbMigrateError);
    },
  );
});

describe("runTestDbMigrate：通常実行モード", () => {
  it("すべての検証に通った場合だけ、本人確認の後に固定のコマンドで子プロセスを起動する", async () => {
    const f = fake();
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.calls).toEqual([
      "read:.env.test",
      "read:.env",
      "exists:node_modules/prisma/build/index.js",
      "exists:prisma.config.ts",
      "exists:prisma/schema.prisma",
      "exists:prisma/migrations",
      "verifyDatabaseIdentity",
      "spawn",
    ]);
    expect(f.verifyDatabaseIdentity).toHaveBeenCalledWith({ host: "127.0.0.1", port: "5434", database: "katana_test", user: "katana_test_user" });
    const [command, args, options] = f.spawn.mock.calls[0];
    expect(command).toBe(EXEC_PATH);
    expect(args).toEqual(EXPECTED_ARGS);
    expect(options).toEqual({
      cwd: ROOT,
      shell: false,
      stdio: "inherit",
      env: { PATH: "/usr/bin", HOME: "/home/u", DATABASE_URL: TEST_URL, KATANA_DB_TARGET: "test" },
    });
  });

  it("子プロセスの終了コードを返す", async () => {
    const f = fake();
    f.spawn.mockResolvedValueOnce(3);
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(3);
  });

  it("本人確認が失敗したら、子プロセスを起動しない", async () => {
    const f = fake();
    f.verifyDatabaseIdentity.mockRejectedValueOnce(new TestDbMigrateError("IDENTITY_CHECK_NOT_IMPLEMENTED", "stub"));
    await expect(runTestDbMigrate(f.deps)).rejects.toMatchObject({ code: "IDENTITY_CHECK_NOT_IMPLEMENTED" });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("親の DATABASE_URL・PG*・DOTENV_*・PRISMA_*・KATANA_* は子プロセスに渡さず、検証済みの値だけを使う", async () => {
    const f = fake({
      parentEnv: {
        PATH: "/usr/bin",
        DATABASE_URL: DEV_URL,
        PGHOST: "db.example.com",
        PGPASSWORD: "x",
        DOTENV_CONFIG_PATH: ".env",
        PRISMA_SCHEMA_ENGINE_BINARY: "/tmp/engine",
        KATANA_DB_TARGET: "dev",
        LC_ALL: "C",
      },
    });
    await runTestDbMigrate(f.deps);
    expect(f.spawn.mock.calls[0][2].env).toEqual({ PATH: "/usr/bin", LC_ALL: "C", DATABASE_URL: TEST_URL, KATANA_DB_TARGET: "test" });
  });
});

describe("runTestDbMigrate：確認モード", () => {
  it("検証と表示だけを行い、本人確認も Prisma CLI も起動しない", async () => {
    const f = fake({ argv: ["--check"], parentEnv: { PATH: "/usr/bin", PGHOST: "x", DATABASE_URL: DEV_URL } });
    await expect(runTestDbMigrate(f.deps)).resolves.toBe(0);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.verifyDatabaseIdentity).not.toHaveBeenCalled();
    const output = f.logs.join("\n");
    expect(output).toContain("check mode");
    expect(output).toContain("verified 127.0.0.1:5434/katana_test as katana_test_user");
    expect(output).toContain("command: node node_modules/prisma/build/index.js migrate deploy --config prisma.config.ts (no shell)");
    expect(output).toContain("  DATABASE_URL=(hidden)");
    expect(output).toContain("  KATANA_DB_TARGET=test");
    expect(output).toContain("  PGHOST");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("確認モードでも、検証に失敗すれば止まる", async () => {
    await expectStopped(fake({ argv: ["--check"], files: { ".env.test": { DATABASE_URL: DEV_URL } } }), "TARGET_REJECTED");
  });
});

describe("runTestDbMigrate：停止条件（子プロセスを起動しない）", () => {
  it("不正な引数では、ファイルを読む前に止まる", async () => {
    const f = fake({ argv: ["--check", "--force"] });
    await expectStopped(f, "ARGUMENTS_INVALID");
    expect(f.calls).toEqual([]);
  });

  it("Node の起動オプション（execArgv）があれば、ファイルを読む前に止まる", async () => {
    const f = fake({ execArgv: ["--import", "./x.mjs"] });
    await expectStopped(f, "NODE_EXEC_ARGV_PRESENT");
    expect(f.calls).toEqual([]);
  });

  it("NODE_OPTIONS が設定されていれば、ファイルを読む前に止まる", async () => {
    const f = fake({ parentEnv: { PATH: "/usr/bin", NODE_OPTIONS: "--require ./x.js" } });
    await expectStopped(f, "NODE_OPTIONS_PRESENT");
    expect(f.calls).toEqual([]);
  });

  it(".env.test がなければ、.env を読まずに止まる", async () => {
    const f = fake({ files: { ".env.test": undefined } });
    await expectStopped(f, "TEST_ENV_MISSING");
    expect(f.calls).toEqual(["read:.env.test"]);
  });

  it.each([
    ["DATABASE_URL がない", undefined, "URL_MISSING"],
    ["開発用DBのURL", DEV_URL, "PORT_NOT_ALLOWED"],
    ["ポート5433", TEST_URL.replace(":5434", ":5433"), "PORT_NOT_ALLOWED"],
    ["DB名が違う", TEST_URL.replace(/\/katana_test$/, "/katana"), "DATABASE_NOT_ALLOWED"],
    ["ユーザー名が違う", TEST_URL.replace("katana_test_user", "katana"), "USER_NOT_ALLOWED"],
    ["パスワードなし", "postgresql://katana_test_user@127.0.0.1:5434/katana_test", "PASSWORD_MISSING"],
    ["ほかのホスト", TEST_URL.replace("127.0.0.1", "10.0.0.5"), "HOST_NOT_ALLOWED"],
    ["クエリパラメータ", `${TEST_URL}?host=/tmp`, "QUERY_NOT_ALLOWED"],
  ])(".env.test の DATABASE_URL が %s なら、コマンドの確認の前に止まる", async (_label, url, guardCode) => {
    const f = fake({ files: { ".env.test": url === undefined ? {} : { DATABASE_URL: url } } });
    const error = await expectStopped(f, "TARGET_REJECTED");
    expect(error.message).toContain(`(${guardCode})`);
    expect(f.calls).toEqual(["read:.env.test", "read:.env"]);
  });

  it("開発用DBと同じ接続先なら止まる", async () => {
    const error = await expectStopped(fake({ files: { ".env": { DATABASE_URL: TEST_URL } } }), "TARGET_REJECTED");
    expect(error.message).toContain("(MATCHES_DEVELOPMENT_DATABASE)");
  });

  it("Prisma CLI・設定・migration が見つからなければ止まる", async () => {
    for (const missing of ["node_modules/prisma/build/index.js", "prisma.config.ts", "prisma/migrations"]) {
      await expectStopped(fake({ missingPaths: [missing] }), "REQUIRED_FILE_MISSING");
    }
  });
});

describe("buildTestDbMigrateEnv", () => {
  it("許可リストの変数・検証済みの DATABASE_URL・KATANA_DB_TARGET=test だけを含み、落とした変数の名前を返す", () => {
    const { childEnv, droppedKeys } = buildTestDbMigrateEnv(
      { PATH: "/usr/bin", TZ: "UTC", NODE_OPTIONS: "", PGUSER: "u", DOTENV_CONFIG_OVERRIDE: "true", DATABASE_URL: DEV_URL },
      TEST_URL,
    );
    expect(childEnv).toEqual({ PATH: "/usr/bin", TZ: "UTC", DATABASE_URL: TEST_URL, KATANA_DB_TARGET: "test" });
    expect(droppedKeys).toEqual(["DATABASE_URL", "DOTENV_CONFIG_OVERRIDE", "NODE_OPTIONS", "PGUSER"]);
  });
});
