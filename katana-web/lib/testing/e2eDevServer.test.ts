import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  E2E_DEV_SERVER_DISABLED,
  E2E_DEV_SERVER_HOST,
  E2E_DEV_SERVER_PORT,
  type E2eDevServerAccess,
  type E2eDevServerDeps,
  E2eDevServerError,
  NEXT_CLI_ENTRY,
  NEXT_DEV_ARGS,
  parseE2eDevServerArgs,
  prepareE2eDevServerEnv,
  runE2eDevServer,
} from "./e2eDevServer";
import { assertAppDatabaseTarget } from "../db/testDatabaseGuard";

// E2E 用の開発サーバーの起動スクリプトの本体（Step 4-13B）の単体テスト。開発サーバー・子プロセス・DB・Docker には触れない。
// ファイルの読み込み・乱数・spawn は偽の関数だけを使う。値はすべてダミー
const PASSWORD = "e2e-dummy-pass";
const ADMIN_PASSWORD = "e2e-dummy-admin";
const TEST_URL = `postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`;
const DEV_URL = "postgresql://katana:dev-dummy-pass@localhost:5433/katana";
const SECRET = "A".repeat(20) + "b-_" + "C".repeat(20); // 43 文字（base64url の 32 バイトと同じ長さ）
const REAL_LOOKING_SECRET = "real-auth-secret-from-env-local-should-not-pass";
const SECRETS = [PASSWORD, ADMIN_PASSWORD, "dev-dummy-pass", TEST_URL, DEV_URL, SECRET, REAL_LOOKING_SECRET, "postgresql://"];
const ROOT = "/repo/katana-web";
const REPO_ROOT = path.resolve(__dirname, "../..");
const GOOD_TEST_ENV = { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD };
const DEVELOPMENT_ENV = { DATABASE_URL: DEV_URL };
const PARENT_ENV = { PATH: "/usr/bin", HOME: "/home/u" };
const ENABLED: E2eDevServerAccess = { mode: "enabled" };

function fake(overrides: Partial<E2eDevServerDeps> & { testEnv?: Record<string, string> | undefined; missing?: boolean } = {}) {
  const logs: string[] = [];
  const spawn = vi.fn<E2eDevServerDeps["spawn"]>(async () => 0);
  const files: Record<string, Record<string, string> | undefined> = {
    [path.join(ROOT, ".env.test")]: "testEnv" in overrides ? overrides.testEnv : GOOD_TEST_ENV,
    [path.join(ROOT, ".env")]: DEVELOPMENT_ENV,
  };
  const deps: E2eDevServerDeps = {
    root: ROOT,
    argv: [],
    execArgv: [],
    execPath: "/usr/local/bin/node",
    parentEnv: PARENT_ENV,
    readEnvFile: (filePath) => files[filePath],
    pathExists: () => !overrides.missing,
    generateSecret: () => SECRET,
    devServer: ENABLED,
    spawn,
    log: (text) => logs.push(text),
    ...overrides,
  };
  return { deps, spawn, logs };
}

async function expectStopped(deps: E2eDevServerDeps, code: string): Promise<E2eDevServerError> {
  const error = await runE2eDevServer(deps).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(E2eDevServerError);
  expect((error as E2eDevServerError).code).toBe(code);
  for (const secret of SECRETS) expect(String((error as Error).message)).not.toContain(secret);
  return error as E2eDevServerError;
}

