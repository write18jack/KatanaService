"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/form-error";
import { confirmImport } from "@/actions/product-import/confirm";

type Props = {
  importJobId: string;
  disabled?: boolean;
};

export default function ImportConfirmButton({ importJobId, disabled }: Props) {
  const [error, setError] = useState<string>();
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const handleConfirm = () => {
    setError(undefined);
    startTransition(async () => {
      const result = await confirmImport(importJobId);
      if (result.error) {
        setError(result.error);
        return;
      }
      toast.success(result.success ?? "取込を確定しました。");
      router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <Button onClick={handleConfirm} disabled={isPending || disabled}>
        {isPending ? "確定中..." : "この内容で取り込む"}
      </Button>
      <FormError title="エラー" message={error} />
    </div>
  );
}
