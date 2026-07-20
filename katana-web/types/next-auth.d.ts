import { DefaultSession } from "next-auth";
import { UserRole } from "@prisma/client";

declare module "next-auth" {
  interface User {
    id: string;
    name: string;
    email?: string | null;
    role: UserRole;
    shopId: string;
  }

  interface Session {
    user: DefaultSession["user"] & {
      id: string;
      role: UserRole;
      shopId: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: UserRole;
    shopId: string;
  }
}
