import { createContext, useContext } from "react";
import type { SessionResponse } from "@iterate-com/auth/client";

type AuthenticatedSessionResponse = Extract<SessionResponse, { authenticated: true }>;

export type OsSessionResponse =
  | { authenticated: false }
  | {
      authenticated: true;
      user: AuthenticatedSessionResponse["user"];
      session: AuthenticatedSessionResponse["session"];
    };

export type AuthClientContextValue = {
  session: OsSessionResponse | null;
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
