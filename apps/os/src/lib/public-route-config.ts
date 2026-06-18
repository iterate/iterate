import { createServerFn } from "@tanstack/react-start";
import { getPublicConfig } from "@iterate-com/shared/config";
import { AppConfig } from "~/config.ts";

/**
 * The browser bootstrap config (redacted fields stripped). Replaces the oRPC
 * `__internal.publicConfig` procedure — a plain TanStack server fn reading the
 * request context, so the root loader needs no oRPC client.
 *
 * `getPublicConfig` already drops the redacted (secret) fields at runtime, but
 * its STATIC return type still carries them (e.g. `clientSecret`,
 * `jwks`), which TanStack's server-fn serializer rejects. The result is a plain
 * JSON document; `__root.tsx` re-parses it through the public config schema, so
 * the wire type is just `unknown`.
 */
export const getPublicConfigServerFn = createServerFn({ method: "GET" }).handler(
  // The serializer constrains the handler's return type to "structurally
  // serializable". `getPublicConfig` already drops the redacted (secret) config
  // fields at runtime, but its STATIC type still carries them (clientSecret,
  // the jwks `{ [x: string]: unknown }` key shape), which the serializer
  // rejects. Returning a JSON string keeps the wire type honest (a plain
  // string); `__root.tsx` JSON.parses then re-validates through the public
  // config schema.
  ({ context }): string => JSON.stringify(getPublicConfig(context.config, AppConfig)),
);

export type PublicRouteConfig = {
  baseUrl?: string;
  mcpBaseUrl?: string;
  projectHostnameBases: string[];
};

export const getPublicRouteConfig = createServerFn({ method: "GET" }).handler(
  ({ context }): PublicRouteConfig => {
    const config = context.config;

    return {
      baseUrl: config.baseUrl,
      mcpBaseUrl: config.mcp?.baseUrl,
      projectHostnameBases: config.projectHostnameBases ?? [],
    };
  },
);
