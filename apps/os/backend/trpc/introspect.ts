import { z, type ZodTypeAny } from "zod/v4";
import type { AnyProcedure, AnyRouter, ProcedureType } from "@trpc/server";
import zodToJsonSchema from "zod-to-json-schema";

export interface ProcedureInfo {
  procedure: { _def: { type: ProcedureType } };
  parsedProcedure: { optionsJsonSchema: Record<string, unknown> };
  meta?: { description?: string };
}

// Helper to check if something is a Zod v4 schema
function isZodSchema(parser: unknown): parser is ZodTypeAny {
  return (
    typeof parser === "object" &&
    parser !== null &&
    "_zod" in parser &&
    typeof (parser as { _zod: unknown })._zod === "object"
  );
}

// Helper to merge multiple zod schemas from procedure inputs
function mergeZodSchemas(inputs: unknown[]): ZodTypeAny | null {
  const zodSchemas = inputs.filter(isZodSchema);
  if (zodSchemas.length === 0) return null;
  if (zodSchemas.length === 1) return zodSchemas[0];

  // Merge multiple object schemas using intersection
  let merged = zodSchemas[0];
  for (let i = 1; i < zodSchemas.length; i++) {
    merged = z.intersection(merged, zodSchemas[i]) as ZodTypeAny;
  }
  return merged;
}

/**
 * Introspect tRPC router to get all procedure paths, types, and input schemas.
 * Returns an array of [path, procedureInfo] tuples for use in the admin tRPC tools UI.
 */
export function introspectRouter(routerInstance: AnyRouter): Array<[string, ProcedureInfo]> {
  const procedures = routerInstance._def.procedures as Record<string, AnyProcedure>;
  const results: Array<[string, ProcedureInfo]> = [];

  for (const [path, procedure] of Object.entries(procedures)) {
    const def = procedure._def;
    const type = def.type as ProcedureType;
    const inputs = def.inputs as unknown[];
    const meta = def.meta as { description?: string } | undefined;

    // Convert Zod schema to JSON Schema for the form
    let jsonSchema: Record<string, unknown> = {
      type: "object",
      properties: {},
    };

    const mergedSchema = mergeZodSchemas(inputs);
    if (mergedSchema) {
      try {
        // zod-to-json-schema expects zod v3 types, but we can cast since the structure is similar
        jsonSchema = zodToJsonSchema(
          mergedSchema as unknown as Parameters<typeof zodToJsonSchema>[0],
          {
            $refStrategy: "none",
            target: "jsonSchema7",
          },
        ) as Record<string, unknown>;
      } catch {
        // If conversion fails, keep default empty schema
      }
    }

    results.push([
      path,
      {
        procedure: { _def: { type } },
        parsedProcedure: { optionsJsonSchema: jsonSchema },
        meta,
      },
    ]);
  }

  // Sort alphabetically by path
  results.sort((a, b) => a[0].localeCompare(b[0]));

  return results;
}
