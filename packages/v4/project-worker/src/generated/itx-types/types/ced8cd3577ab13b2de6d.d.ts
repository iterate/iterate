import type * as JSONSchema from "./513ece59a63b5b541b97";
import { type $ZodRegistry } from "./3fe25d6474085d433d52";
import type { ZodType } from "./2d7938000dd62cba4e67";
type JSONSchemaVersion = "draft-2020-12" | "draft-7" | "draft-4" | "openapi-3.0";
interface FromJSONSchemaParams {
    defaultTarget?: JSONSchemaVersion;
    registry?: $ZodRegistry<any>;
}
/**
 * Converts a JSON Schema to a Zod schema. This function should be considered semi-experimental. It's behavior is liable to change. */
export declare function fromJSONSchema(schema: JSONSchema.JSONSchema | boolean, params?: FromJSONSchemaParams): ZodType;
export {};
