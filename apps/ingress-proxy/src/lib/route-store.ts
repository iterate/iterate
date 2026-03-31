import {
  GetRouteInput,
  IngressProxyRoute,
  ListRoutesInput,
  ListRoutesOutput,
  RemoveRouteInput,
  rootHostSchema,
  routeMetadataSchema,
  targetUrlSchema,
  UpsertRouteInput,
} from "@iterate-com/ingress-proxy-contract";
import { typeid } from "@iterate-com/shared/typeid";
import type { z } from "zod";
import {
  countRoutes,
  deleteRouteByRootHost,
  selectRouteByRootHost,
  selectRouteCandidatesByRootHosts,
  selectRoutesPage,
  upsertRouteByRootHost,
  type CountRoutesResult,
  type SelectRouteByRootHostResult,
  type SelectRouteCandidatesByRootHostsResult,
  type SelectRoutesPageResult,
} from "../../sql/queries.ts";
import {
  deriveCandidateRootHosts,
  normalizeRootHost,
  normalizeTargetUrl,
  RouteInputError,
} from "~/lib/proxy.ts";

type RouteRow =
  | SelectRouteByRootHostResult
  | SelectRouteCandidatesByRootHostsResult
  | SelectRoutesPageResult;

function parseMetadataJson(value: string): z.infer<typeof routeMetadataSchema> {
  try {
    return routeMetadataSchema.parse(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new RouteInputError("metadata must be a JSON object");
    }

    if (error instanceof Error) {
      throw new RouteInputError(error.message);
    }

    throw new RouteInputError("metadata must be a JSON object");
  }
}

function rowToRoute(row: RouteRow): z.infer<typeof IngressProxyRoute> {
  return IngressProxyRoute.parse({
    id: row.id,
    rootHost: rootHostSchema.parse(row.rootHost),
    targetUrl: targetUrlSchema.parse(row.targetUrl),
    metadata: parseMetadataJson(row.metadataJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function parseCount(result: CountRoutesResult | null) {
  return Number(result?.total ?? 0);
}

const routeIdPrefix = "route";

function processEnvWithTypeIdPrefix(typeIdPrefix: string) {
  const runtime = globalThis as typeof globalThis & {
    __iterateTypeIdProcessEnv?: NodeJS.ProcessEnv;
  };

  runtime.__iterateTypeIdProcessEnv ??= {};
  runtime.__iterateTypeIdProcessEnv.TYPEID_PREFIX = typeIdPrefix;

  return runtime.__iterateTypeIdProcessEnv as NodeJS.ProcessEnv & { TYPEID_PREFIX: string };
}

export async function getRouteByRootHost(
  db: D1Database,
  params: z.infer<typeof GetRouteInput>,
): Promise<z.infer<typeof IngressProxyRoute> | null> {
  const rootHost = normalizeRootHost(params.rootHost);
  const row = (await selectRouteByRootHost(db, { rootHost }))[0] ?? null;
  return row ? rowToRoute(row) : null;
}

export async function listRoutes(
  db: D1Database,
  params: z.input<typeof ListRoutesInput>,
): Promise<z.infer<typeof ListRoutesOutput>> {
  const parsed = ListRoutesInput.parse(params);
  const [rows, total] = await Promise.all([selectRoutesPage(db, parsed), countRoutes(db)]);

  return {
    routes: rows.map(rowToRoute),
    total: parseCount(total),
  };
}

export async function upsertRoute(
  db: D1Database,
  params: z.input<typeof UpsertRouteInput>,
  options: {
    typeIdPrefix: string;
  },
): Promise<z.infer<typeof IngressProxyRoute>> {
  const parsed = UpsertRouteInput.parse(params);
  const rootHost = normalizeRootHost(parsed.rootHost);
  const targetUrl = normalizeTargetUrl(parsed.targetUrl);

  await upsertRouteByRootHost(db, {
    id: typeid({
      env: processEnvWithTypeIdPrefix(options.typeIdPrefix),
      prefix: routeIdPrefix,
    }),
    rootHost,
    targetUrl,
    metadataJson: JSON.stringify(parsed.metadata),
  });

  const route = await getRouteByRootHost(db, { rootHost });
  if (!route) {
    throw new Error("Failed to read route after upsert");
  }

  return route;
}

export async function removeRoute(
  db: D1Database,
  params: z.input<typeof RemoveRouteInput>,
): Promise<boolean> {
  const parsed = RemoveRouteInput.parse(params);
  const result = await deleteRouteByRootHost(db, {
    rootHost: normalizeRootHost(parsed.rootHost),
  });
  return (result.changes ?? 0) > 0;
}

export async function resolveRouteByHost(
  db: D1Database,
  rawHost: string | null,
): Promise<{ route: z.infer<typeof IngressProxyRoute>; targetUrl: URL } | null> {
  const candidates = deriveCandidateRootHosts(rawHost);
  if (!candidates) return null;

  const row =
    (
      await selectRouteCandidatesByRootHosts(db, {
        exactRootHost: candidates.exactRootHost,
        dunderRootHost: candidates.dunderRootHost,
        subhostRootHost: candidates.subhostRootHost,
      })
    )[0] ?? null;
  if (!row) return null;

  const route = rowToRoute(row);
  return {
    route,
    targetUrl: new URL(route.targetUrl),
  };
}
