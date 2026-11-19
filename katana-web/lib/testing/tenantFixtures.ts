/**
 * 店舗間認可テスト専用のモックデータ（2店舗）。
 * 実DBのID・認証情報は使わない。本体コードからは参照しない。
 */

export const SHOP_A = { id: "shop-avocado", name: "アボガド店" } as const;
export const SHOP_B = { id: "shop-hikouyoku", name: "日光浴" } as const;

export const USER_A = { id: "user-avocado", shopId: SHOP_A.id, role: "ADMIN", name: "テストユーザーA" } as const;
export const USER_B = { id: "user-hikouyoku", shopId: SHOP_B.id, role: "ADMIN", name: "テストユーザーB" } as const;

/** auth() が返すセッションの形（Auth.js v5 / types/next-auth.d.ts） */
export function sessionOf(user: typeof USER_A | typeof USER_B) {
  return {
    user: { id: user.id, shopId: user.shopId, role: user.role, name: user.name, email: null },
    expires: "2099-01-01T00:00:00.000Z",
  };
}

export const SESSION_A = sessionOf(USER_A);
export const SESSION_B = sessionOf(USER_B);

export const PRODUCT_A = { id: "product-avocado-001", shopId: SHOP_A.id, productCode: "TEST-001" } as const;
export const PRODUCT_B = { id: "product-hikouyoku-001", shopId: SHOP_B.id, productCode: "TEST-001" } as const;

export const JOB_A = { id: "job-avocado-001", shopId: SHOP_A.id, fileName: "avocado-secret.csv" } as const;
export const JOB_B = { id: "job-hikouyoku-001", shopId: SHOP_B.id, fileName: "hikouyoku-secret.csv" } as const;

export const ROW_A = { id: "row-avocado-001", importJobId: JOB_A.id } as const;
export const ROW_B = { id: "row-hikouyoku-001", importJobId: JOB_B.id } as const;

export const MISSING_ID = "00000000-0000-4000-8000-000000000000";
