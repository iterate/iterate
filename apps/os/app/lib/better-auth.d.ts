import "better-auth";

declare module "better-auth/types" {
  interface Session {
    impersonatedBy?: string | null;
  }
  interface User {
    role?: string | null;
    banned?: boolean | null;
    banReason?: string | null;
    banExpires?: Date | null;
  }
}
