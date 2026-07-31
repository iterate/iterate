import { createServerFn } from "@tanstack/react-start";

type AuthSnapshot = {
  authenticated: boolean;
  isAdmin: boolean;
  email?: string;
};

export const fetchAuthSnapshot: () => Promise<AuthSnapshot> = createServerFn({
  method: "GET",
}).handler(async ({ context }): Promise<AuthSnapshot> => {
  const principal = context.principal ?? null;
  return {
    authenticated: principal !== null,
    isAdmin: principal?.isAdmin ?? false,
    email: principal?.email,
  };
});
