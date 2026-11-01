import { describe, expect, it } from "vitest";
import {
  assertTestDatabaseTarget,
  TEST_DATABASE_TARGET,
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