describe("8つ目の固定ゲート E2E_DEV_SERVER_DISABLED", () => {
  it("無効の値で凍結されていて、書き換えられない", () => {
    expect(E2E_DEV_SERVER_DISABLED).toEqual({ mode: "disabled" });
    expect(Object.isFrozen(E2E_DEV_SERVER_DISABLED)).toBe(true);
    expect(() => {
      (E2E_DEV_SERVER_DISABLED as { mode: string }).mode = "enabled";
    }).toThrow(TypeError);
  });

  it("--start でも、ゲートが無効なら E2E_DEV_SERVER_LIVE_DISABLED で止まり、spawn を呼ばない", async () => {
    const { deps, spawn } = fake({ argv: ["--start"], devServer: E2E_DEV_SERVER_DISABLED });
    const error = await expectStopped(deps, "E2E_DEV_SERVER_LIVE_DISABLED");
    expect(error.message).toContain("refusing to start the dev server");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([[{ mode: "ENABLED" }], [{ mode: "enabled " }], [{}]])("mode が \"enabled\" と完全に一致しなければ（%j）、無効として扱う", async (gate) => {
    const { deps, spawn } = fake({ argv: ["--start"], devServer: gate as unknown as E2eDevServerAccess });
    await expectStopped(deps, "E2E_DEV_SERVER_LIVE_DISABLED");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("環境変数をどう設定しても、ゲートは有効にならない", async () => {
    const parentEnv = { ...PARENT_ENV, E2E_DEV_SERVER: "enabled", KATANA_E2E: "1", E2E_DEV_SERVER_ENABLED: "true" };
    const { deps, spawn } = fake({ argv: ["--start"], devServer: E2E_DEV_SERVER_DISABLED, parentEnv });
    await expectStopped(deps, "E2E_DEV_SERVER_LIVE_DISABLED");
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("引数と起動の前の検証", () => {
  it("引数は、なし（予行）か --start だけ", () => {
    expect(parseE2eDevServerArgs([])).toBe("dry-run");
    expect(parseE2eDevServerArgs(["--start"])).toBe("start");
    for (const args of [["--apply"], ["--start", "--start"], ["--port", "3000"], ["start"], ["--start", "x"]]) {
      expect(() => parseE2eDevServerArgs(args)).toThrow(E2eDevServerError);
    }
  });

  it.each([
    ["Node の起動オプションがある", { execArgv: ["--require", "x"] }, "NODE_EXEC_ARGV_PRESENT"],
    ["親に NODE_OPTIONS がある", { parentEnv: { ...PARENT_ENV, NODE_OPTIONS: "--require x" } }, "NODE_OPTIONS_PRESENT"],
    [".env.test がない", { testEnv: undefined }, "TEST_ENV_MISSING"],
    ["Next の CLI がない", { missing: true }, "REQUIRED_FILE_MISSING"],
    ["乱数が短い", { generateSecret: () => "short" }, "SECRET_INVALID"],
    ["乱数に使えない文字がある", { generateSecret: () => "x".repeat(42) + "=" }, "SECRET_INVALID"],
  ])("%s なら、ゲートが有効でも起動しない", async (_label, override, code) => {
    const { deps, spawn } = fake({ argv: ["--start"], ...override });
    await expectStopped(deps, code);
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["接続先が開発用DB", { DATABASE_URL: DEV_URL, KATANA_TEST_DB_PASSWORD: "dev-dummy-pass", KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD }, "TARGET_REJECTED", "PORT_NOT_ALLOWED"],
    ["DATABASE_URL がない", { KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD }, "TARGET_REJECTED", "TEST_ENV_URL_MISSING"],
    ["パスワードが見本の値", { DATABASE_URL: TEST_URL.replace(PASSWORD, "CHANGE_ME_x"), KATANA_TEST_DB_PASSWORD: "CHANGE_ME_x", KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN_PASSWORD }, "CREDENTIALS_REJECTED", "PASSWORD_PLACEHOLDER"],
    ["管理用とアプリ用の共用", { ...GOOD_TEST_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: PASSWORD }, "CREDENTIALS_REJECTED", "ADMIN_PASSWORD_SAME_AS_APP"],
  ])(".env.test の %s なら、コードだけを含むエラーで止まる", async (_label, testEnv, code, inner) => {
    const { deps, spawn } = fake({ argv: ["--start"], testEnv });
    const error = await expectStopped(deps, code);
    expect(error.message).toContain(`(${inner})`);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("開発サーバーに渡す環境変数（prepareE2eDevServerEnv）", () => {
  const parentEnv = {
    ...PARENT_ENV,
    DATABASE_URL: DEV_URL,
    AUTH_SECRET: REAL_LOOKING_SECRET,
    AUTH_URL: "http://localhost:3000",
    NEXTAUTH_URL: "http://localhost:3000",
    PGHOST: "db.example.com",
    DOTENV_CONFIG_PATH: ".env",
    KATANA_DB_TEST_MODE: "integration",
    KATANA_TEST_RUNNER: "script",
    PORT: "3000",
  };

  it("許可リストの変数と固定の値だけを渡し、親の DATABASE_URL・AUTH_SECRET・PG*・DOTENV_* などは渡さない", () => {
    const { childEnv, droppedKeys, target } = prepareE2eDevServerEnv({ parentEnv, testEnv: GOOD_TEST_ENV, developmentEnv: DEVELOPMENT_ENV, generateSecret: () => SECRET });
    expect(childEnv).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      DATABASE_URL: TEST_URL,
      KATANA_DB_TARGET: "test",
      AUTH_SECRET: SECRET,
      NEXT_TELEMETRY_DISABLED: "1",
    });
    expect(target).toEqual({ host: "127.0.0.1", port: "5434", database: "katana_test", user: "katana_test_user" });
    expect(droppedKeys).toEqual(expect.arrayContaining(["DATABASE_URL", "AUTH_SECRET", "AUTH_URL", "NEXTAUTH_URL", "PGHOST", "DOTENV_CONFIG_PATH", "PORT"]));
  });

  it("作った環境変数は、開発サーバーの中の lib/prisma.ts と同じ検証（assertAppDatabaseTarget）に通る", () => {
    const { childEnv } = prepareE2eDevServerEnv({ parentEnv: PARENT_ENV, testEnv: GOOD_TEST_ENV, developmentEnv: DEVELOPMENT_ENV, generateSecret: () => SECRET });
    expect(assertAppDatabaseTarget({ env: childEnv, testEnv: GOOD_TEST_ENV, developmentDatabaseUrl: DEV_URL }).mode).toBe("test");
  });

  it("NODE_ENV・AUTH_URL・AUTH_TRUST_HOST は設定しない（next dev が development にし、Auth.js は development でホストを信頼する）", () => {
    const { childEnv } = prepareE2eDevServerEnv({ parentEnv: PARENT_ENV, testEnv: GOOD_TEST_ENV, developmentEnv: DEVELOPMENT_ENV, generateSecret: () => SECRET });
    for (const key of ["NODE_ENV", "AUTH_URL", "AUTH_TRUST_HOST", "NEXTAUTH_URL", "NEXTAUTH_SECRET"]) expect(childEnv[key], key).toBeUndefined();
  });

  it("AUTH_SECRET は呼ぶたびに generateSecret から作り、親や .env.local の値を使わない", () => {
    const generateSecret = vi.fn(() => SECRET);
    prepareE2eDevServerEnv({ parentEnv, testEnv: GOOD_TEST_ENV, developmentEnv: DEVELOPMENT_ENV, generateSecret });
    expect(generateSecret).toHaveBeenCalledTimes(1);
  });
});

describe("予行と起動（偽の spawn）", () => {
  it("予行は検証と表示だけで、spawn を呼ばない。表示に接続URL・パスワード・AUTH_SECRET を含めない", async () => {
    const { deps, spawn, logs } = fake({ devServer: E2E_DEV_SERVER_DISABLED });
    await expect(runE2eDevServer(deps)).resolves.toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    const output = logs.join("\n");
    expect(output).toContain("dry run (--start was not given): the dev server was not started and no database connection was made.");
    expect(output).toContain(`dev server: http://${E2E_DEV_SERVER_HOST}:${E2E_DEV_SERVER_PORT}`);
    expect(output).toContain("  DATABASE_URL=(hidden)");
    expect(output).toContain("  AUTH_SECRET=(hidden)");
    expect(output).toContain("dev server gate: disabled in this build");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("ゲートが有効で --start なら、Next の CLI を固定の引数で、shell を使わずに1回だけ起動し、終了コードを返す", async () => {
    const { deps, spawn } = fake({ argv: ["--start"] });
    spawn.mockResolvedValueOnce(0);
    await expect(runE2eDevServer(deps)).resolves.toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    expect(command).toBe("/usr/local/bin/node");
    expect(args).toEqual([path.join(ROOT, NEXT_CLI_ENTRY), "dev", "--hostname", "127.0.0.1", "--port", "3100"]);
    expect(options).toEqual({ cwd: ROOT, env: expect.objectContaining({ KATANA_DB_TARGET: "test", DATABASE_URL: TEST_URL }), shell: false, stdio: "inherit" });
  });

  it("起動に失敗したら START_FAILED（元のメッセージを含めない）", async () => {
    const { deps, spawn } = fake({ argv: ["--start"] });
    spawn.mockRejectedValueOnce(new Error(`spawn failed with ${TEST_URL}`));
    await expectStopped(deps, "START_FAILED");
  });

  it("Next の引数は固定（127.0.0.1 だけで待ち受け、ポートは 3100）", () => {
    expect(NEXT_DEV_ARGS).toEqual(["dev", "--hostname", "127.0.0.1", "--port", "3100"]);
    expect(Object.isFrozen(NEXT_DEV_ARGS)).toBe(true);
  });
});

describe("静的検査：scripts/e2e-dev-server.mts と package.json（import しない）", () => {
  const code = readFileSync(path.join(REPO_ROOT, "scripts", "e2e-dev-server.mts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // F-01 の E2E（docs/E2E-F01-RUNBOOK.md の4章）のために、承認を得て一時的に有効化。E2E の後、無効の定数の形に戻し、この確認も元に戻す
  it("8つ目の固定ゲートを、固定のリテラル { mode: \"enabled\" } で渡す（一時的に有効。切り替えの経路がない）", () => {
    expect(code.match(/^ {2}devServer: .*$/gm)).toEqual(['  devServer: { mode: "enabled" },']);
    // 有効値はこの1か所だけ。無効の定数の import・条件式・環境変数・引数による切り替えがないこと
    expect(code.match(/mode:\s*["']enabled["']/g)).toHaveLength(1);
    expect(code.match(/mode:/g)).toHaveLength(1);
    expect(code).not.toContain("E2E_DEV_SERVER_DISABLED");
    for (const forbidden of ["process.argv.includes", "process.env.", "process.env[", "? {", "?? {", "|| {", "&& {"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("引数・環境変数は、そのまま本体に渡すだけ。AUTH_SECRET は node:crypto の乱数で作る", () => {
    expect(code).toContain("  argv: process.argv.slice(2),");
    expect(code).toContain("  parentEnv: process.env,");
    expect(code).toContain('  generateSecret: () => randomBytes(32).toString("base64url"),');
    expect(code).toContain('import { randomBytes } from "node:crypto";');
  });

  it("DB ドライバ・Prisma・Docker の部品を読み込まない", () => {
    for (const forbidden of ['"pg"', "@prisma/client", "@/lib/prisma", "testDbConnection", "testDbDocker", "docker"]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });

  it("package.json の e2e:dev-server は予行だけで、--start を含む script はない", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["e2e:dev-server"]).toBe("node scripts/e2e-dev-server.mts");
    expect(Object.values(pkg.scripts).filter((s) => s.includes("e2e-dev-server"))).toEqual(["node scripts/e2e-dev-server.mts"]);
    expect(Object.values(pkg.scripts).some((s) => s.includes("--start"))).toBe(false);
  });
});
