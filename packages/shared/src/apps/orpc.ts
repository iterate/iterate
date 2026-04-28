import type { Context } from "@orpc/server";
import type { FetchHandleResult, FetchHandlerInterceptorOptions } from "@orpc/server/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { INTERNAL_OPENAPI_TAG } from "./openapi.ts";
import type { AppManifest } from "./types.ts";

/**
 * Adapter interceptor that pretty-prints JSON responses for curl ergonomics.
 * Leaves SSE (`text/event-stream`) and non-JSON responses untouched.
 */
export async function prettyJsonInterceptor(
  options: FetchHandlerInterceptorOptions<Context> & {
    next(): Promise<FetchHandleResult>;
  },
) {
  const result = await options.next();
  const type = result.response?.headers.get("content-type");
  if (!result.matched || result.response.body === null || !type?.includes("json")) return result;
  return {
    ...result,
    response: new Response(JSON.stringify(await result.response.json(), null, 2), result.response),
  };
}

type OpenApiReferencePluginOptions = {
  defaultOpenFirstTag: boolean;
};

export function createOpenApiReferencePluginForApp<TManifest extends AppManifest>(
  manifest: TManifest,
  publicTags: string[] = [],
  options: OpenApiReferencePluginOptions = { defaultOpenFirstTag: false },
) {
  const tags = [...new Set([...publicTags, INTERNAL_OPENAPI_TAG])].map((name) => ({ name }));

  return new OpenAPIReferencePlugin({
    docsProvider: "scalar",
    docsPath: "/docs",
    specPath: "/openapi.json",
    schemaConverters: [new ZodToJsonSchemaConverter()],
    docsConfig: {
      defaultOpenFirstTag: options.defaultOpenFirstTag,
    },
    specGenerateOptions: {
      info: {
        title: `iterate ${manifest.slug} app API`,
        version: manifest.version,
      },
      servers: [{ url: "/api" }],
      tags,
    },
  });
}
