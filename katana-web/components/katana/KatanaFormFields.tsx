"use client";

import { useMemo } from "react";
import { useForm, SubmitHandler, Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { Button } from "@/components/ui/button";
import { katanaSchema, type KatanaInput } from "@/actions/katana-schema";
import { createKatanaRequest } from "@/actions/user-katana";
import { toast } from "sonner";

interface KatanaFormFieldsProps {
  initialData?: (KatanaInput & { id: string }) | null;
  onSuccess?: () => void;
}

export function KatanaFormFields({
  initialData,
  onSuccess,
}: KatanaFormFieldsProps) {
  const isEdit = !!initialData;

  // 🎯 defaultValues を useMemo で安定化
  const defaultValues = useMemo<KatanaInput>(() => {
    if (initialData) {
      return {
        shopName: initialData.shopName,
        name: initialData.name,
        katanaType: initialData.katanaType,
        era: initialData.era,
        price: initialData.price,
      };
    }

    return {
      shopName: "",
      name: "",
      katanaType: "打刀",
      era: "",
      price: 0,
    };
  }, [initialData]);

  const resolver = zodResolver(katanaSchema) as Resolver<
    KatanaInput,
    unknown,
    KatanaInput
  >;
  const form = useForm<KatanaInput>({
    resolver,
    defaultValues,
  });

  const onSubmit: SubmitHandler<KatanaInput> = async (values) => {
    const res = isEdit
      ? await createKatanaRequest("UPDATE", initialData!.id, values)
      : await createKatanaRequest("CREATE", values);

    if (res.success) {
      toast.success(res.success);
      onSuccess?.();
      form.reset(defaultValues); // 編集時は元の値、新規時は空に戻す
    } else {
      toast.error(res.error);
    }
  };

  const types = katanaSchema.shape.katanaType.options;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* 店舗名 */}
          <FormField
            control={form.control}
            name="shopName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>店舗名</FormLabel>
                <FormControl>
                  <Input placeholder="店舗名" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* 銘 */}
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>銘</FormLabel>
                <FormControl>
                  <Input placeholder="例: 備前長船兼光" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* 種別 */}
          <FormField
            control={form.control}
            name="katanaType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>種別</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="選択" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {types.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* 時代 */}
          <FormField
            control={form.control}
            name="era"
            render={({ field }) => (
              <FormItem>
                <FormLabel>時代</FormLabel>
                <FormControl>
                  <Input
                    placeholder="例: 室町時代（自由入力）"
                    {...field}
                    value={field.value ?? ""}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* 価格 */}
          <FormField
            control={form.control}
            name="price"
            render={({ field }) => (
              <FormItem>
                <FormLabel>価格 (円)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    {...field}
                    onChange={(e) => {
                      const value = e.target.valueAsNumber;
                      field.onChange(
                        Number.isFinite(value) ? value : undefined,
                      );
                    }}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <Button type="submit" className="w-full">
          {isEdit ? "変更を申請" : "申請を送信"}
        </Button>
      </form>
    </Form>
  );
}
