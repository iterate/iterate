import { createContext, useContext } from "react";
import type { SessionResponse } from "@iterate-com/auth/client";

export type AuthClientContextValue = {
  session: SessionResponse | null;
  loading: boolean;
  signIn: () => void;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
};

export const AuthClientContext = createContext<AuthClientContextValue | null>(null);

export function useAuthClient() {
  const value = useContext(AuthClientContext);
  if (!value) {
    throw new Error("useAuthClient must be used within AuthClientProvider.");
  }
  return value;
}
