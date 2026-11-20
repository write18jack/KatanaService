import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertTestDatabaseCredentials, TestDatabaseCredentialsError } from "../lib/db/testDatabaseGuard.ts";
import {
  buildComposeEnv,
  type CommandResult,
  composeArgs,
  DOWN_SUBCOMMAND,
  isAllowedMutation,
  IDENTITY_INSPECT_FORMAT,
  mountMismatches,
  parseDockerIdentityInspect,
  parseTestDbArgs,
  readTestDbDockerIdentity,
  runTestDb,
  type TestDbDeps,
  TestDbError,
  type TestDbErrorCode,
  UP_SUBCOMMAND,
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

/** 偽の Docker が返す状態（読み取り系のコマンドの出力）。変更操作（up・down）の後は、afterUp・afterDown に切り替わる */
type DockerState = {
  ps: string;
  labeled: string;
  sameName: string;
  projectVolumes: string;
  volumes: string;
  port: string;
  devContainer: string;
  devVolume: string;
  devUsers: string;
  /** undefined なら、コンテナがない（inspect が失敗する） */
  inspect: string | undefined;
  /** 識別情報の inspect（IDENTITY_INSPECT_FORMAT）の出力。undefined なら失敗する */
  identity?: string | undefined;
};

const DEV_VOLUME_ROW = "katana-web_postgres_data\t2026-07-18T05:42:41Z\tkatana-web\tpostgres_data\n";
/** テストDBのコンテナがない状態（開発用ボリュームと、無名のボリューム1つがある） */
const EMPTY: DockerState = {
  ps: "",
  labeled: "",
  sameName: "",
  projectVolumes: "",
  volumes: "0df3f60a\nkatana-web_postgres_data\n",
  port: "",
  devContainer: "",
  devVolume: DEV_VOLUME_ROW,
  devUsers: "",
  inspect: undefined,
};

const INIT_SOURCE = path.join(ROOT, "docker/test-db/init");
const DATA = "/var/lib/postgresql/data";
/** 実際のマウント（Mounts）の項目 */
const INIT_BIND = { Type: "bind", Source: INIT_SOURCE, Destination: "/docker-entrypoint-initdb.d", Mode: "ro", RW: false, Propagation: "rprivate" };
const DATA_TMPFS = { Type: "tmpfs", Source: "", Destination: DATA, Mode: "", RW: true, Propagation: "" };
/** 作成時の指定（HostConfig.Mounts）の項目 */
const INIT_BIND_SPEC = { Type: "bind", Source: INIT_SOURCE, Target: "/docker-entrypoint-initdb.d", ReadOnly: true };
const DATA_TMPFS_SPEC = { Type: "tmpfs", Target: DATA };

/**
 * docker inspect（CONTAINER_INSPECT_FORMAT）の出力。既定は、Compose の `tmpfs:` の形（ケースA：Mounts には bind だけで、
 * HostConfig.Tmpfs にデータ領域がある）。Config.Volumes には、イメージの VOLUME 宣言（実際のマウントではない）が入る
 */
function inspectJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    project: "katana-test",
    service: "test-db",
    configFiles: path.join(ROOT, "docker-compose.test.yml"),
    workingDir: ROOT,
    state: "running",
    health: "healthy",
    mounts: [INIT_BIND],
    hostMounts: [INIT_BIND_SPEC],
    tmpfs: { [DATA]: "" },
    imageVolumes: { [DATA]: {} },
    ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] },
    ...overrides,
  });
}

/** テストDBのコンテナが起動している状態 */
const RUNNING: DockerState = {
  ...EMPTY,
  ps: '{"Name":"katana-test-db","Service":"test-db","State":"running","Health":"healthy"}\n',
  labeled: "katana-test-db\n",
  sameName: "katana-test-db\tkatana-test\n",
  port: "katana-test-db\n",
  inspect: inspectJson(),
};

type FakeOptions = {
  argv?: string[];
  execArgv?: string[];
  parentEnv?: Record<string, string | undefined>;
  testEnv?: Record<string, string> | undefined;
  config?: string;
  context?: string;
  fail?: { match: string; result: CommandResult };
  state?: Partial<DockerState>;
  afterUp?: Partial<DockerState>;
  afterDown?: Partial<DockerState>;
  image?: boolean;
  /** up の結果（失敗させる場合）。状態は afterUp に切り替わる（失敗してもコンテナが残る場合の再現） */
  upResult?: CommandResult;
  /** docker image inspect postgres:15 の結果のイメージID（既定は sha256:abc） */
  imageId?: string;
};

const isMutation = (args: readonly string[]) => args[0] === "compose" && ["up", "down"].includes(args[9]);

