import {
  listRoutesOutputSchema,
  listRoutesInputSchema,
  removeRouteInputSchema,
  rootHostSchema,
  routeMetadataSchema,
  routeSchema,
  targetUrlSchema,
  upsertRouteInputSchema,
  type IngressProxyRoute,
} from "@iterate-com/ingress-proxy-contract";
import { typeid } from "@iterate-com/shared/typeid";
import type { z } from "zod";
import { Env } from "./env.ts";
import {
  deriveCandidateRootHosts,
  normalizeRootHost,
  normalizeTargetUrl,
  RouteInputError,
} from "./proxy.ts";
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
} from "./sql/queries.ts";

type RouteRow =
  | SelectRouteByRootHostResult
  | SelectRouteCandidatesByRootHostsResult
  | SelectRoutesPageResult;

/**
 * Metadata stays as JSON text in SQLite so the schema stays small and we avoid
 * inventing columns for deployment-specific annotations too early.
 */
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

function rowToRoute(row: RouteRow): IngressProxyRoute {
  return routeSchema.parse({
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

function processEnvWithTypeIdPrefix() {
  const runtime = globalThis as typeof globalThis & {
    __iterateTypeIdProcessEnv?: NodeJS.ProcessEnv;
  };

  runtime.__iterateTypeIdProcessEnv ??= {};
  runtime.__iterateTypeIdProcessEnv.TYPEID_PREFIX = Env.TYPEID_PREFIX;

  return runtime.__iterateTypeIdProcessEnv as NodeJS.ProcessEnv & { TYPEID_PREFIX: string };
}

/**
 * All write paths go through root_host because that is the canonical deployment
 * identity coming from ITERATE_INGRESS_HOST. The generated `id` exists so the
 * row still has a stable application identifier for APIs and future relations.
 */
export async function getRouteByRootHost(
  db: D1Database,
  params: z.infer<typeof removeRouteInputSchema>,
): Promise<IngressProxyRoute | null> {
  const rootHost = normalizeRootHost(params.rootHost);
  const row = (await selectRouteByRootHost(db, { rootHost }))[0] ?? null;
  return row ? rowToRoute(row) : null;
}

export async function listRoutes(
  db: D1Database,
  params: z.input<typeof listRoutesInputSchema>,
): Promise<z.infer<typeof listRoutesOutputSchema>> {
  const parsed = listRoutesInputSchema.parse(params);
  const [rows, total] = await Promise.all([selectRoutesPage(db, parsed), countRoutes(db)]);

  return {
    routes: rows.map(rowToRoute),
    total: parseCount(total),
  };
}

/**
 * Internal-only listing for operator surfaces like `GET /__debug`.
 * The public API stays paginated and capped, but the debug page should show
 * the whole currently active registry snapshot.
 */
export async function listAllRoutes(
  db: D1Database,
): Promise<z.infer<typeof listRoutesOutputSchema>> {
  const total = parseCount(await countRoutes(db));
  const rows = total === 0 ? [] : await selectRoutesPage(db, { limit: total, offset: 0 });

  return {
    routes: rows.map(rowToRoute),
    total,
  };
}

export async function upsertRoute(
  db: D1Database,
  params: z.input<typeof upsertRouteInputSchema>,
): Promise<IngressProxyRoute> {
  const parsed = upsertRouteInputSchema.parse(params);
  const rootHost = normalizeRootHost(parsed.rootHost);
  const targetUrl = normalizeTargetUrl(parsed.targetUrl);

  await upsertRouteByRootHost(db, {
    id: typeid({
      env: processEnvWithTypeIdPrefix(),
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
  params: z.input<typeof removeRouteInputSchema>,
): Promise<boolean> {
  const parsed = removeRouteInputSchema.parse(params);
  const result = await deleteRouteByRootHost(db, {
    rootHost: normalizeRootHost(parsed.rootHost),
  });
  return (result.changes ?? 0) > 0;
}

export async function resolveRouteByHost(
  db: D1Database,
  rawHost: string | null,
): Promise<{ route: IngressProxyRoute; targetUrl: URL } | null> {
  const candidates = deriveCandidateRootHosts(rawHost);
  if (!candidates) return null;

  // SQL ordering decides precedence: exact host first, then dunder, then
  // subdomain, with longer root hosts winning ties.
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
