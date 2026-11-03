import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertTestDatabaseCredentials, TestDatabaseCredentialsError } from "../lib/db/testDatabaseGuard.ts";
import {
  buildComposeEnv,
  type CommandResult,
  composeArgs,
  parseTestDbArgs,
  runTestDb,
  type TestDbDeps,
  TestDbError,
  type TestDbErrorCode,
  verifyComposeConfig,
  verifyTestDbEnv,
} from "./testdb.mts";

// Docker・DBには接続しない。docker コマンドは、引数に応じて決まった出力を返す偽の関数で置き換える
const ROOT = "/fake/katana-web";
const APP = "app_Pass-123";
const ADMIN = "admin_Pass-456";
const TEST_URL = `postgresql://katana_test_user:${APP}@127.0.0.1:5434/katana_test`;
const DEV_PASSWORD = "dev-dummy-pass";
const DEV_URL = `postgresql://katana:${DEV_PASSWORD}@localhost:5433/katana`;
const SECRETS = [APP, ADMIN, DEV_PASSWORD, TEST_URL, DEV_URL, "postgresql://"];
const GOOD_ENV = { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: APP, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN };
const VERIFIED = { target: { host: "127.0.0.1", port: "5434", database: "katana_test", user: "katana_test_user" }, databaseUrl: TEST_URL, appPassword: APP, adminPassword: ADMIN };

/** docker compose config --format json の出力（Compose v5 の形） */
function composeConfig(overrides: { service?: Record<string, unknown>; top?: Record<string, unknown> } = {}) {
  return JSON.stringify({
    name: "katana-test",
    networks: { default: { name: "katana-test_default" } },
    services: {
      "test-db": {
        container_name: "katana-test-db",
        image: "postgres:15",
        restart: "no",
        environment: { POSTGRES_DB: "katana_test", POSTGRES_PASSWORD: ADMIN, POSTGRES_USER: "postgres", KATANA_TEST_DB_PASSWORD: APP },
        ports: [{ mode: "ingress", host_ip: "127.0.0.1", target: 5432, published: "5434", protocol: "tcp" }],
        tmpfs: ["/var/lib/postgresql/data"],
        volumes: [{ type: "bind", source: path.join(ROOT, "docker/test-db/init"), target: "/docker-entrypoint-initdb.d", read_only: true, bind: {} }],
        healthcheck: { test: ["CMD", "pg_isready", "-h", "127.0.0.1"], interval: "2s" },
        networks: { default: null },
        ...overrides.service,
      },
    },
    ...overrides.top,
  });
}

function expectCode(fn: () => unknown, code: TestDbErrorCode) {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TestDbError);
  expect((caught as TestDbError).code).toBe(code);
  for (const secret of SECRETS) expect((caught as Error).message).not.toContain(secret);
}

type FakeOptions = {
  argv?: string[];
  execArgv?: string[];
  parentEnv?: Record<string, string | undefined>;
  testEnv?: Record<string, string> | undefined;
  config?: string;
  context?: string;
  ps?: string;
  labeled?: string;
  fail?: { match: string; result: CommandResult };
};

function fake(options: FakeOptions = {}) {
  const logs: string[] = [];
  const run = vi.fn<TestDbDeps["run"]>(async (_command, args) => {
    const joined = args.join(" ");
    if (options.fail && joined.includes(options.fail.match)) return options.fail.result;
    const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (joined === "context show") return ok(`${options.context ?? "desktop-linux"}\n`);
    if (joined.endsWith("config --quiet")) return ok("");
    if (joined.endsWith("config --format json")) return ok(options.config ?? composeConfig());
    if (joined.endsWith("ps --all --format json")) return ok(options.ps ?? "");
    if (joined.includes("label=com.docker.compose.project")) return ok(options.labeled ?? "");
    if (joined.includes("name=^katana-db$")) return ok("");
    if (joined.startsWith("volume ls")) return ok("katana-web_postgres_data\n");
    if (joined.startsWith("volume inspect")) return ok("katana-web_postgres_data\t2026-07-18T05:42:41Z\tkatana-web\tpostgres_data\n");
    if (joined.includes("volume=katana-web_postgres_data")) return ok("");
    throw new Error(`unexpected docker call: ${joined}`);
  });
  const files: Record<string, Record<string, string> | undefined> = {
    ".env.test": "testEnv" in options ? options.testEnv : GOOD_ENV,
    ".env": { DATABASE_URL: DEV_URL },
  };
  const deps: TestDbDeps = {
    root: ROOT,
    argv: options.argv ?? ["--check"],
    execArgv: options.execArgv ?? [],
    parentEnv: options.parentEnv ?? { PATH: "/usr/bin", HOME: "/home/u" },
    readEnvFile: (absolutePath) => files[path.relative(ROOT, absolutePath)],
    pathExists: () => true,
    run,
    log: (text) => logs.push(text),
  };
  return { deps, run, logs };
}

