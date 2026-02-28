"use client";

import { useState } from "react";
import { Katana } from "@prisma/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { createKatanaRequest } from "@/actions/user-katana";
import { toast } from "sonner";
import { KatanaFormFields } from "./KatanaFormFields";

export function KatanaActionButtons({ katana }: { katana: Katana }) {
  const [open, setOpen] = useState(false);

  // 必要なプロパティだけを抽出し、型エラーを回避
  const formattedData = {
    ...katana,
    // katanaType を string から厳格なリテラル型にキャスト
    katanaType: katana.katanaType as "打刀" | "脇差" | "短刀" | "太刀" | "薙刀",
    // era が null の場合は空文字にする (zodのera: z.string().min(1) に合わせる)
    era: katana.era ?? "",
  };

  const onDelete = async () => {
    if (!confirm("本当にこの刀剣の削除申請を送信しますか？")) return;
    const res = await createKatanaRequest("DELETE", katana.id);
    if (res.success) toast.success(res.success);
    else toast.error(res.error);
  };

  return (
    <div className="flex gap-2">
      {/* 編集モーダル */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            修正申請
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>修正申請</DialogTitle>
          </DialogHeader>
          <KatanaFormFields
            initialData={formattedData}
            onSuccess={() => setOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* 削除実行ボタン */}
      <Button variant="destructive" size="sm" onClick={onDelete}>
        削除申請
      </Button>
    </div>
  );
}
