import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { COMPATIBILITY_DATE } from "./wrangler-config.ts";

test.for(["apps/os/wrangler.base.jsonc", "apps/os/wrangler.test.jsonc"])(
  "%s deploys with the shared compatibility date",
  (file) => {
    const config = readFileSync(resolve(import.meta.dirname, "../..", file), "utf8");
    expect(config).toContain(`"compatibility_date": "${COMPATIBILITY_DATE}"`);
  },
);