async function expectStopped(f: ReturnType<typeof fake>, code: TestDbErrorCode) {
  let caught: unknown;
  try {
    await runTestDb(f.deps);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TestDbError);
  expect((caught as TestDbError).code).toBe(code);
  for (const secret of SECRETS) expect((caught as Error).message).not.toContain(secret);
  return caught as TestDbError;
}

/** すべての docker の呼び出しが、読み取り専用の決まった形であること */
function expectOnlyReadOnlyCalls(run: ReturnType<typeof fake>["run"]) {
  const mutating = /\b(up|down|start|stop|restart|rm|kill|create|run|exec|pull|prune|pause|unpause|scale|cp|build|push)\b/;
  for (const [command, args, options] of run.mock.calls) {
    expect(command).toBe("docker");
    expect(options).toMatchObject({ cwd: ROOT, shell: false });
    const sub = args[0] === "compose" ? args.slice(9) : args;
    expect(sub.join(" ")).not.toMatch(mutating);
  }
}

describe("parseTestDbArgs", () => {
  it("--check と --status だけを受け付ける", () => {
    expect(parseTestDbArgs(["--check"])).toBe("check");
    expect(parseTestDbArgs(["--status"])).toBe("status");
  });

  it.each([
    [[]],
    [["up"]],
    [["down"]],
    [["reset"]],
    [["--check", "--status"]],
    [["--check", "-p", "other"]],
    [["--check", "--project-name", "katana-web"]],
    [["--check", "-f", "docker-compose.yml"]],
    [["--check", "--file", "docker-compose.yml"]],
    [["--check", "--env-file", ".env"]],
    [["--check", "--", "down", "-v"]],
  ])("%j は拒否する（別のプロジェクト・Composeファイル・env ファイルを指定できない）", (args) => {
    expectCode(() => parseTestDbArgs(args), "ARGUMENTS_INVALID");
  });
});

