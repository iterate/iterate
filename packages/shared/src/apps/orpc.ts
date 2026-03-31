import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { AppManifest } from "./types.ts";

export function createOpenApiReferencePluginForApp<TManifest extends AppManifest>(
  manifest: TManifest,
) {
  return new OpenAPIReferencePlugin({
    docsProvider: "scalar",
    docsPath: "/docs",
    specPath: "/openapi.json",
    schemaConverters: [new ZodToJsonSchemaConverter()],
    specGenerateOptions: {
      info: {
        title: `iterate ${manifest.slug} app API`,
        version: manifest.version,
      },
      servers: [{ url: "/api" }],
    },
  });
}
