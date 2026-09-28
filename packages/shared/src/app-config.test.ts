// app-config.test.ts — the mechanism every Worker's config goes through: the object and its vars
// composed, and a key the schema does not name refused in both spellings. Each schema's own fields
// are its app's table (apps/os/src/worker.test.ts, scripts/lib/start-app.test.ts).
import { expect, test } from "vitest";
import { z } from "zod";
import { httpOrigin, optionalOrigin, parseAppConfigVars } from "./app-config.ts";

/** A schema with each shape the walk meets: a prefaulted block, an optional one, a record. */
const Schema = z.object({
  urls: z.object({ os: httpOrigin, dash: optionalOrigin }).prefault({ os: "" }),
  routing: z.object({ type: z.string() }).optional(),
  labels: z.record(z.string(), z.string()).default({}),
});

test.for<{ name: string; env: Record<string, string>; becomes?: unknown; throws?: RegExp }>([
  {
    name: "the object and a var compose, and a record's keys are its own",
    env: {
      APP_CONFIG: JSON.stringify({ urls: { os: "https://os.test" }, labels: { anything: "kept" } }),
      APP_CONFIG_URLS__DASH: "https://dash.test",
    },
    becomes: {
      urls: { os: "https://os.test", dash: "https://dash.test" },
      labels: { anything: "kept" },
    },
  },
  {
    name: "a key inside the object the schema does not name",
    env: {
      APP_CONFIG: JSON.stringify({ urls: { os: "https://os.test", mcp: "https://mcp.test" } }),
    },
    throws: /^APP_CONFIG urls\.mcp \(APP_CONFIG_URLS__MCP\): not in the schema/,
  },
  {
    name: "a var no field answers to, named where it leaves the schema",
    env: { APP_CONFIG_URLS__OS: "https://os.test", APP_CONFIG_URL__DASH: "https://dash.test" },
    throws: /^APP_CONFIG url \(APP_CONFIG_URL\): not in the schema/,
  },
  {
    name: "a stray key inside an optional block a var sets whole",
    env: { APP_CONFIG_URLS__OS: "https://os.test", APP_CONFIG_ROUTING: '{"type":"paths","x":1}' },
    throws: /^APP_CONFIG routing\.x \(APP_CONFIG_ROUTING__X\): not in the schema/,
  },
])("parseAppConfigVars: $name", ({ env, becomes, throws }) => {
  if (throws) expect(() => parseAppConfigVars(env, Schema)).toThrow(throws);
  // exact: a key the schema does not name is never kept
  else expect(parseAppConfigVars(env, Schema)).toEqual(becomes);
});
