import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createBuiltInPrompts, createCli, isAgent, yamlTableConsoleLogger } from "trpc-cli";
import { kitEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { firmwareCatalog } from "../src/firmware/catalog.ts";
import { deviceVendors } from "../src/firmware/device-client.ts";
import { writeWranglerConfig } from "./generate-wrangler-config.ts";
import { syncFirmwareAssets } from "./sync-firmware-assets.ts";
import { verifyFirmwareAssets } from "./verify-firmware-assets.ts";

export default async function deploy(options: { env?: string } = {}) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/kit",
    envs: kitEnvs,
    dopplerProject: "kit",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    prepare: async () => {
      writeWranglerConfig();
      await syncFirmwareAssets();
    },
    smokes: (env) =>
      firmwareCatalog.flatMap((device) => [
        ...device.releases.map((release) => ({
          url: `${env.baseUrl}/devices/${device.id}/firmware/${release.version}`,
          ok: (status: number) => status === 200,
          label: `${device.id}/${release.version} installer`,
        })),
        {
          url: `${env.baseUrl}/devices/${device.id}/clients/${randomUUID()}.json`,
          ok: (status: number) => status === 200,
          label: `${device.id} OAuth metadata`,
        },
        {
          url: `${env.baseUrl}/vendors/${deviceVendors[device.id]!.icon}`,
          ok: (status: number) => status === 200,
          label: `${device.id} vendor icon`,
        },
      ]),
    afterDeploy: (ctx) => verifyFirmwareAssets(ctx.env.baseUrl),
  });
}

if (process.argv[1]?.endsWith("deploy.ts")) {
  void createCli({ ...import.meta, name: "deploy" }).run({
    logger: yamlTableConsoleLogger,
    prompts: isAgent() ? undefined : createBuiltInPrompts(),
  });
}
