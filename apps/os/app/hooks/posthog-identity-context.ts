import { createContext } from "react";

export type IdentityState = {
  userId: string | null;
  organizationId: string | null;
  projectId: string | null;
};

export const PostHogIdentityContext = createContext<{ current: IdentityState } | null>(null);
