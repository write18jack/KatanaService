"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { KatanaFormFields } from "./KatanaFormFields";

export function KatanaNewRequest() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>刀剣の登録申請</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新規登録申請</DialogTitle>
        </DialogHeader>
        <KatanaFormFields onSuccess={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
