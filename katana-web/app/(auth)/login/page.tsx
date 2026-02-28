"use client";

import type { NextPage } from "next";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { Input } from "@/components/ui/input";
import { useForm } from "react-hook-form";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

import { zodResolver } from "@hookform/resolvers/zod";
import { LoginForm, loginSchema } from "@/types/login-form";
import { credentialsLogin } from "@/actions/login";
import { FormError } from "@/components/form-error";
import { useState, useTransition } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";

const Page: NextPage = () => {
  const [error, setError] = useState<string | undefined>("");
  const [isPending, startTransition] = useTransition();

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      username: "",
      password: "",
    },
  });

  async function onSubmit(values: LoginForm) {
    setError("");
    startTransition(async () => {
      const result = await credentialsLogin(values);

      if (result === null) {
        return;
      }
      setError(result);
    });
  }

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

      {/* ログインフォームを中央上部に配置 (mt-24〜32程度で調整) */}
      <div className="mt-32 w-full max-w-md px-4">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <Card className="shadow-xl">
              <CardHeader>
                <CardTitle className="text-center text-2xl font-bold">
                  ログイン
                </CardTitle>
                <CardDescription className="text-center">
                  ユーザー名/パスワードによるログイン
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="username"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>ユーザー名</FormLabel>
                      <FormControl>
                        <Input disabled={isPending} {...field} />
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
                          disabled={isPending}
                          type="password"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </CardContent>
              {error && (
                <div className="px-6 pb-4">
                  <FormError title="ログイン失敗" message={error} />
                </div>
              )}
              <CardFooter className="flex flex-col gap-4">
                <Button className="h-11 w-full text-lg" disabled={isPending}>
                  {isPending ? "認証中..." : "ログイン"}
                </Button>
                <div className="text-muted-foreground text-center text-sm">
                  アカウントをお持ちでないですか？{" "}
                  <Link
                    href="/register"
                    className="text-primary font-semibold hover:underline"
                  >
                    新規登録はこちら
                  </Link>
                </div>
              </CardFooter>
            </Card>
          </form>
        </Form>
      </div>
    </div>
  );
};

export default Page;
