/// <reference types="@cloudflare/workers-types" />

import {
  deriveDurableObjectNameFromStructuredName,
  serializeDurableObjectStructuredName,
  type LifecycleHooksMembers,
  type LifecycleStructuredName,
} from "./with-lifecycle-hooks.ts";
import type {
  Constructor,
  DurableObjectClass,
  MembersOf,
  ReqEnvOf,
  RuntimeDurableObjectConstructor,
  StaticSide,
} from "./mixin-types.ts";
import type { DurableObjectCoreProtected } from "./with-durable-object-core.ts";

export const DURABLE_OBJECT_PUBLIC_ROUTE_PREFIX = "/durable-objects";

export type PublicDurableObjectAddressingMode = "by-name" | "by-id" | "by-structured-name";

export type PublicFetchRouteMembers = {
  /**
   * Returns the Worker's public path for this Durable Object instance.
   *
   * Example:
   *
   *   room.getPublicDurableObjectPath();
   *   room.getPublicDurableObjectPath({ mode: "by-id" });
   *
   * The default mode comes from `withPublicFetchRoute({ defaultAddressing })`.
   * `by-structured-name` requires `withLifecycleHooks()` below this mixin and an
   * already-initialized object.
   */
  getPublicDurableObjectPath(options?: { mode?: PublicDurableObjectAddressingMode }): string;
};

type PublicFetchRouteMetadata = {
  namespaceSlug: string;
  defaultAddressing: PublicDurableObjectAddressingMode;
};

const PUBLIC_FETCH_ROUTE_METADATA = Symbol("public-fetch-route-metadata");

type PublicFetchRouteStatic = {
  [PUBLIC_FETCH_ROUTE_METADATA]: PublicFetchRouteMetadata;
};

type WithPublicFetchRouteResult<TBase extends DurableObjectClass> = StaticSide<TBase> &
  DurableObjectClass<ReqEnvOf<TBase>, MembersOf<TBase> & PublicFetchRouteMembers> &
  Constructor<PublicFetchRouteMembers> &
  PublicFetchRouteStatic;

/**
 * Adds a stable public path helper to a Durable Object class and records hidden
 * route metadata for worker-side proxy registration.
 *
 * Public URLs always live under:
 *
 * - `/durable-objects/:namespaceSlug/by-name/:name`
 * - `/durable-objects/:namespaceSlug/by-id/:id`
 * - `/durable-objects/:namespaceSlug/by-structured-name/:encodedStructuredName`
 *
 * The mixin does not wrap `fetch()`. It only adds instance path generation and
 * the hidden metadata that `routeDurableObjectRequest()` consumes. The
 * worker-side fetcher owns path matching, stub lookup, and proxying the request
 * to `stub.fetch()` after stripping the public prefix.
 *
 * Cloudflare Durable Object namespace and stub docs:
 * https://developers.cloudflare.com/durable-objects/api/namespace/
 * https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/
 */