describe("verifyTestDbEnv（R14）", () => {
  const dev = { DATABASE_URL: DEV_URL };

  it("正しい設定は許可し、表示してよい接続先を返す", () => {
    expect(verifyTestDbEnv(GOOD_ENV, dev)).toEqual(VERIFIED);
  });

  it(".env.test がなければ拒否する", () => {
    expectCode(() => verifyTestDbEnv(undefined, dev), "TEST_ENV_MISSING");
  });

  it.each(["COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "PGHOST", "POSTGRES_PASSWORD", "DOCKER_HOST", "OTHER"])(
    ".env.test に想定外のキー（%s）があれば拒否する（--env-file で Compose の動作を変えられないようにする）",
    (key) => {
      expectCode(() => verifyTestDbEnv({ ...GOOD_ENV, [key]: "x" }, dev), "TEST_ENV_UNEXPECTED_KEY");
    },
  );

  it.each([
    ["開発用DBのURL", DEV_URL],
    ["ポート5433", TEST_URL.replace(":5434", ":5433")],
    ["DB名が違う", TEST_URL.replace(/\/katana_test$/, "/katana")],
    ["ユーザーが違う", TEST_URL.replace("katana_test_user", "katana")],
    ["ほかのホスト", TEST_URL.replace("127.0.0.1", "10.0.0.5")],
    ["パスワードなし", "postgresql://katana_test_user@127.0.0.1:5434/katana_test"],
  ])("不正な接続先（%s）は拒否する", (_label, url) => {
    expectCode(() => verifyTestDbEnv({ ...GOOD_ENV, DATABASE_URL: url }, dev), "TARGET_REJECTED");
  });

  it("DATABASE_URL がなければ拒否する", () => {
    expectCode(() => verifyTestDbEnv({ ...GOOD_ENV, DATABASE_URL: undefined }, dev), "TARGET_REJECTED");
  });

  it("アプリ用・管理用のパスワードがない（空）なら拒否する", () => {
    expectCode(() => verifyTestDbEnv({ ...GOOD_ENV, KATANA_TEST_DB_PASSWORD: "" }, dev), "APP_PASSWORD_MISSING");
    expectCode(() => verifyTestDbEnv({ ...GOOD_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: "" }, dev), "ADMIN_PASSWORD_MISSING");
  });

  it("URLのパスワードとアプリ用のパスワードが違えば拒否する", () => {
    expectCode(() => verifyTestDbEnv({ ...GOOD_ENV, KATANA_TEST_DB_PASSWORD: `${APP}x` }, dev), "URL_PASSWORD_MISMATCH");
  });

  it("管理用とアプリ用が同じパスワードなら拒否する", () => {
    expectCode(() => verifyTestDbEnv({ ...GOOD_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: APP }, dev), "ADMIN_PASSWORD_SAME_AS_APP");
  });

  it(".env.test.example の見本の値（CHANGE_ME_…）は、どこに残っていても拒否する", () => {
    const placeholder = "CHANGE_ME_test_password";
    const url = TEST_URL.replace(APP, placeholder);
    expectCode(() => verifyTestDbEnv({ DATABASE_URL: url, KATANA_TEST_DB_PASSWORD: placeholder, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN }, dev), "PASSWORD_PLACEHOLDER");
    expectCode(() => verifyTestDbEnv({ ...GOOD_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: "CHANGE_ME_admin_password" }, dev), "PASSWORD_PLACEHOLDER");
    expectCode(() => verifyTestDbEnv({ ...GOOD_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: "my-changeme-pw" }, dev), "PASSWORD_PLACEHOLDER");
  });

  it.each([
    ["パーセントエンコード", "app%21pass"],
    ["記号", "app!pass"],
    ["空白", "app pass"],
  ])("使えない文字（%s）を含むパスワードは拒否する", (_label, password) => {
    const env = { DATABASE_URL: TEST_URL.replace(APP, encodeURIComponent(password)), KATANA_TEST_DB_PASSWORD: password, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN };
    expect(() => verifyTestDbEnv(env, dev)).toThrow(TestDbError);
  });

  it("URLにエンコードした表記とアプリ用の値が、デコードすると同じでも一致とはみなさない（書かれたままの文字列で比べる）", () => {
    const env = { DATABASE_URL: TEST_URL.replace(APP, "app%5Fpass"), KATANA_TEST_DB_PASSWORD: "app_pass", KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN };
    expectCode(() => verifyTestDbEnv(env, dev), "PASSWORD_CHARSET");
  });

  it.each([
    ["見本の値", { KATANA_TEST_DB_ADMIN_PASSWORD: "CHANGE_ME_admin_password" }],
    ["不一致", { KATANA_TEST_DB_PASSWORD: `${APP}x` }],
    ["管理用と同じ", { KATANA_TEST_DB_ADMIN_PASSWORD: APP }],
    ["空", { KATANA_TEST_DB_PASSWORD: "" }],
    ["使えない文字", { KATANA_TEST_DB_ADMIN_PASSWORD: "a b" }],
  ])("パスワードの判定（%s）は、runner・testdb-migrate・Prisma CLI と共通の assertTestDatabaseCredentials() と同じコードになる", (_label, override) => {
    const env = { ...GOOD_ENV, ...override };
    let sharedCode: string | undefined;
    try {
      assertTestDatabaseCredentials(env);
    } catch (error) {
      if (error instanceof TestDatabaseCredentialsError) sharedCode = error.code;
    }
    expect(sharedCode).toBeDefined();
    expectCode(() => verifyTestDbEnv(env, dev), sharedCode as TestDbErrorCode);
  });
});

describe("buildComposeEnv（R15）", () => {
  it("許可リストの変数と、検証済みの2つのパスワードだけを渡す", () => {
    const parentEnv = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      DATABASE_URL: DEV_URL,
      PGHOST: "db.example.com",
      PGPASSWORD: "x",
      DOTENV_CONFIG_PATH: ".env",
      COMPOSE_PROJECT_NAME: "katana-web",
      COMPOSE_FILE: "docker-compose.yml",
      COMPOSE_PROFILES: "x",
      POSTGRES_PASSWORD: "x",
      DOCKER_CONFIG: "/tmp/other",
      DOCKER_CERT_PATH: "/tmp/certs",
      KATANA_TEST_DB_PASSWORD: "parent-value",
      KATANA_TEST_DB_ADMIN_PASSWORD: "parent-value",
      KATANA_DB_TARGET: "test",
    };
    const { childEnv, droppedKeys } = buildComposeEnv(parentEnv, VERIFIED);
    expect(childEnv).toEqual({ PATH: "/usr/bin", HOME: "/home/u", KATANA_TEST_DB_PASSWORD: APP, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN });
    expect(droppedKeys).toContain("COMPOSE_PROJECT_NAME");
    expect(droppedKeys).toContain("DATABASE_URL");
  });
});

