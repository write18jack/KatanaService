"use client";

import { useState } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { KatanaRequest, User, Katana } from "@prisma/client"; // Katanaを追加
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { RequestPreview } from "@/components/admin/RequestPreview";
import {
  approveKatanaRequest,
  rejectKatanaRequest,
} from "@/actions/admin-katana";
import { toast } from "sonner";

// Prismaの型を拡張して、申請者(applicant)と対象刀剣(targetKatana)を含める
// targetKatana に Katana型を具体的に指定することで any エラーを解消
type RequestWithRelations = KatanaRequest & {
  applicant: User;
  targetKatana?: Katana | null;
};

const ActionCell = ({ request }: { request: RequestWithRelations }) => {
  const [open, setOpen] = useState(false);

  const onApprove = async () => {
    const res = await approveKatanaRequest(request.id);
    if (res.success) {
      toast.success(res.success);
      setOpen(false);
    } else {
      toast.error(res.error);
    }
  };

  const onReject = async () => {
    const res = await rejectKatanaRequest(request.id);
    if (res.success) {
      toast.success(res.success);
      setOpen(false);
    } else {
      toast.error(res.error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          内容確認
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>申請内容の確認</DialogTitle>
        </DialogHeader>

        <div className="py-4">
          <RequestPreview
            request={request}
            currentKatana={request.targetKatana}
          />
        </div>

        {request.status === "PENDING" && (
          <DialogFooter className="flex gap-2 sm:justify-end">
            <Button variant="destructive" onClick={onReject}>
              却下する
            </Button>
            <Button variant="default" onClick={onApprove}>
              承認して反映する
            </Button>
          </DialogFooter>
        )}

        {request.status !== "PENDING" && (
          <div className="text-right font-bold text-gray-500">
            ステータス:{" "}
            {request.status === "APPROVED" ? "承認済み" : "却下済み"}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export const columns: ColumnDef<RequestWithRelations>[] = [
  {
    accessorKey: "applicant.name",
    header: "申請者",
    cell: ({ row }) => {
      return <span className="font-medium">{row.original.applicant.name}</span>;
    },
  },
  {
    id: "shopName",
    header: "店舗名",
    accessorFn: (row) => row.shopName,
    cell: ({ row }) => {
      return <span>{row.original.name || "店舗なし"}</span>;
    },
  },
  {
    id: "name",
    header: "銘",
    accessorFn: (row) => row.name,
    cell: ({ row }) => {
      return <span>{row.original.name || "銘なし"}</span>;
    },
  },
  {
    accessorKey: "katanaType",
    header: "種別",
    cell: ({ row }) => row.original.katanaType,
  },
  {
    accessorKey: "price",
    header: "価格",
    cell: ({ row }) => {
      const price = row.original.price;
      return price ? `¥${price.toLocaleString()}` : "¥0";
    },
  },
  {
    accessorKey: "crudType",
    header: "申請種別",
    cell: ({ row }) => {
      const type = row.original.crudType;
      const typeLabels: Record<string, string> = {
        CREATE: "新規登録",
        UPDATE: "内容変更",
        DELETE: "削除申請",
      };
      return typeLabels[type] || type;
    },
  },
  {
    accessorKey: "status",
    header: "ステータス",
    cell: ({ row }) => {
      const status = row.original.status;
      const statusLabels: Record<string, string> = {
        PENDING: "未承認",
        APPROVED: "承認済",
        REJECTED: "却下済",
      };
      return statusLabels[status] || status;
    },
  },
  {
    id: "actions",
    header: "操作",
    cell: ({ row }) => {
      return <ActionCell request={row.original} />;
    },
  },
];
