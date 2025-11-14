import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useTRPC } from "../lib/trpc.ts";

const routeApi = getRouteApi("__root__");
export function useSessionUser() {
  const initialSessionData = routeApi.useLoaderData();
  if (!initialSessionData?.session)
    throw new Error(
      "Session data not found, `useSessionUser` must be used when valid session is guaranteed to exist",
    );
  const trpc = useTRPC();
  const userQuery = useQuery(
    trpc.user.me.queryOptions(void 0, {
      initialData: {
        ...initialSessionData.session.user,
        createdAt: initialSessionData.session.user.createdAt.toISOString(),
        updatedAt: initialSessionData.session.user.updatedAt.toISOString(),
        banExpires: initialSessionData.session.user.banExpires?.toISOString(),
      },
      // Cookie session cache is valid for 10 minutes, so we can cache it on client for 10 minutes too
      // When user updates their profile, we can invalidate this query
      staleTime: 1000 * 60 * 10,
    }),
  );
  return userQuery.data;
}
