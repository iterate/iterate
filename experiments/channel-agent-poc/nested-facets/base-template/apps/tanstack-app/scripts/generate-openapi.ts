/**
 * Generate OpenAPI spec from the oRPC contract.
 * Output: openapi.json (included in the DO wrapper at build time)
 */
import { OpenAPIGenerator } from "@orpc/openapi";
import { thingsContract } from "../src/orpc/contract.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const generator = new OpenAPIGenerator();
const spec = await generator.generate(thingsContract, {
  info: {
    title: "Things API — Durable Object Facet",
    version: "1.0.0",
    description:
      "CRUD API backed by SQLite inside a Cloudflare Durable Object, " +
      "served via a TanStack Start app running as a dynamic worker facet.",
  },
});

const outPath = join(__dirname, "..", "openapi.json");
writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`Generated OpenAPI spec: ${outPath} (${JSON.stringify(spec).length} bytes)`);
