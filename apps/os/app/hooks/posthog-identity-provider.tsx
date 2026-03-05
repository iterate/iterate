import { useRef } from "react";
import { PostHogIdentityContext, type IdentityState } from "./posthog-identity-context.ts";

export function PostHogIdentityProvider({ children }: { children: React.ReactNode }) {
  const stateRef = useRef<IdentityState>({
    userId: null,
    organizationId: null,
    projectId: null,
  });

  return (
    <PostHogIdentityContext.Provider value={stateRef}>{children}</PostHogIdentityContext.Provider>
  );
}
