"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logout } from "@/actions/auth/logout";
import { useTranslations } from "next-intl";

export function LogoutButton() {
  const t = useTranslations("Auth");
  return (
    <form action={logout}>
      <Button variant="outline" type="submit" className="gap-2">
        <LogOut className="size-4" />
        {t("logout")}
      </Button>
    </form>
  );
}
