import { auth } from "@/auth";
import { LogoutButton } from "@/components/auth/LogoutButton"; // 作成した場所に合わせて調整
import Link from "next/link";

export default async function Header() {
  const session = await auth();

  return (
    <header className="fixed top-0 z-50 w-full border-b bg-white/80 backdrop-blur-md">
      <div className="container mx-auto flex h-14 items-center justify-between px-4">
        <Link href="/" className="font-bold text-lg">
          Great App
        </Link>

        <div className="flex items-center gap-4">
          {session ? (
            <>
              <span className="text-sm text-neutral-600 hidden sm:inline">
                {session.user?.name}
              </span>
              <LogoutButton />
            </>
          ) : (
            <Link
              href="/login"
              className="text-sm font-medium hover:underline underline-offset-4"
            >
              ログイン
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
