import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { projectCoreDomainPoc } from "../deployment.ts";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, ".wrangler", "domain-poc");

function localConfig(name: string) {
  const parsed = ts.parseConfigFileTextToJson(name, readFileSync(resolve(root, name), "utf8"));
  if (parsed.error)
    throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"));
  return parsed.config;
}

if (
  process.argv.slice(2).join(" ") !== "--env domain_poc" ||
  process.env.CLOUDFLARE_ACCOUNT_ID !== projectCoreDomainPoc.cloudflareAccountId
)
  throw new Error("Use --env domain_poc with its committed Cloudflare account.");

const core = localConfig("wrangler.jsonc");
const bundler = localConfig("wrangler.bundler.jsonc");
if (!core.assets) throw new Error("Local core Wrangler config is missing assets.");
const { $schema: _coreSchema, ...coreWithoutSchema } = core;
const { $schema: _bundlerSchema, ...bundlerWithoutSchema } = bundler;

mkdirSync(output, { recursive: true });
const write = (name: string, config: object) =>
  writeFileSync(resolve(output, name), `${JSON.stringify(config, null, 2)}\n`);

write("core.wrangler.jsonc", {
  ...coreWithoutSchema,
  name: projectCoreDomainPoc.coreWorkerName,
  main: resolve(root, core.main),
  account_id: projectCoreDomainPoc.cloudflareAccountId,
  workers_dev: true,
  routes: projectCoreDomainPoc.routes,
  vars: {
    ...core.vars,
    PUBLIC_ORIGIN: projectCoreDomainPoc.publicOrigin,
    PROJECT_HOSTNAME_BASE: projectCoreDomainPoc.projectHostnameBase,
    CUSTOM_HOSTNAMES: projectCoreDomainPoc.customHostnames,
  },
  kv_namespaces: [{ binding: "OAUTH_KV", id: projectCoreDomainPoc.resources.oauthKvId }],
  services: [{ binding: "BUNDLER", service: projectCoreDomainPoc.bundlerWorkerName }],
  assets: { ...core.assets, directory: resolve(root, core.assets.directory) },
});

write("bundler.wrangler.jsonc", {
  ...bundlerWithoutSchema,
  name: projectCoreDomainPoc.bundlerWorkerName,
  main: resolve(root, bundler.main),
  account_id: projectCoreDomainPoc.cloudflareAccountId,
  workers_dev: false,
  kv_namespaces: [{ binding: "BUILD_CACHE", id: projectCoreDomainPoc.resources.buildCacheKvId }],
});
