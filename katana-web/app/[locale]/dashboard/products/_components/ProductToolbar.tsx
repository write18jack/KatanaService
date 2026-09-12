"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Plus, Upload } from "lucide-react";

export default function ProductToolbar() {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-3xl font-bold">商品一覧</h1>

        <p className="text-muted-foreground mt-1">
          商品の登録・編集・削除を行います。
        </p>
      </div>

      <div className="flex gap-2">
        <Button asChild variant="outline">
          <Link href="/dashboard/import">
            <Upload className="mr-2 h-4 w-4" />
            Excel/CSV取込
          </Link>
        </Button>

        <Button asChild>
          <Link href="/dashboard/products/create">
            <Plus className="mr-2 h-4 w-4" />
            商品登録
          </Link>
        </Button>
      </div>
    </div>
  );
}
