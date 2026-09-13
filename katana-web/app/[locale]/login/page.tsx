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

import Link from "next/link";

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
import { credentialsLogin } from "@/actions/auth/login";
import { FormError } from "@/components/form-error";
import { useState, useTransition } from "react";
import { ChevronLeft } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

const Page: NextPage = () => {
  const t = useTranslations("Login");
  const locale = useLocale();
  const [error, setError] = useState<string | undefined>("");
  const [isPending, startTransition] = useTransition();

  const form = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  async function onSubmit(values: LoginForm) {
    setError("");
    startTransition(async () => {
      const result = await credentialsLogin(values, locale);

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
          <Link href={`/${locale}`}>
            <ChevronLeft className="h-4 w-4" />
            <span>{t("backToTop")}</span>
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
                  {t("title")}
                </CardTitle>
                <CardDescription className="text-center">
                  {t("description")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{t("email")}</FormLabel>
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
                      <FormLabel>{t("password")}</FormLabel>
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
                  <FormError
                    title={t("error.invalidCredentials")}
                    message={error}
                  />
                </div>
              )}
              <CardFooter className="flex flex-col gap-4">
                <Button className="h-11 w-full text-lg" disabled={isPending}>
                  {isPending ? t("authenticating") : t("submit")}
                </Button>

                <div className="text-muted-foreground text-center text-sm">
                  {t("noAccount")}{" "}
                  <Link
                    href="/register"
                    className="text-primary font-semibold hover:underline"
                  >
                    {t("registerHere")}
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