function fake(options: FakeOptions = {}) {
  const logs: string[] = [];
  let state: DockerState = { ...EMPTY, ...options.state };
  const run = vi.fn<TestDbDeps["run"]>(async (_command, args) => {
    const joined = args.join(" ");
    if (options.fail && joined.includes(options.fail.match)) return options.fail.result;
    const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "" });
    if (isMutation(args)) {
      state = args[9] === "up" ? { ...RUNNING, ...options.afterUp } : { ...EMPTY, ...options.afterDown };
      return args[9] === "up" && options.upResult ? options.upResult : ok("");
    }
    if (joined === "context show") return ok(`${options.context ?? "desktop-linux"}\n`);
    if (joined.endsWith("config --quiet")) return ok("");
    if (joined.endsWith("config --format json")) return ok(options.config ?? composeConfig());
    if (joined.endsWith("ps --all --format json")) return ok(state.ps);
    if (joined.startsWith("volume ls --filter label=")) return ok(state.projectVolumes);
    if (joined === "volume ls --format {{.Name}}") return ok(state.volumes);
    if (joined.startsWith("volume inspect")) return ok(state.devVolume);
    if (joined.startsWith("ps --all --filter label=com.docker.compose.project=katana-test")) return ok(state.labeled);
    if (joined.includes("name=^katana-test-db$")) return ok(state.sameName);
    if (joined.includes("name=^katana-db$")) return ok(state.devContainer);
    if (joined.includes("volume=katana-web_postgres_data")) return ok(state.devUsers);
    if (joined.includes("publish=5434")) return ok(state.port);
    if (joined.startsWith("image inspect")) return options.image === false ? { code: 1, stdout: "", stderr: "No such image" } : ok(`${options.imageId ?? "sha256:abc"}\n`);
    if (joined.startsWith("inspect --type container") && joined.includes('"restartCount"')) {
      return state.identity === undefined ? { code: 1, stdout: "", stderr: "No such container" } : ok(state.identity);
    }
    if (joined.startsWith("inspect --type container")) {
      return state.inspect === undefined ? { code: 1, stdout: "", stderr: "No such container" } : ok(state.inspect);
    }
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
  const mutations = () => run.mock.calls.filter(([, args]) => isMutation(args)).map(([, args]) => [...args]);
  return { deps, run, logs, mutations };
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
  it("--check・--status・--up・--down と、--up --apply・--down --apply だけを受け付ける", () => {
    expect(parseTestDbArgs(["--check"])).toEqual({ mode: "check", apply: false });
    expect(parseTestDbArgs(["--status"])).toEqual({ mode: "status", apply: false });
    expect(parseTestDbArgs(["--identity-check"])).toEqual({ mode: "identity", apply: false });
    expect(parseTestDbArgs(["--up"])).toEqual({ mode: "up", apply: false });
    expect(parseTestDbArgs(["--up", "--apply"])).toEqual({ mode: "up", apply: true });
    expect(parseTestDbArgs(["--down"])).toEqual({ mode: "down", apply: false });
    expect(parseTestDbArgs(["--down", "--apply"])).toEqual({ mode: "down", apply: true });
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
    [["--reset"]],
    [["--reset", "--apply"]],
    [["--apply"]],
    [["--apply", "--up"]],
    [["--check", "--apply"]],
    [["--status", "--apply"]],
    [["--identity-check", "--apply"]],
    [["--apply", "--identity-check"]],
    [["--identity-check", "--up"]],
    [["--identity"]],
    [["--up", "--down"]],
    [["--up", "--apply", "--apply"]],
    [["--up", "--APPLY"]],
    [["--up", "-p", "katana-web"]],
    [["--up", "--apply", "-f", "docker-compose.yml"]],
    [["--down", "--volumes"]],
    [["--down", "-v", "--apply"]],
    [["--down", "--apply", "--remove-orphans"]],
    [["--down", "--apply", "--rmi", "all"]],
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
    const f = fake({ argv: ["--status"], state: RUNNING });
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expectOnlyReadOnlyCalls(f.run);
    const output = f.logs.join("\n");
    expect(output).toContain("katana-test-db (running, healthy)");
    expect(output).toContain("development container katana-db (name, id, state): not present");
    expect(output).toContain("katana-web_postgres_data\t2026-07-18T05:42:41Z\tkatana-web\tpostgres_data");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("katana-test プロジェクトに別のコンテナがあれば止まる", async () => {
    await expectStopped(fake({ argv: ["--status"], state: { labeled: "katana-test-db\nkatana-db\n" } }), "STATUS_UNEXPECTED_CONTAINER");
  });
});

describe("up・down の固定のコマンド", () => {
  it("up は、対象のサービスを明示し、依存・ビルド・作り直し・イメージの取得をしない", () => {
    expect([...UP_SUBCOMMAND]).toEqual([
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "120",
      "--no-deps",
      "--no-build",
      "--no-recreate",
      "--pull",
      "never",
      "test-db",
    ]);
    expect(isAllowedMutation(ROOT, composeArgs(ROOT, UP_SUBCOMMAND))).toBe(true);
  });

  it("down は、--volumes・--remove-orphans・--rmi を使わない", () => {
    expect([...DOWN_SUBCOMMAND]).toEqual(["down"]);
    expect(isAllowedMutation(ROOT, composeArgs(ROOT, DOWN_SUBCOMMAND))).toBe(true);
  });

  it.each([
    [["down", "--volumes"]],
    [["down", "-v"]],
    [["down", "--remove-orphans"]],
    [["down", "--rmi", "all"]],
    [["up", "--detach", "--remove-orphans", "test-db"]],
    [["up", "--detach", "--renew-anon-volumes", "test-db"]],
    [["up", "--detach", "--force-recreate", "test-db"]],
    [["up", "--detach", "--build", "test-db"]],
    [["up", "--detach", "--pull", "always", "test-db"]],
    [["up", "--detach"]],
    [["up", "--detach", "--wait", "--wait-timeout", "120", "--no-deps", "--no-build", "--no-recreate", "--pull", "never", "other-service"]],
    [["start"]],
    [["stop"]],
    [["rm", "--force"]],
  ])("katana-test プロジェクトでも、%j は変更操作として許可しない", (subcommand) => {
    expect(isAllowedMutation(ROOT, composeArgs(ROOT, subcommand))).toBe(false);
  });

  it("別のプロジェクト・Composeファイル・作業ディレクトリ・env ファイルの up・down は許可しない", () => {
    const fixed = composeArgs(ROOT, DOWN_SUBCOMMAND);
    const variants = [
      fixed.map((arg) => (arg === "katana-test" ? "katana-web" : arg)),
      fixed.map((arg) => (arg === path.join(ROOT, "docker-compose.test.yml") ? path.join(ROOT, "docker-compose.yml") : arg)),
      fixed.map((arg) => (arg === path.join(ROOT, ".env.test") ? path.join(ROOT, ".env") : arg)),
      composeArgs("/other/katana-web", DOWN_SUBCOMMAND),
      ["compose", "down"],
      ["compose", "-p", "katana-test", "down"],
    ];
    for (const args of variants) expect(isAllowedMutation(ROOT, args)).toBe(false);
  });
});

describe("runTestDb：--up（--apply なし）", () => {
  it("起動前の確認だけを行い、変更操作をしない", async () => {
    const f = fake({ argv: ["--up"] });
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expect(f.mutations()).toEqual([]);
    expectOnlyReadOnlyCalls(f.run);
    const output = f.logs.join("\n");
    expect(output).toContain("dry run; --apply was not given");
    expect(output).toContain(`would run: docker compose (fixed project, file, directory and env file) ${UP_SUBCOMMAND.join(" ")}`);
    expect(output).toContain("katana-web_postgres_data\t2026-07-18T05:42:41Z\tkatana-web\tpostgres_data");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });
});

describe("runTestDb：--up --apply", () => {
  it("すべての確認に通れば、固定のコマンドで1回だけ起動し、起動後の確認を行う", async () => {
    const f = fake({ argv: ["--up", "--apply"] });
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expect(f.mutations()).toEqual([composeArgs(ROOT, UP_SUBCOMMAND)]);
    for (const [command, , options] of f.run.mock.calls) {
      expect(command).toBe("docker");
      expect(options).toMatchObject({ cwd: ROOT, shell: false });
    }
    // 起動の前に、状態の記録とイメージの確認を終えている。起動の後に、状態の記録と inspect を行う
    const calls = f.run.mock.calls.map(([, args]) => args.join(" "));
    const upIndex = calls.findIndex((_call, i) => isMutation(f.run.mock.calls[i][1]));
    expect(calls.slice(0, upIndex).some((call) => call.startsWith("image inspect"))).toBe(true);
    expect(calls.slice(0, upIndex).some((call) => call === "volume ls --format {{.Name}}")).toBe(true);
    expect(calls.slice(upIndex + 1).some((call) => call.startsWith("inspect --type container katana-test-db"))).toBe(true);
    const output = f.logs.join("\n");
    expect(output).toContain("post-up checks: passed");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it.each([
    ["不正な引数", { argv: ["--up", "--apply", "--remove-orphans"] }, "ARGUMENTS_INVALID"],
    ["Node の起動オプション", { execArgv: ["--import", "x"] }, "NODE_EXEC_ARGV_PRESENT"],
    ["NODE_OPTIONS", { parentEnv: { PATH: "/usr/bin", NODE_OPTIONS: "--require x" } }, "NODE_OPTIONS_PRESENT"],
    ["DOCKER_HOST", { parentEnv: { PATH: "/usr/bin", DOCKER_HOST: "tcp://remote:2375" } }, "DOCKER_TARGET_ENV_PRESENT"],
    ["DOCKER_CONTEXT", { parentEnv: { PATH: "/usr/bin", DOCKER_CONTEXT: "remote" } }, "DOCKER_TARGET_ENV_PRESENT"],
    [".env.test がない", { testEnv: undefined }, "TEST_ENV_MISSING"],
    ["見本の値", { testEnv: { ...GOOD_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: "CHANGE_ME_admin_password" } }, "PASSWORD_PLACEHOLDER"],
    ["パスワードの不一致", { testEnv: { ...GOOD_ENV, KATANA_TEST_DB_PASSWORD: "other_pass" } }, "URL_PASSWORD_MISMATCH"],
    ["想定外のキー", { testEnv: { ...GOOD_ENV, COMPOSE_PROJECT_NAME: "katana-web" } }, "TEST_ENV_UNEXPECTED_KEY"],
    ["開発用DBの接続先", { testEnv: { ...GOOD_ENV, DATABASE_URL: DEV_URL } }, "TARGET_REJECTED"],
  ] as const)("%s なら、docker を呼ばずに止まる", async (_label, options, code) => {
    const f = fake({ argv: ["--up", "--apply"], ...(options as FakeOptions) });
    await expectStopped(f, code);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([
    ["別のコンテキスト", { context: "remote-server" }, "DOCKER_CONTEXT_MISMATCH"],
    ["別のプロジェクト名", { config: composeConfig({ top: { name: "katana-web" } }) }, "COMPOSE_CONFIG_MISMATCH"],
    ["開発用ボリュームのマウント", { config: composeConfig({ service: { volumes: [{ type: "volume", source: "katana-web_postgres_data", target: "/var/lib/postgresql/data" }] } }) }, "COMPOSE_CONFIG_MISMATCH"],
    ["トップレベルの volumes", { config: composeConfig({ top: { volumes: { postgres_data: {} } } }) }, "COMPOSE_CONFIG_MISMATCH"],
    ["全インターフェースへの公開", { config: composeConfig({ service: { ports: [{ host_ip: "0.0.0.0", target: 5432, published: "5434" }] } }) }, "COMPOSE_CONFIG_MISMATCH"],
    ["tmpfs なし", { config: composeConfig({ service: { tmpfs: undefined } }) }, "COMPOSE_CONFIG_MISMATCH"],
    [
      "サービスが2つ（不明なサービス）",
      { config: JSON.stringify({ ...JSON.parse(composeConfig()), services: { ...JSON.parse(composeConfig()).services, other: { image: "redis" } } }) },
      "COMPOSE_CONFIG_MISMATCH",
    ],
    ["config の失敗", { fail: { match: "config --quiet", result: { code: 1, stdout: "", stderr: `bad ${ADMIN} ${TEST_URL}` } } }, "DOCKER_COMMAND_FAILED"],
    ["既存のテスト用コンテナ（起動中）", { state: RUNNING }, "TEST_CONTAINER_EXISTS"],
    ["既存のテスト用コンテナ（停止中）", { state: { ...RUNNING, ps: '{"Name":"katana-test-db","Service":"test-db","State":"exited","Health":""}\n', port: "" } }, "TEST_CONTAINER_EXISTS"],
    ["別のプロジェクトの同名コンテナ", { state: { sameName: "katana-test-db\tkatana-web\n" } }, "CONTAINER_NAME_CONFLICT"],
    ["Compose のラベルがない同名コンテナ", { state: { sameName: "katana-test-db\t\n" } }, "CONTAINER_NAME_CONFLICT"],
    ["プロジェクトの別のコンテナ", { state: { labeled: "katana-test-other\n" } }, "UNEXPECTED_CONTAINER"],
    ["不明なサービス", { state: { ps: '{"Name":"katana-test-db","Service":"other","State":"running"}\n', labeled: "katana-test-db\n" } }, "UNEXPECTED_SERVICE"],
    ["プロジェクトのボリューム", { state: { projectVolumes: "katana-test_data\n" } }, "UNEXPECTED_VOLUME"],
    ["5434番を公開している別のコンテナ", { state: { port: "sample-db\n" } }, "PORT_IN_USE"],
    ["イメージがない（取得しない）", { image: false }, "IMAGE_MISSING"],
  ] as const)("%s なら、変更操作に進まずに止まる", async (_label, options, code) => {
    const f = fake({ argv: ["--up", "--apply"], ...(options as FakeOptions) });
    await expectStopped(f, code);
    expect(f.mutations()).toEqual([]);
    expectOnlyReadOnlyCalls(f.run);
  });

  it("起動に失敗したら止まり、stderr のパスワードを伏せ、後片付けの操作をしない", async () => {
    const f = fake({ argv: ["--up", "--apply"], fail: { match: " up --detach", result: { code: 1, stdout: "", stderr: `failed ${ADMIN} ${APP} ${TEST_URL}` } } });
    const error = await expectStopped(f, "DOCKER_COMMAND_FAILED");
    expect(error.message).toContain("(hidden)");
    // 失敗した up の1回だけ（down などを続けて呼ばない）
    expect(f.run.mock.calls.filter(([, args]) => args[0] === "compose" && ["up", "down"].includes(args[9]))).toHaveLength(1);
  });

  it.each([
    ["無名のボリュームが増えた（R7）", { volumes: "0df3f60a\nb1c2d3e4\nkatana-web_postgres_data\n" }, "volumes"],
    ["プロジェクトのボリュームができた", { projectVolumes: "katana-test_data\n" }, "project volumes"],
    ["開発用ボリュームの記録が変わった", { devVolume: "katana-web_postgres_data\t2026-11-03T00:00:00Z\tkatana-web\tpostgres_data\n" }, "development database record"],
    ["開発用コンテナが現れた", { devContainer: "katana-db\tabc123\trunning\n" }, "development database record"],
    ["healthy でない", { ps: '{"Name":"katana-test-db","Service":"test-db","State":"running","Health":"starting"}\n' }, "container state"],
    ["volume 型のマウントがある", { inspect: inspectJson({ mounts: [{ Type: "volume", Name: "b1c2d3e4", Destination: "/var/lib/postgresql/data", RW: true }] }) }, "inspect: no volume mounts"],
    ["tmpfs がない", { inspect: inspectJson({ tmpfs: null }) }, "inspect: tmpfs"],
    ["全インターフェースへの公開", { inspect: inspectJson({ ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5434" }] } }) }, "inspect: ports"],
    ["初期化ディレクトリが書き込み可能", { inspect: inspectJson({ mounts: [{ Type: "bind", Source: path.join(ROOT, "docker/test-db/init"), Destination: "/docker-entrypoint-initdb.d", RW: true }] }) }, "inspect: mounts"],
    ["別のプロジェクトのラベル", { inspect: inspectJson({ project: "katana-web" }) }, "inspect: project label"],
  ])("起動後の確認で %s なら、POST_CHECK_FAILED で止まり、何も削除しない", async (_label, afterUp, item) => {
    const f = fake({ argv: ["--up", "--apply"], afterUp });
    const error = await expectStopped(f, "POST_CHECK_FAILED");
    expect(error.message).toContain(item);
    expect(error.message).toContain("Nothing was removed");
    expect(f.mutations()).toEqual([composeArgs(ROOT, UP_SUBCOMMAND)]);
  });
});

describe("runTestDb：--down", () => {
  it("--apply がなければ、停止前の確認だけを行い、変更操作をしない", async () => {
    const f = fake({ argv: ["--down"], state: RUNNING });
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expect(f.mutations()).toEqual([]);
    expectOnlyReadOnlyCalls(f.run);
    const output = f.logs.join("\n");
    expect(output).toContain("dry run; --apply was not given");
    expect(output).toContain("no --volumes, --remove-orphans or --rmi");
    for (const secret of SECRETS) expect(output).not.toContain(secret);
  });

  it("--apply があれば、固定の down を1回だけ実行し、停止後の確認を行う", async () => {
    const f = fake({ argv: ["--down", "--apply"], state: RUNNING });
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expect(f.mutations()).toEqual([composeArgs(ROOT, DOWN_SUBCOMMAND)]);
    const [downArgs] = f.mutations();
    for (const flag of ["--volumes", "-v", "--remove-orphans", "--rmi"]) expect(downArgs).not.toContain(flag);
    expect(f.logs.join("\n")).toContain("post-down checks: passed");
  });

  it("停止中のテスト用コンテナも、確認に通れば down できる", async () => {
    const stopped = { ...RUNNING, ps: '{"Name":"katana-test-db","Service":"test-db","State":"exited","Health":""}\n', port: "", inspect: inspectJson({ state: "exited", health: null }) };
    const f = fake({ argv: ["--down", "--apply"], state: stopped });
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expect(f.mutations()).toHaveLength(1);
  });

  it("テスト用コンテナがなければ、何もしない（--apply があっても）", async () => {
    const f = fake({ argv: ["--down", "--apply"] });
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expect(f.mutations()).toEqual([]);
    expect(f.logs.join("\n")).toContain("nothing to do");
  });

  it.each([
    ["別のコンテキスト", { context: "remote-server" }, "DOCKER_CONTEXT_MISMATCH"],
    ["別のプロジェクト名", { config: composeConfig({ top: { name: "katana-web" } }) }, "COMPOSE_CONFIG_MISMATCH"],
    ["プロジェクトの別のコンテナ（孤立したコンテナ）", { state: { ...RUNNING, labeled: "katana-test-db\nkatana-test-old\n" } }, "UNEXPECTED_CONTAINER"],
    ["開発用コンテナがプロジェクトにある", { state: { ...RUNNING, labeled: "katana-test-db\nkatana-db\n" } }, "UNEXPECTED_CONTAINER"],
    ["不明なサービス", { state: { ...RUNNING, ps: '{"Name":"katana-test-db","Service":"db","State":"running"}\n' } }, "UNEXPECTED_SERVICE"],
    ["別のプロジェクトの同名コンテナ", { state: { ...RUNNING, sameName: "katana-test-db\tkatana-web\n" } }, "CONTAINER_NAME_CONFLICT"],
    ["プロジェクトのボリューム", { state: { ...RUNNING, projectVolumes: "katana-test_data\n" } }, "UNEXPECTED_VOLUME"],
    ["テスト用コンテナが開発用ボリュームを使っている", { state: { ...RUNNING, devUsers: "katana-test-db\n" } }, "DEVELOPMENT_VOLUME_IN_USE"],
    ["volume 型のマウントがある", { state: { ...RUNNING, inspect: inspectJson({ mounts: [{ Type: "volume", Name: "katana-web_postgres_data", Destination: "/var/lib/postgresql/data", RW: true }] }) } }, "CONTAINER_INSPECT_MISMATCH"],
    ["別のプロジェクトのラベル", { state: { ...RUNNING, inspect: inspectJson({ project: "katana-web" }) } }, "CONTAINER_INSPECT_MISMATCH"],
    ["inspect がJSONでない", { state: { ...RUNNING, inspect: "not json" } }, "CONTAINER_INSPECT_INVALID"],
    ["見本の値", { state: RUNNING, testEnv: { ...GOOD_ENV, KATANA_TEST_DB_PASSWORD: "CHANGE_ME_test_password" } }, "PASSWORD_PLACEHOLDER"],
  ] as const)("%s なら、down に進まずに止まる", async (_label, options, code) => {
    const f = fake({ argv: ["--down", "--apply"], ...(options as FakeOptions) });
    await expectStopped(f, code);
    expect(f.mutations()).toEqual([]);
  });

  it.each([
    ["テスト用コンテナが残っている", { ...RUNNING }, "test container still exists"],
    ["ボリュームが減った", { volumes: "0df3f60a\n" }, "volumes"],
    ["開発用ボリュームの記録が変わった", { devVolume: "" }, "development database record"],
  ])("停止後の確認で %s なら、POST_CHECK_FAILED で止まり、何も作り直さない", async (_label, afterDown, item) => {
    const f = fake({ argv: ["--down", "--apply"], state: RUNNING, afterDown });
    const error = await expectStopped(f, "POST_CHECK_FAILED");
    expect(error.message).toContain(item);
    expect(error.message).toContain("Nothing was recreated");
    expect(f.mutations()).toEqual([composeArgs(ROOT, DOWN_SUBCOMMAND)]);
  });
});

describe("runTestDb：障害時の --down（状態を問わず、同一性を確かめられるコンテナだけを対象にする）", () => {
  /** state・health だけを変えたテスト用コンテナ（ラベル・マウント・ポート・tmpfs は正しい） */
  function testContainer(state: string, health: string | null): DockerState {
    return {
      ...RUNNING,
      ps: JSON.stringify({ Name: "katana-test-db", Service: "test-db", State: state, Health: health ?? "" }) + "\n",
      port: state === "running" ? "katana-test-db\n" : "",
      inspect: inspectJson({ state, health }),
    };
  }

  it.each([
    ["A. 正常に起動済み（healthy）", testContainer("running", "healthy")],
    ["B. 起動途中（starting）", testContainer("running", "starting")],
    ["C. 初期化の失敗（unhealthy）", testContainer("running", "unhealthy")],
    ["D. 停止済み（exited）", testContainer("exited", null)],
    ["作成だけされた（created。ポートの割り当ての失敗など）", testContainer("created", null)],
  ])("%s でも、同一性を確かめられれば down できる", async (_label, state) => {
    const f = fake({ argv: ["--down", "--apply"], state });
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expect(f.mutations()).toEqual([composeArgs(ROOT, DOWN_SUBCOMMAND)]);
  });

  it("E. up がタイムアウトした後に残ったコンテナを認識し、--down で片付けられる（自動では削除しない）", async () => {
    const remnant = testContainer("running", "unhealthy");
    // up --apply：--wait がタイムアウトで失敗し、コンテナは残る。ラッパーは down を呼ばない
    const up = fake({ argv: ["--up", "--apply"], afterUp: remnant, upResult: { code: 1, stdout: "", stderr: "container katana-test-db is unhealthy" } });
    await expectStopped(up, "DOCKER_COMMAND_FAILED");
    expect(up.mutations()).toEqual([composeArgs(ROOT, UP_SUBCOMMAND)]);

    // 次の up は、残ったコンテナを作り直さずに止まる
    await expectStopped(fake({ argv: ["--up", "--apply"], state: remnant }), "TEST_CONTAINER_EXISTS");

    // --status で状態が見え、--down（--apply なし）は変更操作をしない
    const status = fake({ argv: ["--status"], state: remnant });
    await runTestDb(status.deps);
    expect(status.logs.join("\n")).toContain("katana-test-db (running, unhealthy)");
    const dryRun = fake({ argv: ["--down"], state: remnant });
    await runTestDb(dryRun.deps);
    expect(dryRun.mutations()).toEqual([]);

    // --down --apply で片付けられる
    const down = fake({ argv: ["--down", "--apply"], state: remnant });
    await expect(runTestDb(down.deps)).resolves.toBe(0);
    expect(down.mutations()).toEqual([composeArgs(ROOT, DOWN_SUBCOMMAND)]);
  });

  it("停止済みのコンテナも見えるように、コンテナの一覧はすべて --all で読む", async () => {
    const f = fake({ argv: ["--down"], state: testContainer("exited", null) });
    await runTestDb(f.deps);
    const listCalls = f.run.mock.calls.map(([, args]) => args.slice(args[0] === "compose" ? 9 : 0)).filter((sub) => sub[0] === "ps");
    expect(listCalls.length).toBeGreaterThan(0);
    for (const sub of listCalls) expect(sub).toContain("--all");
  });

  it.each([
    ["別のプロジェクトのラベル", { project: "katana-web" }],
    ["プロジェクトのラベルがない", { project: null }],
    ["別のサービスのラベル", { service: "db" }],
    ["別の Compose ファイルから作られた", { configFiles: path.join(ROOT, "docker-compose.yml") }],
    ["複数の Compose ファイルから作られた", { configFiles: `${path.join(ROOT, "docker-compose.test.yml")},${path.join(ROOT, "docker-compose.yml")}` }],
    ["別の作業ディレクトリから作られた", { workingDir: "/other/katana-web" }],
    ["開発用ボリュームをマウントしている", { mounts: [{ Type: "volume", Name: "katana-web_postgres_data", Destination: "/var/lib/postgresql/data", RW: true }] }],
    ["tmpfs がない", { tmpfs: null }],
    ["5433番を公開している", { ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5433" }] } }],
  ])("unhealthy のコンテナでも、%s なら down しない", async (_label, overrides) => {
    const state = { ...testContainer("running", "unhealthy"), inspect: inspectJson({ state: "running", health: "unhealthy", ...overrides }) };
    const f = fake({ argv: ["--down", "--apply"], state });
    const error = await expectStopped(f, "CONTAINER_INSPECT_MISMATCH");
    expect(error.message).not.toContain("/other");
    expect(f.mutations()).toEqual([]);
  });

  it.each([
    ["他のプロジェクトの同名コンテナ（停止済み）", { ...testContainer("exited", null), sameName: "katana-test-db\tkatana-web\n" }, "CONTAINER_NAME_CONFLICT"],
    ["ラベルのない同名コンテナ（停止済み）", { ...EMPTY, sameName: "katana-test-db\t\n" }, "CONTAINER_NAME_CONFLICT"],
    ["他のプロジェクトのコンテナが、ラベルの一覧に混ざっている", { ...testContainer("exited", null), labeled: "katana-test-db\nsample-db\n" }, "UNEXPECTED_CONTAINER"],
    ["不明なサービス（unhealthy）", { ...testContainer("running", "unhealthy"), ps: '{"Name":"katana-test-db","Service":"cache","State":"running","Health":"unhealthy"}\n' }, "UNEXPECTED_SERVICE"],
    ["開発用ボリュームを使っている（exited）", { ...testContainer("exited", null), devUsers: "katana-test-db\n" }, "DEVELOPMENT_VOLUME_IN_USE"],
  ] as const)("%s なら、down を実行しない", async (_label, state, code) => {
    const f = fake({ argv: ["--down", "--apply"], state: state as DockerState });
    await expectStopped(f, code);
    expect(f.mutations()).toEqual([]);
  });

  it("inspect が失敗したら（対象を特定できない）、down を実行しない", async () => {
    const f = fake({ argv: ["--down", "--apply"], state: { ...testContainer("exited", null), inspect: undefined } });
    await expectStopped(f, "DOCKER_COMMAND_FAILED");
    expect(f.mutations()).toEqual([]);
  });

  it.each([
    ["healthy", testContainer("running", "healthy")],
    ["unhealthy", testContainer("running", "unhealthy")],
    ["exited", testContainer("exited", null)],
  ])("--apply がなければ、%s のコンテナでも変更操作をしない", async (_label, state) => {
    const f = fake({ argv: ["--down"], state });
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expect(f.mutations()).toEqual([]);
    expectOnlyReadOnlyCalls(f.run);
  });
});

describe("mountMismatches（tmpfs の表し方の違いと、許可するマウント）", () => {
  const check = (overrides: Record<string, unknown>) => mountMismatches(JSON.parse(inspectJson(overrides)), ROOT);

  it.each([
    ["A. Mounts は bind だけ、HostConfig.Tmpfs にデータ領域", {}],
    ["A'. HostConfig.Mounts がない（null）", { hostMounts: null }],
    ["A''. HostConfig.Tmpfs にマウントのオプションがある", { tmpfs: { [DATA]: "rw,noexec,nosuid,size=65536k" } }],
    ["B. Mounts に Type=tmpfs、HostConfig.Mounts にも同じ指定", { mounts: [INIT_BIND, DATA_TMPFS], hostMounts: [INIT_BIND_SPEC, DATA_TMPFS_SPEC], tmpfs: null }],
    ["B'. Mounts に Type=tmpfs だけ（HostConfig.Tmpfs も HostConfig.Mounts の tmpfs もない）", { mounts: [DATA_TMPFS, INIT_BIND], tmpfs: {} }],
    ["C. Mounts と HostConfig.Tmpfs の両方にデータ領域", { mounts: [INIT_BIND, DATA_TMPFS] }],
    ["Config.Volumes にデータ領域の VOLUME 宣言がある（実際のマウントと混同しない）", { imageVolumes: { [DATA]: {} } }],
    ["Config.Volumes がない", { imageVolumes: null }],
  ])("%s なら許可する", (_label, overrides) => {
    expect(check(overrides)).toEqual([]);
  });

  it.each([
    ["データ領域への volume マウント（無名ボリューム）", { mounts: [INIT_BIND, { Type: "volume", Name: "b1c2d3e4", Destination: DATA, RW: true }] }, "no volume mounts"],
    ["開発用ボリュームのマウント", { mounts: [INIT_BIND, { Type: "volume", Name: "katana-web_postgres_data", Destination: "/data", RW: true }] }, "no volume mounts"],
    ["HostConfig.Mounts の volume 指定", { hostMounts: [INIT_BIND_SPEC, { Type: "volume", Source: "katana-web_postgres_data", Target: DATA }] }, "no volume mounts"],
    ["データ領域への bind", { mounts: [INIT_BIND, { Type: "bind", Source: "/tmp/data", Destination: DATA, RW: true }] }, "mounts: bind mount on the data directory"],
    ["HostConfig.Mounts のデータ領域への bind", { hostMounts: [INIT_BIND_SPEC, { Type: "bind", Source: "/tmp/data", Target: DATA }] }, "mounts: bind mount on the data directory"],
    ["ほかのパスの tmpfs（Mounts）", { mounts: [INIT_BIND, { ...DATA_TMPFS, Destination: "/tmp" }] }, "tmpfs: unknown tmpfs mount"],
    ["ほかのパスの tmpfs（HostConfig.Tmpfs）", { tmpfs: { [DATA]: "", "/run": "" } }, "tmpfs: unknown tmpfs mount"],
    ["データ領域の親ディレクトリの tmpfs", { tmpfs: { "/var/lib/postgresql": "" } }, "tmpfs: unknown tmpfs mount"],
    ["末尾に / が付いたパスの tmpfs", { tmpfs: { [`${DATA}/`]: "" } }, "tmpfs: unknown tmpfs mount"],
    ["ほかの bind", { mounts: [INIT_BIND, { Type: "bind", Source: "/Users/x/.ssh", Destination: "/root/.ssh", RW: false }] }, "mounts: unknown bind mount"],
    ["書き込み可能な初期化用の bind", { mounts: [{ ...INIT_BIND, RW: true }] }, "mounts: unknown bind mount"],
    ["別の場所の初期化用の bind", { mounts: [{ ...INIT_BIND, Source: "/other/init" }] }, "mounts: unknown bind mount"],
    ["初期化用の bind がない", { mounts: [], hostMounts: null }, "mounts: the read-only init bind mount"],
    ["初期化用の bind が2つ", { mounts: [INIT_BIND, INIT_BIND] }, "mounts: the read-only init bind mount"],
    ["不明な種類のマウント", { mounts: [INIT_BIND, { Type: "npipe", Source: "x", Destination: "/x" }] }, "mounts: unknown mount type"],
    ["データ領域の tmpfs が確認できない", { tmpfs: null }, "tmpfs: the data directory tmpfs was not found"],
    ["HostConfig.Tmpfs が空", { tmpfs: {} }, "tmpfs: the data directory tmpfs was not found"],
    ["Mounts のデータ領域の tmpfs が重複", { mounts: [INIT_BIND, DATA_TMPFS, DATA_TMPFS] }, "tmpfs: duplicate data directory entries"],
    ["HostConfig.Tmpfs と HostConfig.Mounts の両方でデータ領域を指定（矛盾）", { mounts: [INIT_BIND, DATA_TMPFS], hostMounts: [INIT_BIND_SPEC, DATA_TMPFS_SPEC] }, "both HostConfig.Tmpfs and HostConfig.Mounts"],
    ["HostConfig.Mounts の tmpfs が Mounts にない（矛盾）", { hostMounts: [INIT_BIND_SPEC, DATA_TMPFS_SPEC], tmpfs: null }, "tmpfs: HostConfig.Mounts and Mounts disagree"],
    ["HostConfig.Mounts の bind が Mounts にない（矛盾）", { mounts: [] }, "mounts: HostConfig.Mounts and Mounts disagree"],
    ["HostConfig.Tmpfs はデータ領域、Mounts は同じパスに volume（矛盾）", { mounts: [INIT_BIND, { Type: "volume", Name: "x", Destination: DATA }] }, "no volume mounts"],
    ["Mounts が配列でない", { mounts: { a: 1 } }, "mounts: Mounts is not a list"],
    ["HostConfig.Tmpfs が対応表でない", { tmpfs: [DATA] }, "tmpfs: HostConfig.Tmpfs is not a map"],
  ])("%s なら拒否する", (_label, overrides, item) => {
    const mismatches = check(overrides);
    expect(mismatches.some((name) => name.includes(item))).toBe(true);
    // 項目名だけを返し、パスなどの値は含めない
    for (const name of mismatches) {
      expect(name).not.toContain("/");
      expect(name).not.toContain("katana-web_postgres_data");
    }
  });
});

describe("runTestDb：tmpfs の表し方の違いを、up の後と down の前の両方で同じように扱う", () => {
  const SHAPES = [
    ["A（HostConfig.Tmpfs）", {}],
    ["B（Mounts と HostConfig.Mounts の tmpfs）", { mounts: [INIT_BIND, DATA_TMPFS], hostMounts: [INIT_BIND_SPEC, DATA_TMPFS_SPEC], tmpfs: null }],
    ["C（Mounts と HostConfig.Tmpfs）", { mounts: [INIT_BIND, DATA_TMPFS] }],
  ] as const;

  it.each(SHAPES)("ケース%s：up の後の確認に通る", async (_label, shape) => {
    const f = fake({ argv: ["--up", "--apply"], afterUp: { inspect: inspectJson(shape) } });
    await expect(runTestDb(f.deps)).resolves.toBe(0);
    expect(f.mutations()).toEqual([composeArgs(ROOT, UP_SUBCOMMAND)]);
  });

  const STATES = [
    ["created", "created", null],
    ["running・healthy", "running", "healthy"],
    ["running・starting", "running", "starting"],
    ["running・unhealthy", "running", "unhealthy"],
    ["exited", "exited", null],
  ] as const;

  for (const [shapeLabel, shape] of SHAPES) {
    it.each(STATES)(`ケース${shapeLabel}・%s：down の前の確認に通り、固定の down を1回だけ実行する`, async (_label, state, health) => {
      const container = {
        ...RUNNING,
        ps: JSON.stringify({ Name: "katana-test-db", Service: "test-db", State: state, Health: health ?? "" }) + "\n",
        port: state === "running" ? "katana-test-db\n" : "",
        inspect: inspectJson({ state, health, ...shape }),
      };
      const f = fake({ argv: ["--down", "--apply"], state: container });
      await expect(runTestDb(f.deps)).resolves.toBe(0);
      expect(f.mutations()).toEqual([composeArgs(ROOT, DOWN_SUBCOMMAND)]);
      // 開発用ボリュームに対しては、読み取り以外のコマンドを実行しない
      for (const [, args] of f.run.mock.calls) {
        if (args.includes("katana-web_postgres_data") || args.some((arg) => arg.includes("volume=katana-web_postgres_data"))) {
          expect(["volume inspect", "ps --all"]).toContain(args.slice(0, 2).join(" "));
        }
      }
    });
  }

  it("upがタイムアウトした後に残った unhealthy のコンテナ（ケースB）も、--down --apply で片付けられる", async () => {
    const remnant = {
      ...RUNNING,
      ps: '{"Name":"katana-test-db","Service":"test-db","State":"running","Health":"unhealthy"}\n',
      inspect: inspectJson({ health: "unhealthy", mounts: [INIT_BIND, DATA_TMPFS], hostMounts: [INIT_BIND_SPEC, DATA_TMPFS_SPEC], tmpfs: null }),
    };
    const up = fake({ argv: ["--up", "--apply"], afterUp: remnant, upResult: { code: 1, stdout: "", stderr: "timeout" } });
    await expectStopped(up, "DOCKER_COMMAND_FAILED");
    const down = fake({ argv: ["--down", "--apply"], state: remnant });
    await expect(runTestDb(down.deps)).resolves.toBe(0);
    expect(down.mutations()).toEqual([composeArgs(ROOT, DOWN_SUBCOMMAND)]);
  });

  it.each([
    ["データ領域への volume マウント", { mounts: [INIT_BIND, { Type: "volume", Name: "b1c2d3e4", Destination: DATA, RW: true }] }, "inspect: no volume mounts"],
    ["データ領域への bind", { mounts: [INIT_BIND, { Type: "bind", Source: "/tmp/data", Destination: DATA, RW: true }] }, "inspect: mounts: bind mount on the data directory"],
    ["不明な tmpfs", { tmpfs: { [DATA]: "", "/run": "" } }, "inspect: tmpfs: unknown tmpfs mount"],
    ["データ領域の tmpfs がない", { tmpfs: null }, "inspect: tmpfs: the data directory tmpfs was not found"],
    ["tmpfs の指定の矛盾", { mounts: [INIT_BIND, DATA_TMPFS], hostMounts: [INIT_BIND_SPEC, DATA_TMPFS_SPEC] }, "inspect: tmpfs: the data directory is specified in both"],
  ])("up の後の確認でも、%s なら POST_CHECK_FAILED で止まり、何も削除しない", async (_label, overrides, item) => {
    const f = fake({ argv: ["--up", "--apply"], afterUp: { inspect: inspectJson(overrides) } });
    const error = await expectStopped(f, "POST_CHECK_FAILED");
    expect(error.message).toContain(item);
    expect(f.mutations()).toEqual([composeArgs(ROOT, UP_SUBCOMMAND)]);
  });

  it.each([
    ["データ領域への volume マウント", { mounts: [INIT_BIND, { Type: "volume", Name: "b1c2d3e4", Destination: DATA, RW: true }] }],
    ["データ領域への bind", { mounts: [INIT_BIND, { Type: "bind", Source: "/tmp/data", Destination: DATA, RW: true }] }],
    ["不明な bind", { mounts: [INIT_BIND, { Type: "bind", Source: "/Users/x", Destination: "/x", RW: true }] }],
    ["不明な tmpfs", { mounts: [INIT_BIND, { ...DATA_TMPFS, Destination: "/tmp" }] }],
    ["データ領域の tmpfs がない", { tmpfs: null }],
    ["tmpfs の指定の矛盾", { hostMounts: [INIT_BIND_SPEC, DATA_TMPFS_SPEC], tmpfs: null }],
  ])("down の前の確認でも、unhealthy・exited のコンテナで %s なら down しない", async (_label, overrides) => {
    for (const [state, health] of [["running", "unhealthy"], ["exited", null]] as const) {
      const container = { ...RUNNING, inspect: inspectJson({ state, health, ...overrides }) };
      const f = fake({ argv: ["--down", "--apply"], state: container });
      await expectStopped(f, "CONTAINER_INSPECT_MISMATCH");
      expect(f.mutations()).toEqual([]);
    }
  });
});

describe("readTestDbDockerIdentity：テストDBのコンテナの識別情報（Step 3-11E。読み取りだけ）", () => {
  const CONTAINER_ID = "a".repeat(64);
  const IMAGE_ID = `sha256:${"b".repeat(64)}`;
  const NETWORK_ID = "c".repeat(64);
  const identityJson = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: CONTAINER_ID,
      image: IMAGE_ID,
      startedAt: "2026-11-06T22:46:49.619782389Z",
      restartCount: 0,
      networkCount: 1,
      network: { id: NETWORK_ID, ip: "172.18.0.2" },
      ...overrides,
    });
  const IDENTIFIED: Partial<DockerState> = { ...RUNNING, identity: identityJson() };
  const identityFake = (state: Partial<DockerState> = {}, options: Partial<FakeOptions> = {}) =>
    fake({ ...options, state: { ...IDENTIFIED, ...state }, imageId: options.imageId ?? IMAGE_ID });

  async function expectIdentityError(f: ReturnType<typeof fake>, code: TestDbErrorCode, item?: string) {
    const error = await readTestDbDockerIdentity(f.deps).then(
      () => {
        throw new Error("expected the identity check to fail");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TestDbError);
    expect((error as TestDbError).code).toBe(code);
    if (item) expect((error as Error).message).toContain(item);
    for (const secret of SECRETS) expect((error as Error).message).not.toContain(secret);
    expect(f.mutations()).toEqual([]);
    expectOnlyReadOnlyCalls(f.run);
    return error as TestDbError;
  }

  it("すべての条件を満たせば、正規化した識別情報を返す（読み取り専用のコマンドだけ。変更操作なし）", async () => {
    const f = identityFake();
    await expect(readTestDbDockerIdentity(f.deps)).resolves.toEqual({
      containerId: CONTAINER_ID,
      imageId: IMAGE_ID,
      startedAt: "2026-11-06T22:46:49.619782389Z",
      restartCount: 0,
      networkId: NETWORK_ID,
      networkIp: "172.18.0.2",
      volumes: ["0df3f60a", "katana-web_postgres_data"],
      developmentVolume: [DEV_VOLUME_ROW.trim()],
      portPublishers: ["katana-test-db"],
    });
    expect(f.mutations()).toEqual([]);
    expectOnlyReadOnlyCalls(f.run);
    // コンテナの inspect は、--type container で対象を限定し、決まった形式だけを使う
    const inspects = f.run.mock.calls.map(([, args]) => args).filter((args) => args[0] === "inspect");
    expect(inspects.map((args) => args.slice(0, 4))).toEqual([
      ["inspect", "--type", "container", "katana-test-db"],
      ["inspect", "--type", "container", "katana-test-db"],
    ]);
  });

  it("識別情報の inspect の形式は、Config.Env・ラベルの値以外の秘密情報になり得る項目を読まない", () => {
    expect(IDENTITY_INSPECT_FORMAT).not.toMatch(/Env|Config\b|Labels|Cmd|Args|Entrypoint/);
    expect(IDENTITY_INSPECT_FORMAT).toContain('index .NetworkSettings.Networks "katana-test_default"');
  });

  it.each<[string, Partial<DockerState>, string]>([
    ["ポートの公開（別のコンテナも5434番を公開）", { port: "katana-test-db\nother\n" }, "port publishers"],
    ["ポートの割り当て", { inspect: inspectJson({ ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5434" }] } }) }, "inspect: ports"],
    ["Compose のラベル", { inspect: inspectJson({ project: "other" }) }, "inspect: project label"],
    ["想定外のマウント", { inspect: inspectJson({ mounts: [INIT_BIND, { Type: "volume", Name: "x", Source: "/v", Destination: DATA, RW: true }] }) }, "inspect: "],
    ["テスト用ボリュームがある", { projectVolumes: "katana-test_data\n" }, "project volumes"],
    ["開発用コンテナ katana-db がある", { devContainer: "katana-db\tabc\trunning\n" }, "development container katana-db"],
    ["開発用ボリュームがない", { devVolume: "", volumes: "0df3f60a\n" }, "development volume"],
    ["開発用ボリュームを使うコンテナがある", { devUsers: "katana-test-db\n" }, "development volume"],
    ["コンテナが unhealthy", { ps: '{"Name":"katana-test-db","Service":"test-db","State":"running","Health":"unhealthy"}\n' }, "container state"],
    ["同じ名前の別プロジェクトのコンテナ", { sameName: "katana-test-db\tother\n" }, "container name"],
  ])("%s なら、DOCKER_IDENTITY_MISMATCH で止まる（項目名だけを表示する）", async (_label, state, item) => {
    await expectIdentityError(identityFake(state), "DOCKER_IDENTITY_MISMATCH", item);
  });

  it("コンテナのイメージが、ローカルの postgres:15 と違えば止まる", async () => {
    await expectIdentityError(identityFake({}, { imageId: `sha256:${"d".repeat(64)}` }), "DOCKER_IDENTITY_MISMATCH", "image");
  });

  it.each<[string, Record<string, unknown>]>([
    ["ネットワークが2つ", { networkCount: 2 }],
    ["既定のネットワークがない", { network: null }],
    ["コンテナIDの形が違う", { id: "abc" }],
    ["起動時刻が読めない", { startedAt: "0001-01-01T00:00:00Z broken" }],
    ["再起動の回数が負", { restartCount: -1 }],
  ])("識別情報の %s なら、CONTAINER_INSPECT_INVALID で止まる", async (_label, overrides) => {
    await expectIdentityError(identityFake({ identity: identityJson(overrides) }), "CONTAINER_INSPECT_INVALID");
  });

  it("コンテナがなければ（inspect が失敗）、DOCKER_COMMAND_FAILED で止まる", async () => {
    await expectIdentityError(identityFake({ ...EMPTY, identity: undefined }), "DOCKER_COMMAND_FAILED");
  });

  it("Docker のコンテキストが違えば、デーモンに問い合わせる前に止まる", async () => {
    const f = identityFake({}, { context: "default" });
    await expectIdentityError(f, "DOCKER_CONTEXT_MISMATCH");
    expect(f.run.mock.calls).toHaveLength(1);
  });

  it("DOCKER_HOST・DOCKER_CONTEXT が設定されていれば、docker を呼ばずに止まる", async () => {
    const f = identityFake({}, { parentEnv: { PATH: "/usr/bin", DOCKER_HOST: "tcp://example:2375" } });
    await expectIdentityError(f, "DOCKER_TARGET_ENV_PRESENT");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("docker のコマンドが失敗したら止まり、stderr の接続URL・パスワードは伏せる", async () => {
    const f = identityFake({}, { fail: { match: "volume ls --format", result: { code: 1, stdout: "", stderr: `daemon error ${TEST_URL} ${ADMIN}` } } });
    await expectIdentityError(f, "DOCKER_COMMAND_FAILED");
  });

  describe("runTestDb：--identity-check（Step 3-11F。読み取りだけ）", () => {
    it("識別情報を表示し、照合の関数にそのまま渡せる JSON を出す（変更操作なし。秘密情報なし）", async () => {
      const f = identityFake({}, { argv: ["--identity-check"] });
      await expect(runTestDb(f.deps)).resolves.toBe(0);
      const output = f.logs.join("\n");
      expect(output).toContain("[testdb] identity-check mode: no container was created, started, stopped or removed, and no database connection was made.");
      expect(output).toContain("container identity checks: passed");
      expect(output).toContain(`container id: ${CONTAINER_ID}`);
      expect(output).toContain(`image id: ${IMAGE_ID}`);
      expect(output).toContain("started at: 2026-11-06T22:46:49.619782389Z");
      expect(output).toContain("restart count: 0");
      expect(output).toContain(`network katana-test_default: id ${NETWORK_ID}, address 172.18.0.2`);
      const json = /^identity json: (.+)$/m.exec(output)?.[1];
      expect(JSON.parse(json ?? "null")).toEqual(await readTestDbDockerIdentity(identityFake().deps));
      for (const secret of SECRETS) expect(output).not.toContain(secret);
      // パスワードの変数は、値を伏せた形（=(hidden; ...)）でだけ現れる
      expect(output).not.toMatch(/(POSTGRES_PASSWORD|KATANA_TEST_DB_PASSWORD|KATANA_TEST_DB_ADMIN_PASSWORD)=(?!\(hidden)/);
      expect(f.mutations()).toEqual([]);
      expectOnlyReadOnlyCalls(f.run);
    });

    it("識別情報の照合に失敗したら止まり、何も変更しない", async () => {
      const f = identityFake({ port: "katana-test-db\nother\n" }, { argv: ["--identity-check"] });
      await expectStopped(f, "DOCKER_IDENTITY_MISMATCH");
      expect(f.mutations()).toEqual([]);
      expect(f.logs).toEqual([]);
    });

    it("コンテナがなければ止まる（起動はしない）", async () => {
      const f = identityFake({ ...EMPTY, identity: undefined }, { argv: ["--identity-check"] });
      await expectStopped(f, "DOCKER_COMMAND_FAILED");
      expect(f.mutations()).toEqual([]);
    });

    it("Compose の構成の照合など、確認モードと同じ事前の検証を先に行う", async () => {
      const f = identityFake({}, { argv: ["--identity-check"], testEnv: { ...GOOD_ENV, KATANA_TEST_DB_PASSWORD: "CHANGE_ME_x" } });
      await expectStopped(f, "PASSWORD_PLACEHOLDER");
      expect(f.run).not.toHaveBeenCalled();
    });

    it("npm の testdb:identity は、--identity-check だけを付けてラッパーを実行する", () => {
      const pkg = JSON.parse(readFileSync(path.join(path.resolve(__dirname, ".."), "package.json"), "utf8")) as { scripts: Record<string, string> };
      expect(pkg.scripts["testdb:identity"]).toBe("node scripts/testdb.mts --identity-check");
    });
  });

  it("parseDockerIdentityInspect は JSON でなければ CONTAINER_INSPECT_INVALID", () => {
    expectCode(() => parseDockerIdentityInspect("not json"), "CONTAINER_INSPECT_INVALID");
  });
});
