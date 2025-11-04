import { useRouteLoaderData } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { loader as rootLoader } from "../root.tsx";
import { serializeIntoTrpcCompatible, useTRPC } from "../lib/trpc.ts";

export function useSessionUser() {
  const initialSessionData = useRouteLoaderData<typeof rootLoader>("root");
  if (!initialSessionData?.session)
    throw new Error(
      "Session data not found, `useSessionUser` must be used when valid session is guaranteed to exist",
    );
  const trpc = useTRPC();
  const userQuery = useQuery(
    trpc.user.me.queryOptions(void 0, {
      initialData: serializeIntoTrpcCompatible(initialSessionData.session.user),
      // Cookie session cache is valid for 10 minutes, so we can cache it on client for 10 minutes too
      // When user updates their profile, we can invalidate this query
      staleTime: 1000 * 60 * 10,
    }),
  );
  return userQuery.data;
}
