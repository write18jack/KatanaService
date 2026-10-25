import { cache } from "react";
import type { UserRole } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

/**
 * 認可に使う、DB由来の現在のユーザー情報。
 * JWT（session）の shopId / role はログイン時点の値で古い可能性があるため、ここには使わない。
 */
export type AuthContext = {
  userId: string;
  shopId: string;
  role: UserRole;
};

/** reason はサーバー内部の判定用。利用者への表示文言にそのまま使わない */
export type AuthResult =
  | { ok: true; context: AuthContext }
  | { ok: false; reason: "UNAUTHENTICATED" | "USER_NOT_FOUND" | "SHOP_INACTIVE" };

async function resolveAuthContext(): Promise<AuthResult> {
  // JWTから信用するのは、DB照合のキーとなる user.id だけ
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return { ok: false, reason: "UNAUTHENTICATED" };
  }

  // DB障害は捕捉しない（例外を伝播させ、古いJWTの値で許可しない）
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      shopId: true,
      role: true,
      shop: { select: { isActive: true } },
    },
  });

  if (!user) {
    return { ok: false, reason: "USER_NOT_FOUND" };
  }

  // 店舗が取得できない場合も安全側に倒して拒否する
  if (user.shop?.isActive !== true) {
    return { ok: false, reason: "SHOP_INACTIVE" };
  }

  return { ok: true, context: { userId: user.id, shopId: user.shopId, role: user.role } };
}

/**
 * 現在のリクエストの認可コンテキストを、DBの最新状態から取得する。
 * React.cache はServer Componentの描画中だけ同一リクエスト内で結果を共有する（リクエストをまたがない）。
 * それ以外の文脈では毎回DBに問い合わせる。
 */
export const getAuthContext = cache(resolveAuthContext);

/** ロールの単純な一致判定（階層関係は定義しない） */
export function hasRole(context: AuthContext, role: UserRole): boolean {
  return context.role === role;
}
