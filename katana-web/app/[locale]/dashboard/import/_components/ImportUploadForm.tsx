"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/form-error";
import { validateImport } from "@/actions/product-import/validate";

export default function ImportUploadForm() {
  const [error, setError] = useState<string>();
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const handleSubmit = (formData: FormData) => {
    setError(undefined);
    startTransition(async () => {
      const result = await validateImport(formData);
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.importJobId) {
        router.push(`/dashboard/import/${result.importJobId}`);
      }
    });
  };

  return (
    <form action={handleSubmit} className="max-w-xl space-y-4 rounded-lg border p-6">
      <div className="space-y-2">
        <label htmlFor="file" className="text-sm font-medium">
          取込ファイル（.xlsx / .csv）
        </label>
        <input
          id="file"
          name="file"
          type="file"
          accept=".xlsx,.xls,.csv"
          required
          className="border-input block w-full rounded-md border px-3 py-2 text-sm"
        />
      </div>

      <FormError title="エラー" message={error} />

      <Button type="submit" disabled={isPending}>
        {isPending ? "検証中..." : "検証してプレビュー"}
      </Button>
    </form>
  );
}
