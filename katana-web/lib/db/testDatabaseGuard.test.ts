import { describe, expect, it } from "vitest";
import {
  assertIntegrationRuntime,
  assertTestDatabaseCredentials,
  assertTestDatabaseTarget,
  INTEGRATION_FORBIDDEN_ENV_KEYS,
  IntegrationRuntimeError,
  type IntegrationRuntimeInput,
  TEST_DATABASE_TARGET,
  TestDatabaseCredentialsError,
  type TestDatabaseCredentialsErrorCode,
  TestDatabaseGuardError,
  type TestDatabaseGuardErrorCode,
  type TestDatabaseGuardInput,
} from "./testDatabaseGuard";

/** 純粋関数の単体テスト（DBには接続しない）。URLはすべてダミー値 */
const PASSWORD = "s3cr3t-dummy-pass";
const DEV_URL = "postgresql://user:dev-dummy-pass@localhost:5433/katana";

type UrlParts = { scheme: string; user: string; password: string; host: string; port: string; database: string; suffix: string };

/** 部品を1つだけ差し替えたURLを作る（文字列置換による取り違えを避ける） */
function testUrl(overrides: Partial<UrlParts> = {}): string {
  const p: UrlParts = {
    scheme: "postgresql",
    user: "katana_test_user",
    password: PASSWORD,
    host: "127.0.0.1",
    port: ":5434",
    database: "/katana_test",
    suffix: "",
    ...overrides,
  };
  const credentials = p.password === "" ? p.user : `${p.user}:${p.password}`;
  return `${p.scheme}://${credentials}@${p.host}${p.port}${p.database}${p.suffix}`;
}

const TEST_URL = testUrl();

function input(overrides: Partial<TestDatabaseGuardInput> = {}): TestDatabaseGuardInput {
  return { databaseUrl: TEST_URL, env: {}, developmentDatabaseUrl: DEV_URL, ...overrides };
}

