import * as crypto from "node:crypto";
import { join } from "node:path";
import { defineConfig } from "sqlfu";

const getD1DatabasePath = (params: { slug: string; miniflareV3Root: string }) => {
  const uniqueKey = "miniflare-D1DatabaseObject";
  const key = crypto.createHash("sha256").update(uniqueKey).digest();
  const nameHmac = crypto.createHmac("sha256", key).update(params.slug).digest().subarray(0, 16);
  const hmac = crypto.createHmac("sha256", key).update(nameHmac).digest().subarray(0, 16);
  const id = Buffer.concat([nameHmac, hmac]).toString("hex");
  return join(params.miniflareV3Root, `d1/${uniqueKey}/${id}.sqlite`);
};

export default defineConfig({
  db: getD1DatabasePath({
    slug: "auth-dev-auth-db",
    miniflareV3Root: join(process.cwd(), "../../.alchemy/miniflare/v3"),
  }),
  migrations: {
    path: "./src/server/db/migrations",
    preset: "d1",
  },
  definitions: "./src/server/db/definitions.sql",
  queries: "./src/server/db/queries",
});
