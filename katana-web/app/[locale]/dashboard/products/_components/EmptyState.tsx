"use client";

import Link from "next/link";
import { PackageSearch } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed py-20">
      <PackageSearch className="mb-4 h-16 w-16 text-gray-400" />

      <h2 className="text-xl font-semibold">商品が登録されていません</h2>

      <p className="text-muted-foreground mt-2 text-center">
        商品を登録するとここに一覧表示されます。
      </p>

      <div className="mt-8 flex gap-3">
        <Button asChild>
          <Link href="/dashboard/products/create">商品登録</Link>
        </Button>

        <Button variant="outline" asChild>
          <Link href="/dashboard/import">Excel/CSV取込</Link>
        </Button>
      </div>
    </div>
  );
}