describe("composeArgs", () => {
  it("プロジェクト・Composeファイル・作業ディレクトリ・env ファイルを、絶対パスで固定する", () => {
    expect(composeArgs(ROOT, ["config", "--quiet"])).toEqual([
      "compose",
      "--project-name",
      "katana-test",
      "--file",
      path.join(ROOT, "docker-compose.test.yml"),
      "--project-directory",
      ROOT,
      "--env-file",
      path.join(ROOT, ".env.test"),
      "config",
      "--quiet",
    ]);
  });
});

describe("verifyComposeConfig", () => {
  it("期待どおりの構成なら、パスワードを含まない要約を返す", () => {
    const summary = verifyComposeConfig(composeConfig(), ROOT, VERIFIED).join("\n");
    expect(summary).toContain("project: katana-test");
    expect(summary).toContain("port: 127.0.0.1:5434 -> 5432");
    for (const secret of SECRETS) expect(summary).not.toContain(secret);
  });

  it.each([
    ["プロジェクト名", { top: { name: "katana-web" } }],
    ["トップレベルの volumes", { top: { volumes: { postgres_data: {} } } }],
    ["イメージ", { service: { image: "postgres:16" } }],
    ["restart", { service: { restart: "unless-stopped" } }],
    ["全インターフェースへの公開", { service: { ports: [{ host_ip: "0.0.0.0", target: 5432, published: "5434" }] } }],
    ["ポート5433", { service: { ports: [{ host_ip: "127.0.0.1", target: 5432, published: "5433" }] } }],
    ["tmpfs なし", { service: { tmpfs: undefined } }],
    ["開発用ボリュームのマウント", { service: { volumes: [{ type: "volume", source: "katana-web_postgres_data", target: "/var/lib/postgresql/data" }] } }],
    ["書き込み可能な初期化ディレクトリ", { service: { volumes: [{ type: "bind", source: path.join(ROOT, "docker/test-db/init"), target: "/docker-entrypoint-initdb.d" }] } }],
    ["healthcheck なし", { service: { healthcheck: undefined } }],
    ["env_file", { service: { env_file: [".env"] } }],
    ["パスワードの値の違い", { service: { environment: { POSTGRES_DB: "katana_test", POSTGRES_PASSWORD: "other", POSTGRES_USER: "postgres", KATANA_TEST_DB_PASSWORD: APP } } }],
    ["DB名の違い", { service: { environment: { POSTGRES_DB: "katana", POSTGRES_PASSWORD: ADMIN, POSTGRES_USER: "postgres", KATANA_TEST_DB_PASSWORD: APP } } }],
  ])("%s が違えば拒否する（エラーに値を含めない）", (_label, overrides) => {
    expectCode(() => verifyComposeConfig(composeConfig(overrides), ROOT, VERIFIED), "COMPOSE_CONFIG_MISMATCH");
  });

  it("JSONでなければ拒否する", () => {
    expectCode(() => verifyComposeConfig("not json", ROOT, VERIFIED), "COMPOSE_CONFIG_INVALID");
  });
});

