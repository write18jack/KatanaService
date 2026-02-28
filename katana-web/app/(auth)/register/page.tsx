"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { registerSchema, RegisterInput } from "@/actions/auth-schema";
import { registerUser } from "@/actions/register";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import Link from "next/link";
import { FormError } from "@/components/form-error";
import { ChevronLeft } from "lucide-react";

export default function RegisterPage() {
  const [error, setError] = useState<string | undefined>("");
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
    },
  });

  const onSubmit = async (values: RegisterInput) => {
    setError("");
    startTransition(async () => {
      const res = await registerUser(values);
      if (res.error) {
        setError(res.error);
        toast.error(res.error);
      } else {
        toast.success(res.success);
        router.push("/login");
      }
    });
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center bg-gray-50">
      {/* 戻るリンクを画面左上に絶対配置 */}
      <div className="absolute top-8 left-8">
        {/* トップに戻るリンク */}
        <Button variant="ghost" asChild className="p-0 hover:bg-transparent">
          <Link
            href="/"
            className="text-muted-foreground hover:text-primary flex items-center gap-1"
          >
            <ChevronLeft className="h-4 w-4" />
            <span>トップページへ戻る</span>
          </Link>
        </Button>
      </div>

      <div className="mt-32 w-full max-w-md px-4">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <Card className="shadow-xl">
              <CardHeader>
                <CardTitle className="text-center text-2xl font-bold">
                  新規アカウント登録
                </CardTitle>
                <CardDescription className="text-center">
                  必要事項を入力して登録してください
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>ユーザー名</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="山田太郎"
                          disabled={isPending}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>メールアドレス</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="example@mail.com"
                          disabled={isPending}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>パスワード</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          placeholder="******"
                          disabled={isPending}
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
              {error && <FormError title="登録失敗" message={error} />}
              <CardFooter className="flex flex-col gap-4">
                <Button className="w-full" disabled={isPending}>
                  {isPending ? "登録中..." : "登録する"}
                </Button>
                <p className="text-muted-foreground text-center text-sm">
                  既にアカウントをお持ちですか？{" "}
                  <Link href="/login" className="text-primary hover:underline">
                    ログイン
                  </Link>
                </p>
              </CardFooter>
            </Card>
          </form>
        </Form>
      </div>
    </div>
  );
}
