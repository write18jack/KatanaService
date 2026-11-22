"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { markProductAsSold } from "@/actions/products/markSold";

type MarkSoldDialogProps = {
  productId: string;
  productCode: string;
  productTitle: string;
};

export default function MarkSoldDialog({
  productId,
  productCode,
  productTitle,
}: MarkSoldDialogProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const handleConfirm = () => {
    startTransition(async () => {
      const result = await markProductAsSold(productId);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success(result.success ?? "商品を販売済みにしました。");
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline">販売済みにする</Button>
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>この商品を販売済みにしますか？</AlertDialogTitle>

          <AlertDialogDescription>
            商品コード: {productCode}
            <br />
            品名: {productTitle}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>キャンセル</AlertDialogCancel>

          <AlertDialogAction onClick={handleConfirm} disabled={isPending}>
            {isPending ? "処理中..." : "販売済みにする"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
