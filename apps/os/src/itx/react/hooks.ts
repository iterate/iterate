// TanStack Query over the itx handle — the thin bridge for data that isn't
// stream-shaped (lists, settings). The typed handle IS the contract: there is
// no generated client, queryFn just receives a connected handle.
//
//   const rootState = useItxQuery({
//     project: projectSlug,
//     queryKey: itxKey.project(projectSlug, "streams", "state", "/"),
//     queryFn: (itx) => itx.streams.get("/").getState(),
//   });
//
//   const create = useItxMutation({
//     project: projectSlug,
//     mutationFn: (itx, input: { streamPath: string }) => itx.streams.create(input),
//   });

import {
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { RpcStub } from "capnweb";
import type { Itx } from "../handle.ts";
import { useItxClient } from "./context.ts";
import { isItxAccessError } from "./errors.ts";

/** A connected handle as queryFn/mutationFn receive it. */
export type ItxHandle = RpcStub<Itx>;

/**
 * Query-key conventions for itx-backed data. Invalidate by prefix, so keep
 * keys hierarchical: ["itx", "project", slug, domain, ...rest].
 */
export const itxKey = {
  project: (projectSlugOrId: string, ...parts: readonly unknown[]): QueryKey => [
    "itx",
    "project",
    projectSlugOrId,
    ...parts,
  ],
};

export type UseItxQueryOptions<TData> = Omit<
  UseQueryOptions<TData, Error, TData, QueryKey>,
  "queryFn"
> & {
  /** The project context the queryFn's handle is narrowed to. */
  project: string;
  queryFn: (itx: ItxHandle) => Promise<TData>;
};

export function useItxQuery<TData>(options: UseItxQueryOptions<TData>): UseQueryResult<TData> {
  const client = useItxClient();
  const { project, queryFn, ...queryOptions } = options;
  return useQuery({
    // Access failures (forbidden/not-found) can't be retried away — surface
    // them immediately instead of holding the pending state through retries.
    retry: (failureCount, error) => !isItxAccessError(error) && failureCount < 1,
    ...queryOptions,
    queryFn: async () => await queryFn(await client.project(project)),
  });
}

export type UseItxMutationOptions<TData, TVariables> = Omit<
  UseMutationOptions<TData, Error, TVariables>,
  "mutationFn"
> & {
  /** The project context the mutationFn's handle is narrowed to. */
  project: string;
  mutationFn: (itx: ItxHandle, variables: TVariables) => Promise<TData>;
};

export function useItxMutation<TData, TVariables = void>(
  options: UseItxMutationOptions<TData, TVariables>,
): UseMutationResult<TData, Error, TVariables> {
  const client = useItxClient();
  const { project, mutationFn, ...mutationOptions } = options;
  return useMutation({
    ...mutationOptions,
    mutationFn: async (variables) => await mutationFn(await client.project(project), variables),
  });
}