describe("runTestDb：--check", () => {
  it("検証と config の照合だけを行い、コンテナを操作しない", async () => {
    const f = fake();
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expect(f.run.mock.calls.map(([, args]) => args.slice(args[0] === "compose" ? 9 : 0).join(" "))).toEqual([
      "context show",
      "config --quiet",
      "config --format json",
    ]);
    expectOnlyReadOnlyCalls(f.run);
    const output = f.logs.join("\n");
    expect(output).toContain("check mode");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("Compose には、親ではなく検証済みのパスワードと許可リストの変数だけを渡す", async () => {
    const f = fake({ parentEnv: { PATH: "/usr/bin", COMPOSE_FILE: "docker-compose.yml", KATANA_TEST_DB_PASSWORD: "parent", DATABASE_URL: DEV_URL, PGHOST: "x" } });
    await runTestDb(f.deps);
    for (const [, , options] of f.run.mock.calls) {
      expect(options.env).toEqual({ PATH: "/usr/bin", KATANA_TEST_DB_PASSWORD: APP, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN });
    }
  });

  it("コンテキストが記録した値と違えば、config を実行せずに止まる", async () => {
    const f = fake({ context: "remote-server" });
    await expectStopped(f, "DOCKER_CONTEXT_MISMATCH");
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("config が失敗したら止まり、stderr のパスワードを伏せる", async () => {
    const f = fake({ fail: { match: "config --quiet", result: { code: 15, stdout: "", stderr: `error near ${ADMIN} and ${TEST_URL}` } } });
    const error = await expectStopped(f, "DOCKER_COMMAND_FAILED");
    expect(error.message).toContain("(hidden)");
  });

  it("config の内容が違えば止まる", async () => {
    await expectStopped(fake({ config: composeConfig({ top: { name: "katana-web" } }) }), "COMPOSE_CONFIG_MISMATCH");
  });
});

describe("runTestDb：停止条件（docker を呼ばない）", () => {
  it.each([
    ["不正な引数", { argv: ["--check", "-p", "x"] }, "ARGUMENTS_INVALID"],
    ["Node の起動オプション", { execArgv: ["--import", "x"] }, "NODE_EXEC_ARGV_PRESENT"],
    ["NODE_OPTIONS", { parentEnv: { PATH: "/usr/bin", NODE_OPTIONS: "--require x" } }, "NODE_OPTIONS_PRESENT"],
    ["DOCKER_HOST", { parentEnv: { PATH: "/usr/bin", DOCKER_HOST: "tcp://remote:2375" } }, "DOCKER_TARGET_ENV_PRESENT"],
    ["DOCKER_CONTEXT", { parentEnv: { PATH: "/usr/bin", DOCKER_CONTEXT: "remote" } }, "DOCKER_TARGET_ENV_PRESENT"],
    [".env.test がない", { testEnv: undefined }, "TEST_ENV_MISSING"],
    ["パスワードの不一致", { testEnv: { ...GOOD_ENV, KATANA_TEST_DB_PASSWORD: "other_pass" } }, "URL_PASSWORD_MISMATCH"],
    ["見本の値", { testEnv: { ...GOOD_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: "CHANGE_ME_admin_password" } }, "PASSWORD_PLACEHOLDER"],
  ] as const)("%s", async (_label, options, code) => {
    const f = fake(options as FakeOptions);
    await expectStopped(f, code);
    expect(f.run).not.toHaveBeenCalled();
  });
});

describe("runTestDb：--status", () => {
  it("読み取り専用のコマンドだけを実行し、開発用ボリュームの記録を表示する", async () => {
    const f = fake({ argv: ["--status"], ps: '{"Name":"katana-test-db","State":"running","Health":"healthy"}\n', labeled: "katana-test-db\n" });
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expectOnlyReadOnlyCalls(f.run);
    const output = f.logs.join("\n");
    expect(output).toContain("katana-test-db (running, healthy)");
    expect(output).toContain("development container katana-db: not present");
    expect(output).toContain("katana-web_postgres_data\t2026-07-18T05:42:41Z\tkatana-web\tpostgres_data");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("katana-test プロジェクトに別のコンテナがあれば止まる", async () => {
    await expectStopped(fake({ argv: ["--status"], labeled: "katana-test-db\nkatana-db\n" }), "STATUS_UNEXPECTED_CONTAINER");
  });
});
