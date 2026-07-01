import { auth } from "@/auth";
import { LogoutButton } from "@/components/auth/LogoutButton"; // 作成した場所に合わせて調整
import Link from "next/link";

export default async function Header() {
  const session = await auth();

  return (
    <header className="fixed top-0 z-50 h-14 w-full bg-yellow-500/30">
      <div className="flex h-full w-full items-center justify-between px-8">
        <Link href="/" className="text-lg font-bold">
          Great App
        </Link>

        <div className="flex items-center gap-4">
          {session ? (
            <>
              <span className="hidden text-sm text-neutral-600 sm:inline">
                {session.user?.name}
              </span>
              <LogoutButton />
            </>
          ) : (
            <Link
              href="/login"
              className="text-sm font-medium underline-offset-4 hover:underline"
            >
              ログイン
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