/** 指定したコードで拒否され、メッセージにパスワードとURL全文が含まれないこと */
function expectRejected(value: TestDatabaseGuardInput, code: TestDatabaseGuardErrorCode) {
  let caught: unknown;
  try {
    assertTestDatabaseTarget(value);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(TestDatabaseGuardError);
  const error = caught as TestDatabaseGuardError;
  expect(error.code).toBe(code);
  for (const secret of [PASSWORD, "dev-dummy-pass", value.databaseUrl, value.developmentDatabaseUrl]) {
    if (secret) expect(error.message).not.toContain(secret);
  }
}

describe("assertTestDatabaseTarget", () => {
  describe("許可", () => {
    it("正しいテストDBのURLを許可し、パスワードを含まない接続先を返す", () => {
      expect(TEST_URL).toBe(`postgresql://katana_test_user:${PASSWORD}@127.0.0.1:5434/katana_test`);
      const target = assertTestDatabaseTarget(input());
      expect(target).toEqual({ host: "127.0.0.1", port: "5434", database: "katana_test", user: "katana_test_user" });
      expect(JSON.stringify(target)).not.toContain(PASSWORD);
    });

    it("ホストが localhost でも許可する", () => {
      const target = assertTestDatabaseTarget(input({ databaseUrl: testUrl({ host: "localhost" }) }));
      expect(target.host).toBe("localhost");
    });

    it("postgres: スキームも許可する", () => {
      expect(() => assertTestDatabaseTarget(input({ databaseUrl: testUrl({ scheme: "postgres" }) }))).not.toThrow();
    });

    it("開発用DBのURLが渡されない（.env がない）場合も、条件を満たせば許可する", () => {
      expect(() => assertTestDatabaseTarget(input({ developmentDatabaseUrl: undefined }))).not.toThrow();
    });

    it("値が undefined の環境変数は、設定されていないものとして扱う", () => {
      expect(() => assertTestDatabaseTarget(input({ env: { PGHOST: undefined, DOTENV_CONFIG_PATH: undefined } }))).not.toThrow();
    });

    it("無関係の環境変数は許可する", () => {
      expect(() => assertTestDatabaseTarget(input({ env: { NODE_ENV: "test", VITEST: "true", PATH: "/usr/bin" } }))).not.toThrow();
    });

    it("許可する接続先の定数", () => {
      expect(TEST_DATABASE_TARGET).toEqual({
        hosts: ["127.0.0.1", "localhost"],
        port: "5434",
        database: "katana_test",
        user: "katana_test_user",
      });
    });
  });

  describe("URLの欠落・形式", () => {
    it("URLが未設定なら拒否する", () => {
      expectRejected(input({ databaseUrl: undefined }), "URL_MISSING");
    });

    it("URLが空文字なら拒否する", () => {
      expectRejected(input({ databaseUrl: "" }), "URL_MISSING");
    });

    it.each([
      "not a url",
      "katana_test",
      "127.0.0.1:5434/katana_test",
      "://katana_test_user@127.0.0.1:5434/katana_test",
      testUrl({ host: "" }),
      testUrl({ host: "::1" }),
    ])("URLとして解析できない値（%s）を拒否する", (databaseUrl) => {
      expectRejected(input({ databaseUrl }), "URL_INVALID");
    });

    it("前後や途中に空白・改行を含むURLを拒否する", () => {
      expectRejected(input({ databaseUrl: ` ${TEST_URL}` }), "URL_INVALID");
      expectRejected(input({ databaseUrl: `${TEST_URL}\n` }), "URL_INVALID");
      expectRejected(input({ databaseUrl: testUrl({ user: "katana_test\t_user" }) }), "URL_INVALID");
    });

    it.each(["mysql", "http", "https", "postgresqlx"])("PostgreSQL以外のスキーム（%s:）を拒否する", (scheme) => {
      expectRejected(input({ databaseUrl: testUrl({ scheme }) }), "SCHEME_NOT_POSTGRES");
    });

    it("認証情報やポートを持てないスキーム（file:）は、解析の段階で拒否する", () => {
      expectRejected(input({ databaseUrl: testUrl({ scheme: "file" }) }), "URL_INVALID");
    });
  });

  describe("接続先", () => {
    it("開発用DBのURLそのものを拒否する", () => {
      expectRejected(input({ databaseUrl: DEV_URL }), "PORT_NOT_ALLOWED");
    });

    it.each(["[::1]", "0.0.0.0", "katana-test-db", "db.example.com", "127.0.0.2", "LOCALHOST", "127.0.0.1,localhost"])(
      "許可していないホスト（%s）を拒否する",
      (host) => {
        expectRejected(input({ databaseUrl: testUrl({ host }) }), "HOST_NOT_ALLOWED");
      },
    );

    it("IPv6のループバック（[::1]）は、URLとして解析できても許可しない", () => {
      const databaseUrl = "postgresql://katana_test_user:password@[::1]:5434/katana_test";
      const url = new URL(databaseUrl);
      expect(url.hostname).toBe("[::1]");
      expect(url.port).toBe("5434");

      // expectRejected はURL全文を含まないことを確かめる。このURLのパスワード "password" も別に確かめる
      expectRejected(input({ databaseUrl }), "HOST_NOT_ALLOWED");
      try {
        assertTestDatabaseTarget(input({ databaseUrl }));
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).not.toContain("password");
      }
    });

    it("ポート5433を拒否する", () => {
      expectRejected(input({ databaseUrl: testUrl({ port: ":5433" }) }), "PORT_NOT_ALLOWED");
    });

    it.each([":5432", ":15434", ":54340"])("5434以外のポート（%s）を拒否する", (port) => {
      expectRejected(input({ databaseUrl: testUrl({ port }) }), "PORT_NOT_ALLOWED");
    });

    it("ポートの省略を拒否する", () => {
      expectRejected(input({ databaseUrl: testUrl({ port: "" }) }), "PORT_NOT_ALLOWED");
    });

    it("DB名 katana を拒否する", () => {
      expectRejected(input({ databaseUrl: testUrl({ database: "/katana" }) }), "DATABASE_NOT_ALLOWED");
    });

    it.each(["/katana_test2", "/Katana_test", "/katana_test/", "/katana%5Ftest", "/", ""])(
      "DB名が正確に katana_test でなければ拒否する（%s）",
      (database) => {
        expectRejected(input({ databaseUrl: testUrl({ database }) }), "DATABASE_NOT_ALLOWED");
      },
    );

    it("DBユーザー user を拒否する", () => {
      expectRejected(input({ databaseUrl: testUrl({ user: "user" }) }), "USER_NOT_ALLOWED");
    });

    it.each(["postgres", "katana_test_user2", "Katana_test_user", "katana%5Ftest_user"])(
      "許可していないユーザー（%s）を拒否する",
      (user) => {
        expectRejected(input({ databaseUrl: testUrl({ user }) }), "USER_NOT_ALLOWED");
      },
    );

    it("ユーザーの省略を拒否する", () => {
      expectRejected(input({ databaseUrl: "postgresql://127.0.0.1:5434/katana_test" }), "USER_NOT_ALLOWED");
    });

    it("パスワードがなければ拒否する", () => {
      expectRejected(input({ databaseUrl: testUrl({ password: "" }) }), "PASSWORD_MISSING");
    });

    it("パスワードが空なら拒否する", () => {
      expectRejected(input({ databaseUrl: "postgresql://katana_test_user:@127.0.0.1:5434/katana_test" }), "PASSWORD_MISSING");
    });

    it.each(["?host=/tmp", "?host=localhost&port=5433", "?sslmode=disable", "?", "#fragment"])(
      "クエリパラメータ・フラグメント（%s）を拒否する",
      (suffix) => {
        expectRejected(input({ databaseUrl: testUrl({ suffix }) }), "QUERY_NOT_ALLOWED");
      },
    );
  });

  describe("開発用DBとの比較", () => {
    it("開発用DBのURLと完全に一致すれば拒否する", () => {
      expectRejected(input({ developmentDatabaseUrl: TEST_URL }), "MATCHES_DEVELOPMENT_DATABASE");
    });

    it("開発用DBが同じホスト・ポート・DB名を指していれば、ユーザーやパスワードが違っても拒否する", () => {
      expectRejected(
        input({ developmentDatabaseUrl: "postgresql://someone:other-pass@127.0.0.1:5434/katana_test" }),
        "MATCHES_DEVELOPMENT_DATABASE",
      );
    });

    it("localhost と 127.0.0.1 の違いだけなら同じ接続先とみなして拒否する", () => {
      expectRejected(
        input({ developmentDatabaseUrl: "postgresql://someone:other-pass@localhost:5434/katana_test" }),
        "MATCHES_DEVELOPMENT_DATABASE",
      );
    });

    it("開発用DBのURLが解析できなければ、比較できないので拒否する", () => {
      expectRejected(input({ developmentDatabaseUrl: "not a url" }), "DEVELOPMENT_URL_INVALID");
    });
  });

  describe("環境変数", () => {
    it.each(["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGSERVICE", "PGHOSTADDR", "PGSERVICEFILE", "PGPASSWORD", "PGOPTIONS"])(
      "PG系の環境変数（%s）があれば拒否する",
      (key) => {
        expectRejected(input({ env: { [key]: "value" } }), "PG_ENV_PRESENT");
      },
    );

    it("PG系の環境変数は、値が空文字でも拒否する", () => {
      expectRejected(input({ env: { PGHOST: "" } }), "PG_ENV_PRESENT");
    });

    it.each(["DOTENV_CONFIG_PATH", "DOTENV_CONFIG_OVERRIDE", "DOTENV_CONFIG_ENCODING", "DOTENV_KEY"])(
      "dotenv系の環境変数（%s）があれば拒否する",
      (key) => {
        expectRejected(input({ env: { [key]: "value" } }), "DOTENV_ENV_PRESENT");
      },
    );

    it("エラーメッセージには変数名だけを含め、値を含めない", () => {
      const value = "postgresql://user:leak-me@localhost:5433/katana";
      try {
        assertTestDatabaseTarget(input({ env: { PGSERVICE: value } }));
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toContain("PGSERVICE");
        expect((error as Error).message).not.toContain("leak-me");
      }
    });
  });
});

