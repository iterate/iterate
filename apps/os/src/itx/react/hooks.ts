// TanStack Query over the itx handle — the thin bridge for data that isn't
// stream-shaped (lists, settings). The typed handle IS the contract: there is
// no generated client, queryFn just receives a connected handle.
//
//   const streams = useItxQuery({
//     project: projectSlug,
//     queryKey: itxKey.project(projectSlug, "streams", "list"),
//     queryFn: (itx) => itx.streams.list(),
//   });
//
//   const create = useItxMutation({
//     project: projectSlug,
//     mutationFn: (itx, input: { streamPath: string }) => itx.streams.create(input),
//     invalidates: [itxKey.project(projectSlug, "streams")],
//   });

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryKey,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { RpcStub } from "capnweb";
import type { Itx } from "../handle.ts";
import { useItxClient } from "./provider.tsx";

/** A connected handle as queryFn/mutationFn receive it. */
export type ItxHandle = RpcStub<Itx>;

/**
 * Query-key conventions for itx-backed data. Mutations invalidate by prefix,
 * so keep keys hierarchical: ["itx", "project", slug, domain, ...rest].
 */
export const itxKey = {
  global: (...parts: readonly unknown[]): QueryKey => ["itx", "global", ...parts],
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
  /** Narrow to this project's context; omit for the global handle. */
  project?: string;
  queryFn: (itx: ItxHandle) => Promise<TData>;
};

export function useItxQuery<TData>(options: UseItxQueryOptions<TData>): UseQueryResult<TData> {
  const client = useItxClient();
  const { project, queryFn, ...queryOptions } = options;
  return useQuery({
    ...queryOptions,
    queryFn: async () => {
      const itx = await (project === undefined ? client.itx() : client.project(project));
      return await queryFn(itx);
    },
  });
}

export type UseItxMutationOptions<TData, TVariables> = Omit<
  UseMutationOptions<TData, Error, TVariables>,
  "mutationFn"
> & {
  /** Narrow to this project's context; omit for the global handle. */
  project?: string;
  mutationFn: (itx: ItxHandle, variables: TVariables) => Promise<TData>;
  /** Query-key prefixes invalidated after a successful mutation. */
  invalidates?: readonly QueryKey[];
};

export function useItxMutation<TData, TVariables = void>(
  options: UseItxMutationOptions<TData, TVariables>,
): UseMutationResult<TData, Error, TVariables> {
  const client = useItxClient();
  const queryClient = useQueryClient();
  const { project, mutationFn, invalidates, onSuccess, ...mutationOptions } = options;
  return useMutation({
    ...mutationOptions,
    mutationFn: async (variables) => {
      const itx = await (project === undefined ? client.itx() : client.project(project));
      return await mutationFn(itx, variables);
    },
    onSuccess: async (data, variables, mutateResult, context) => {
      await Promise.all(
        (invalidates ?? []).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      await onSuccess?.(data, variables, mutateResult, context);
    },
  });
}
