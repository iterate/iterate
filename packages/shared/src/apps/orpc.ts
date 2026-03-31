import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { INTERNAL_OPENAPI_TAG } from "./openapi.ts";
import type { AppManifest } from "./types.ts";

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