export function withPublicFetchRoute(options: {
  namespaceSlug: string;
  defaultAddressing?: PublicDurableObjectAddressingMode;
}) {
  if (!options.namespaceSlug || options.namespaceSlug.includes("/")) {
    throw new Error("withPublicFetchRoute() requires a namespaceSlug without slashes.");
  }

  const metadata: PublicFetchRouteMetadata = {
    namespaceSlug: options.namespaceSlug,
    defaultAddressing: options.defaultAddressing ?? "by-name",
  };

  return function <TBase extends DurableObjectClass>(
    Base: TBase & Constructor<DurableObjectCoreProtected>,
  ): WithPublicFetchRouteResult<TBase> {
    const BaseWithCore = Base as unknown as RuntimeDurableObjectConstructor &
      Constructor<DurableObjectCoreProtected>;

    abstract class PublicFetchRouteMixin extends BaseWithCore implements PublicFetchRouteMembers {
      getPublicDurableObjectPath(options?: { mode?: PublicDurableObjectAddressingMode }): string {
        const mode = options?.mode ?? metadata.defaultAddressing;

        switch (mode) {
          case "by-name": {
            const name = this.getDurableObjectName();
            if (name === undefined) {
              throw new Error(
                'getPublicDurableObjectPath({ mode: "by-name" }) requires an object addressed by name.',
              );
            }

            return buildPublicDurableObjectPath({
              namespaceSlug: metadata.namespaceSlug,
              mode,
              payload: name,
            });
          }

          case "by-id":
            return buildPublicDurableObjectPath({
              namespaceSlug: metadata.namespaceSlug,
              mode,
              payload: this.getDurableObjectId().toString(),
            });

          case "by-structured-name": {
            const lifecycle = this as unknown as Partial<
              LifecycleHooksMembers<LifecycleStructuredName>
            >;
            if (typeof lifecycle.assertInitialized !== "function") {
              throw new Error(
                'getPublicDurableObjectPath({ mode: "by-structured-name" }) requires withLifecycleHooks() below withPublicFetchRoute().',
              );
            }

            return buildPublicDurableObjectPath({
              namespaceSlug: metadata.namespaceSlug,
              mode,
              payload: serializeDurableObjectStructuredName({
                structuredName: lifecycle.assertInitialized(),
              }),
            });
          }
        }
      }
    }

    Object.defineProperty(PublicFetchRouteMixin, PUBLIC_FETCH_ROUTE_METADATA, {
      value: metadata,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    return PublicFetchRouteMixin as unknown as WithPublicFetchRouteResult<TBase>;
  };
}

/**
 * Routes one Worker request to a registered Durable Object public route,
 * similar to Cloudflare Agents' `routeAgentRequest()` pattern.
 *
 * Example:
 *
 *   const response = await routeDurableObjectRequest(request, [
 *     registerDurableObjectPublicRoute({
 *       namespace: env.PROJECTS,
 *       class: Project,
 *     }),
 *   ]);
 *   if (response) return response;
 *
 * Returns `undefined` when the request is outside `/durable-objects`, and a
 * real `Response` when the prefix matches.
 *
 * Cloudflare Agents routing docs:
 * https://developers.cloudflare.com/agents/api-reference/calling-agents/
 */
export async function routeDurableObjectRequest(
  request: Request,
  registrations: PublicDurableObjectRouteRegistration[],
) {
  const registrationsBySlug = new Map<string, PublicDurableObjectRouteRegistration>();

  for (const registration of registrations) {
    if (registrationsBySlug.has(registration.namespaceSlug)) {
      throw new Error(
        `Duplicate Durable Object public route namespace slug: "${registration.namespaceSlug}".`,
      );
    }

    registrationsBySlug.set(registration.namespaceSlug, registration);
  }

  try {
    const requestUrl = new URL(request.url);
    const matched = matchPublicDurableObjectPath(requestUrl.pathname);
    if (matched === null) {
      return undefined;
    }

    const registration = registrationsBySlug.get(matched.namespaceSlug);
    if (registration === undefined) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const stub = await resolveDurableObjectStub(registration, matched);
    const forwardedUrl = new URL(`${matched.forwardedPath}${requestUrl.search}`, request.url);
    forwardedUrl.protocol = "https:";
    forwardedUrl.hostname = "durable-object.local";
    forwardedUrl.port = "";

    return await stub.fetch(new Request(forwardedUrl, request));
  } catch (error) {
    if (error instanceof PublicDurableObjectRouteError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    return Response.json(
      {
        error: error instanceof Error ? error.name : "UnknownError",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export type PublicDurableObjectRouteRegistration = {
  namespaceSlug: string;
  namespace: PublicFetchRouteNamespace;
};

/**
 * Reads hidden route metadata from a class wrapped with `withPublicFetchRoute()`
 * and pairs it with a Worker env namespace binding.
 */
export function registerDurableObjectPublicRoute(options: {
  namespace: PublicFetchRouteNamespace;
  class: PublicFetchRouteStatic;
}): PublicDurableObjectRouteRegistration {
  return {
    namespaceSlug: getPublicFetchRouteMetadata(options.class).namespaceSlug,
    namespace: options.namespace,
  };
}

function getPublicFetchRouteMetadata(value: PublicFetchRouteStatic): PublicFetchRouteMetadata {
  const metadata = value[PUBLIC_FETCH_ROUTE_METADATA];
  if (metadata === undefined) {
    throw new Error(
      "registerDurableObjectPublicRoute() requires a class wrapped with withPublicFetchRoute().",
    );
  }

  return metadata;
}

function buildPublicDurableObjectPath(options: {
  namespaceSlug: string;
  mode: PublicDurableObjectAddressingMode;
  payload: string;
}): string {
  return `${DURABLE_OBJECT_PUBLIC_ROUTE_PREFIX}/${encodePathSegment(options.namespaceSlug)}/${options.mode}/${encodePathSegment(options.payload)}`;
}

type MatchedPublicDurableObjectPath = {
  namespaceSlug: string;
  mode: PublicDurableObjectAddressingMode;
  payload: string;
  forwardedPath: string;
};

type FetchableDurableObjectStub = {
  fetch(request: Request): Response | Promise<Response>;
};

type PublicFetchRouteNamespace = {
  getByName(name: string): FetchableDurableObjectStub;
  idFromString(id: string): DurableObjectId;
  get(id: DurableObjectId): FetchableDurableObjectStub;
};

function matchPublicDurableObjectPath(pathname: string): MatchedPublicDurableObjectPath | null {
  if (
    pathname !== DURABLE_OBJECT_PUBLIC_ROUTE_PREFIX &&
    !pathname.startsWith(`${DURABLE_OBJECT_PUBLIC_ROUTE_PREFIX}/`)
  ) {
    return null;
  }

  const match = pathname.match(
    /^\/durable-objects\/([^/]+)\/(by-name|by-id|by-structured-name)\/([^/]+)(\/.*)?$/,
  );

  if (match === null) {
    throw new PublicDurableObjectRouteError(404, "Not found");
  }

  const [, namespaceSlugRaw, mode, payloadRaw, forwardedPathRaw] = match;

  return {
    namespaceSlug: decodePathSegment(namespaceSlugRaw, "namespace slug"),
    mode: mode as PublicDurableObjectAddressingMode,
    payload: payloadRaw,
    forwardedPath: forwardedPathRaw ?? "/",
  };
}

async function resolveDurableObjectStub(
  registration: PublicDurableObjectRouteRegistration,
  matched: MatchedPublicDurableObjectPath,
): Promise<FetchableDurableObjectStub> {
  const namespace = registration.namespace as unknown as PublicFetchRouteNamespace;

  switch (matched.mode) {
    case "by-name":
      return namespace.getByName(
        decodePathSegment(matched.payload, "name"),
      ) as FetchableDurableObjectStub;

    case "by-id": {
      const idString = decodePathSegment(matched.payload, "durable object id");
      let id: DurableObjectId;
      try {
        id = namespace.idFromString(idString);
      } catch {
        throw new PublicDurableObjectRouteError(400, "Invalid durable object id.");
      }

      return namespace.get(id) as FetchableDurableObjectStub;
    }

    case "by-structured-name": {
      const structuredName = parseStructuredNamePathPayload(matched.payload);

      try {
        const lifecycleStructuredName = structuredName as LifecycleStructuredName;
        const name = deriveDurableObjectNameFromStructuredName({
          structuredName: lifecycleStructuredName,
        });
        const stub = namespace.getByName(name);
        await (stub as unknown as LifecycleHooksMembers<LifecycleStructuredName>).initialize({
          name,
        });
        return stub;
      } catch (error) {
        if (error instanceof Error && error.message.includes("initialize is not a function")) {
          throw new PublicDurableObjectRouteError(
            500,
            "by-structured-name requires a Durable Object with withLifecycleHooks().",
          );
        }

        throw error;
      }
    }
  }
}

function parseStructuredNamePathPayload(payload: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodePathSegment(payload, "structured name"));
  } catch {
    throw new PublicDurableObjectRouteError(400, "Invalid structured name JSON.");
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new PublicDurableObjectRouteError(400, "Structured name must decode to a plain object.");
  }

  return parsed as Record<string, unknown>;
}

function decodePathSegment(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PublicDurableObjectRouteError(400, `Invalid ${label} path segment.`);
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

class PublicDurableObjectRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PublicDurableObjectRouteError";
  }
}
