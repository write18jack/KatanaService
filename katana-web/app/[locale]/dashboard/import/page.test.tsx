import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => {
  /** redirect() は例外で処理を打ち切る。テストでは遷移先を持つ例外として観測する */
  class RedirectSignal extends Error {
    constructor(
      readonly href: string,
      readonly locale: string,
    ) {
      super(`NEXT_REDIRECT:/${locale}${href}`);
    }
  }
  return { RedirectSignal, locale: "ja" };
});

vi.mock("next-intl/server", () => ({
  getLocale: async () => nav.locale,
}));

vi.mock("@/i18n/navigation", () => ({
  redirect: vi.fn(({ href, locale }: { href: string; locale: string }) => {
    throw new nav.RedirectSignal(href, locale);
  }),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/auth/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/context")>();
  return { ...actual, getAuthContext: vi.fn() };
});

// アップロードフォームが参照するServer Action（validateImport）経由でも実DBに触れないようにする
vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@/actions/product-import/validate", () => ({
  validateImport: vi.fn(),
}));

import { auth, signOut } from "@/auth";
import { redirect } from "@/i18n/navigation";
import { getAuthContext } from "@/lib/auth/context";
import { validateImport } from "@/actions/product-import/validate";
import { SHOP_A, USER_A } from "@/lib/testing/tenantFixtures";
import ImportUploadForm from "./_components/ImportUploadForm";
import ImportPage from "./page";

const mockedAuthContext = vi.mocked(getAuthContext);

function containsElement(node: ReactNode, type: unknown): boolean {
  if (Array.isArray(node)) return node.some((child) => containsElement(child, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return false;
  return node.type === type || containsElement(node.props.children, type);
}

async function redirectTarget(render: Promise<unknown>) {
  const error = await render.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(nav.RedirectSignal);
  const signal = error as InstanceType<typeof nav.RedirectSignal>;
  return `/${signal.locale}${signal.href}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedAuthContext.mockReset();
  nav.locale = "ja";
});

describe("CSV取り込み画面: DB由来の認可（F-01-D）", () => {
  it("有効な店舗のユーザーにはアップロードフォームを表示する", async () => {
    mockedAuthContext.mockResolvedValue({ ok: true, context: { userId: USER_A.id, shopId: SHOP_A.id, role: "STORE" } });

    const tree = await ImportPage();

    expect(containsElement(tree, ImportUploadForm)).toBe(true);
    expect(mockedAuthContext).toHaveBeenCalledTimes(1);
    expect(auth).not.toHaveBeenCalled();
  });

  it("未ログインならフォームを表示せず、ログイン画面へ遷移する", async () => {
    mockedAuthContext.mockResolvedValue({ ok: false, reason: "UNAUTHENTICATED" });

    await expect(redirectTarget(ImportPage())).resolves.toBe("/ja/login");
  });

  it.each([
    ["無効店舗", "SHOP_INACTIVE"],
    ["削除済みユーザー", "USER_NOT_FOUND"],
  ] as const)("%sはフォームを表示せず、アクセス停止画面へ遷移する（自動ログアウトしない）", async (_label, reason) => {
    mockedAuthContext.mockResolvedValue({ ok: false, reason });

    await expect(redirectTarget(ImportPage())).resolves.toBe("/ja/access-suspended");

    expect(validateImport).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("英語ロケールでは英語のアクセス停止画面へ遷移する", async () => {
    nav.locale = "en";
    mockedAuthContext.mockResolvedValue({ ok: false, reason: "SHOP_INACTIVE" });

    await expect(redirectTarget(ImportPage())).resolves.toBe("/en/access-suspended");
  });

  it("認可の確認（DB障害など）が例外なら、フォームを表示せず、停止画面にも誘導しない", async () => {
    mockedAuthContext.mockRejectedValue(new Error("db down"));

    await expect(ImportPage()).rejects.toThrow("db down");

    expect(redirect).not.toHaveBeenCalled();
  });
});
