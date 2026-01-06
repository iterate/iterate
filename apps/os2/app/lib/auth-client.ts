import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";

const getBaseURL = () => {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return import.meta.env.VITE_PUBLIC_URL || "http://localhost:5173";
};

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
  fetchOptions: { throw: true },
  plugins: [emailOTPClient()],
});

export const { signIn, signOut, useSession } = authClient;
