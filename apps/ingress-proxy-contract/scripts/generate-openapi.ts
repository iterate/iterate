import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import packageJson from "../package.json" with { type: "json" };
import { ingressProxyContract } from "../src/index.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = dirname(scriptDir);
const outputPath = join(packageDir, "openapi.json");

const generator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

const spec = await generator.generate(ingressProxyContract, {
  info: {
    title: "Ingress Proxy API",
    version: packageJson.version ?? "0.0.0",
  },
  servers: [{ url: "/api" }],
});

await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`);
