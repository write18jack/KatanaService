import { auth } from "@/auth";
import { redirect } from "next/navigation";

export default async function DashboardPage() {
  const session = await auth();
  const role = session?.user.role;

  if (!session) {
    redirect("/auth/login");
  }

  if (role === "admin") {
    redirect("/dashboard/admin");
  }

  redirect("/dashboard/user");
}