describe("assertTestDatabaseCredentials（R14）", () => {
  const ADMIN = "admin-dummy-pass_2";
  const GOOD = { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN };

  /** 指定したコードで拒否され、メッセージ・detail・文字列化した結果に、パスワードとURLが含まれないこと */
  function expectCredentialsRejected(testEnv: Record<string, string | undefined>, code: TestDatabaseCredentialsErrorCode) {
    let caught: unknown;
    try {
      assertTestDatabaseCredentials(testEnv);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TestDatabaseCredentialsError);
    const error = caught as TestDatabaseCredentialsError;
    expect(error.code).toBe(code);
    const secrets = [PASSWORD, ADMIN, TEST_URL, "postgresql://", ...Object.values(testEnv)].filter((value): value is string => !!value);
    for (const text of [error.message, error.detail, String(error)]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  }

  it("正しい設定なら、検証済みの2つのパスワードを返す", () => {
    expect(assertTestDatabaseCredentials(GOOD)).toEqual({ appPassword: PASSWORD, adminPassword: ADMIN });
  });

  it("assertTestDatabaseTarget() と同じ正しいURLを、両方の関数が受け付ける", () => {
    expect(() => assertTestDatabaseTarget(input({ databaseUrl: GOOD.DATABASE_URL }))).not.toThrow();
    expect(() => assertTestDatabaseCredentials(GOOD)).not.toThrow();
  });

  it.each([
    ["DATABASE_URL がない", undefined],
    ["DATABASE_URL が空", ""],
    ["URLとして解析できない", "not a url"],
    ["空白を含む", `${TEST_URL} `],
  ])("%s なら拒否する", (_label, databaseUrl) => {
    expectCredentialsRejected({ ...GOOD, DATABASE_URL: databaseUrl }, "URL_INVALID");
  });

  it.each([
    ["アプリ用がない", { KATANA_TEST_DB_PASSWORD: undefined }, "APP_PASSWORD_MISSING"],
    ["アプリ用が空", { KATANA_TEST_DB_PASSWORD: "" }, "APP_PASSWORD_MISSING"],
    ["管理用がない", { KATANA_TEST_DB_ADMIN_PASSWORD: undefined }, "ADMIN_PASSWORD_MISSING"],
    ["管理用が空", { KATANA_TEST_DB_ADMIN_PASSWORD: "" }, "ADMIN_PASSWORD_MISSING"],
  ] as const)("%s なら拒否する", (_label, override, code) => {
    expectCredentialsRejected({ ...GOOD, ...override }, code);
  });

  it("キーの名前は大文字・小文字を区別する（小文字のキーは、ないものとして拒否する）", () => {
    expectCredentialsRejected(
      { DATABASE_URL: TEST_URL, katana_test_db_password: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN },
      "APP_PASSWORD_MISSING",
    );
  });

  it.each([
    ["見本の値をそのままコピー", "CHANGE_ME_test_password", "CHANGE_ME_test_password", "CHANGE_ME_admin_password"],
    ["URLだけ見本の値", "CHANGE_ME_test_password", PASSWORD, ADMIN],
    ["アプリ用だけ見本の値（URLとも不一致）", PASSWORD, "change_me", ADMIN],
    ["管理用だけ見本の値", PASSWORD, PASSWORD, "CHANGE_ME_admin_password"],
    ["小文字・区切りなし", PASSWORD, PASSWORD, "my-changeme-pw"],
    ["大文字・ハイフン区切り", "CHANGE-ME", "CHANGE-ME", ADMIN],
  ])("%s なら拒否する（不一致より先に検査する）", (_label, urlPassword, appPassword, adminPassword) => {
    expectCredentialsRejected(
      { DATABASE_URL: testUrl({ password: urlPassword }), KATANA_TEST_DB_PASSWORD: appPassword, KATANA_TEST_DB_ADMIN_PASSWORD: adminPassword },
      "PASSWORD_PLACEHOLDER",
    );
  });

  it.each([
    ["パーセントエンコードした表記", "app%5Fpass", "app_pass"],
    ["記号", "p@ss!word", "p@ss!word"],
    ["空白", "pass word", "pass word"],
  ])("URLのパスワードが%sなら拒否する", (_label, urlPassword, appPassword) => {
    // new URL() が受け付ける形にしたうえで、使える文字以外を含むものを拒否する
    const databaseUrl = `postgresql://katana_test_user:${encodeURIComponent(urlPassword).replace(/%25/g, "%")}@127.0.0.1:5434/katana_test`;
    expectCredentialsRejected({ ...GOOD, DATABASE_URL: databaseUrl, KATANA_TEST_DB_PASSWORD: appPassword }, "PASSWORD_CHARSET");
  });

  it("管理用のパスワードが使えない文字を含めば拒否する", () => {
    expectCredentialsRejected({ ...GOOD, KATANA_TEST_DB_ADMIN_PASSWORD: "admin;pass" }, "PASSWORD_CHARSET");
  });

  it("URLのパスワードとアプリ用のパスワードが違えば拒否する（1文字の違い・大文字小文字の違いも）", () => {
    expectCredentialsRejected({ ...GOOD, KATANA_TEST_DB_PASSWORD: `${PASSWORD}x` }, "URL_PASSWORD_MISMATCH");
    expectCredentialsRejected({ ...GOOD, KATANA_TEST_DB_PASSWORD: PASSWORD.toUpperCase() }, "URL_PASSWORD_MISMATCH");
  });

  it("管理用のパスワードがアプリ用と同じなら拒否する", () => {
    expectCredentialsRejected({ ...GOOD, KATANA_TEST_DB_ADMIN_PASSWORD: PASSWORD }, "ADMIN_PASSWORD_SAME_AS_APP");
  });
});

describe("assertIntegrationRuntime（R14-1。接続前の検証）", () => {
  const ADMIN = "admin-dummy-pass_3";
  const GOOD_TEST_ENV = { DATABASE_URL: TEST_URL, KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN };
  /** runner が子プロセスに設定する環境変数と同じ形（値はすべてダミー） */
  const GOOD_ENV = { PATH: "/usr/bin", NODE_ENV: "test", DATABASE_URL: TEST_URL, KATANA_DB_TEST_MODE: "integration", KATANA_TEST_RUNNER: "script" };

  function runtime(overrides: { env?: Record<string, string | undefined>; testEnv?: Record<string, string | undefined> | undefined } = {}): IntegrationRuntimeInput {
    return {
      env: { ...GOOD_ENV, ...overrides.env },
      testEnv: "testEnv" in overrides ? overrides.testEnv : GOOD_TEST_ENV,
      developmentDatabaseUrl: DEV_URL,
    };
  }

  /** 指定した種類・コードで拒否され、メッセージ・文字列化した結果にパスワードと接続URLが含まれないこと */
  function expectRuntimeRejected(value: IntegrationRuntimeInput, errorClass: new (...args: never[]) => Error, code: string) {
    let caught: unknown;
    try {
      assertIntegrationRuntime(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(errorClass);
    expect((caught as { code: string }).code).toBe(code);
    const urls = [value.env.DATABASE_URL, value.testEnv?.DATABASE_URL, DEV_URL];
    const passwords = [PASSWORD, ADMIN, "dev-dummy-pass", value.testEnv?.KATANA_TEST_DB_PASSWORD, value.testEnv?.KATANA_TEST_DB_ADMIN_PASSWORD];
    const secrets = [...urls, ...passwords, "postgresql://"].filter((v): v is string => !!v);
    for (const text of [(caught as Error).message, String(caught)]) {
      for (const secret of secrets) expect(text).not.toContain(secret);
    }
  }

  it("runner と同じ条件を満たせば、表示してよい接続先の情報を返す", () => {
    expect(assertIntegrationRuntime(runtime())).toEqual({ host: "127.0.0.1", port: "5434", database: "katana_test", user: "katana_test_user" });
  });

  it("禁止する環境変数は NODE_OPTIONS（PG*・DOTENV_* は接続先の検証で拒否する）", () => {
    expect(INTEGRATION_FORBIDDEN_ENV_KEYS).toEqual(["NODE_OPTIONS"]);
  });

  describe("起動経路", () => {
    it.each([
      ["実行モードがない", { KATANA_DB_TEST_MODE: undefined }, "TEST_MODE_MISSING"],
      ["実行モードが unit", { KATANA_DB_TEST_MODE: "unit" }, "TEST_MODE_MISSING"],
      ["runner の目印がない", { KATANA_TEST_RUNNER: undefined }, "RUNNER_MARKER_MISSING"],
      ["runner の目印が違う", { KATANA_TEST_RUNNER: "manual" }, "RUNNER_MARKER_MISSING"],
      ["NODE_OPTIONS がある", { NODE_OPTIONS: "--require ./x.js" }, "FORBIDDEN_ENV_PRESENT"],
    ])("%s なら拒否する", (_label, env, code) => {
      expectRuntimeRejected(runtime({ env }), IntegrationRuntimeError, code);
    });

    it("目印がなければ、.env.test がなくても、接続先が開発用DBでも、先に目印で拒否する", () => {
      expectRuntimeRejected(runtime({ env: { KATANA_TEST_RUNNER: undefined, DATABASE_URL: DEV_URL }, testEnv: undefined }), IntegrationRuntimeError, "RUNNER_MARKER_MISSING");
    });

    it("空の NODE_OPTIONS は runner と同じく許可する", () => {
      expect(() => assertIntegrationRuntime(runtime({ env: { NODE_OPTIONS: "" } }))).not.toThrow();
    });
  });

  describe(".env.test と DATABASE_URL", () => {
    it(".env.test がなければ拒否する", () => {
      expectRuntimeRejected(runtime({ testEnv: undefined }), IntegrationRuntimeError, "TEST_ENV_MISSING");
    });

    it(".env.test に DATABASE_URL がなければ拒否する", () => {
      expectRuntimeRejected(runtime({ testEnv: { ...GOOD_TEST_ENV, DATABASE_URL: undefined } }), IntegrationRuntimeError, "TEST_ENV_URL_MISSING");
    });

    it("プロセスの DATABASE_URL が、テストDBを指していても .env.test の値と違えば拒否する（親から渡された別の値を使わない）", () => {
      const other = testUrl({ password: "other-dummy-pass" });
      expectRuntimeRejected(runtime({ env: { DATABASE_URL: other } }), IntegrationRuntimeError, "DATABASE_URL_MISMATCH");
    });

    it("ホスト名の表記だけが違っても（127.0.0.1 と localhost）、完全一致ではないので拒否する", () => {
      expectRuntimeRejected(runtime({ env: { DATABASE_URL: testUrl({ host: "localhost" }) } }), IntegrationRuntimeError, "DATABASE_URL_MISMATCH");
    });

    it.each([
      ["DB名が違う", testUrl({ database: "/katana" }), "DATABASE_NOT_ALLOWED"],
      ["ポートが違う", testUrl({ port: ":5433" }), "PORT_NOT_ALLOWED"],
      ["ユーザーが違う", testUrl({ user: "katana" }), "USER_NOT_ALLOWED"],
      ["開発用DBの URL", DEV_URL, "PORT_NOT_ALLOWED"],
    ])("プロセスの DATABASE_URL の%s場合は、接続先の検証で拒否する", (_label, url, code) => {
      expectRuntimeRejected(runtime({ env: { DATABASE_URL: url }, testEnv: { ...GOOD_TEST_ENV, DATABASE_URL: url } }), TestDatabaseGuardError, code);
    });

    it("PG*・DOTENV_* が設定されていれば、接続先の検証で拒否する", () => {
      expectRuntimeRejected(runtime({ env: { PGHOST: "db.example.com" } }), TestDatabaseGuardError, "PG_ENV_PRESENT");
      expectRuntimeRejected(runtime({ env: { DOTENV_CONFIG_PATH: ".env" } }), TestDatabaseGuardError, "DOTENV_ENV_PRESENT");
    });
  });

  describe(".env.test のパスワード", () => {
    it("見本の値のままなら拒否する", () => {
      const url = testUrl({ password: "CHANGE_ME_test_password" });
      const testEnv = { DATABASE_URL: url, KATANA_TEST_DB_PASSWORD: "CHANGE_ME_test_password", KATANA_TEST_DB_ADMIN_PASSWORD: "CHANGE_ME_admin_password" };
      expectRuntimeRejected(runtime({ env: { DATABASE_URL: url }, testEnv }), TestDatabaseCredentialsError, "PASSWORD_PLACEHOLDER");
    });

    it("管理用のパスワードをアプリ用と共用していれば拒否する", () => {
      expectRuntimeRejected(runtime({ testEnv: { ...GOOD_TEST_ENV, KATANA_TEST_DB_ADMIN_PASSWORD: PASSWORD } }), TestDatabaseCredentialsError, "ADMIN_PASSWORD_SAME_AS_APP");
    });

    it.each([
      ["アプリ用のパスワードがない", { KATANA_TEST_DB_PASSWORD: undefined }, "APP_PASSWORD_MISSING"],
      ["管理用のパスワードがない", { KATANA_TEST_DB_ADMIN_PASSWORD: undefined }, "ADMIN_PASSWORD_MISSING"],
      ["URL とアプリ用のパスワードが違う", { KATANA_TEST_DB_PASSWORD: `${PASSWORD}x` }, "URL_PASSWORD_MISMATCH"],
    ])("%s なら拒否する", (_label, override, code) => {
      expectRuntimeRejected(runtime({ testEnv: { ...GOOD_TEST_ENV, ...override } }), TestDatabaseCredentialsError, code);
    });

    it("プロセスの環境変数にパスワードがあっても使わない（.env.test の値だけを検証する）", () => {
      const env = { KATANA_TEST_DB_PASSWORD: PASSWORD, KATANA_TEST_DB_ADMIN_PASSWORD: ADMIN };
      expectRuntimeRejected(runtime({ env, testEnv: { DATABASE_URL: TEST_URL } }), TestDatabaseCredentialsError, "APP_PASSWORD_MISSING");
    });
  });

  it("入力を変更しない", () => {
    const value = runtime();
    const snapshot = JSON.stringify(value);
    assertIntegrationRuntime(value);
    expect(JSON.stringify(value)).toBe(snapshot);
  });
});
