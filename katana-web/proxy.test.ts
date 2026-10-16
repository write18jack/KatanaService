import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ロケール処理（next-intl）は検証対象外のため素通しにする。検証するのはproxy.ts自身の認証リダイレクト判定。
vi.mock("next-intl/middleware", () => ({
  default: () => () => NextResponse.next(),
}));

// auth(handler) はセッションを req.auth に載せて handler を呼ぶラッパー。テストでは req.auth を直接与える。
vi.mock("@/auth", () => ({
  auth: (handler: (req: unknown) => unknown) => handler,
}));

import { JOB_A, PRODUCT_B, SESSION_A, SHOP_B } from "@/lib/testing/tenantFixtures";
import proxy from "./proxy";

type ProxyRequest = NextRequest & { auth: unknown };

function request(path: string, session: unknown = null): ProxyRequest {
  return Object.assign(new NextRequest(new URL(path, "http://localhost:3000")), { auth: session });
}

async function run(path: string, session: unknown = null): Promise<Response> {
  return (await (proxy as unknown as (req: ProxyRequest) => Promise<Response> | Response)(request(path, session)))!;
}

beforeEach(() => {
  // proxy.ts はリクエストごとにパスをログ出力する（F-09）。テスト出力を汚さないよう抑止する。
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("proxy: 未ログインでの保護ページアクセス", () => {
  it.each([
    "/ja/dashboard",
    "/ja/dashboard/products",
    "/ja/dashboard/import",
    `/ja/dashboard/import/${JOB_A.id}`,
    `/ja/dashboard/products/${PRODUCT_B.id}`,
    `/ja/dashboard?shopId=${SHOP_B.id}`,
  ])("%s はログイン画面へリダイレクトされる", async (path) => {
    const response = await run(path);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost:3000/ja/login");
  });

  it("英語ロケールでは英語のログイン画面へリダイレクトされる", async () => {
    const response = await run(`/en/dashboard/import/${JOB_A.id}`);

    expect(response.headers.get("location")).toBe("http://localhost:3000/en/login");
  });

  it("ログイン済みなら保護ページへのアクセスをログイン画面へ戻さない", async () => {
    const response = await run(`/ja/dashboard/import/${JOB_A.id}`, SESSION_A);

    expect(response.headers.get("location")).not.toBe("http://localhost:3000/ja/login");
  });
});
