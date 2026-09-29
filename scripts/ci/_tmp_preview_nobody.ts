// scratch: identify every stored context of a preview by id, as the sweep does
import { connectIterate } from "iterate/node";
import { parseAppConfig } from "../../apps/os/src/app-config.ts";
import { cloudflareApi, dopplerSecret } from "../lib/env-context.ts";
const [baseUrl, workerName] = process.argv.slice(2) as [string, string];
const account = "376ef7ed81b0573f93524de763666c15";
const cf = cloudflareApi(dopplerSecret("_shared", "preview", "CLOUDFLARE_API_TOKEN"));
const namespaces = await cf<{ id: string; script: string | null; class: string }[]>(
  `/accounts/${account}/workers/durable_objects/namespaces?per_page=1000`,
);
const ns = namespaces.find(
  (n) => n.script === workerName && n.class === "IterateContextDurableObject",
)!;
const objects = await cf<{ id: string; hasStoredData?: boolean }[]>(
  `/accounts/${account}/workers/durable_objects/namespaces/${ns.id}/objects?limit=10000`,
);
const stored = objects.filter((o) => o.hasStoredData).map((o) => o.id);
const config = parseAppConfig({
  APP_CONFIG: dopplerSecret("os", "preview", "APP_CONFIG"),
  APP_CONFIG_SECRETS__KEY: dopplerSecret("os", "preview", "APP_CONFIG_SECRETS__KEY"),
});
using connection = await connectIterate({
  baseUrl,
  auth: { type: "admin-secret", secret: config.secrets.adminBearer.exposeSecret() },
});
const answers = await connection.session.contexts.identify(stored.slice(0, 50));
console.log(new Date().toISOString(), stored.length, "stored");
for (const a of answers) if ("error" in a) console.log("refused", a.id, a.error.slice(0, 90));
