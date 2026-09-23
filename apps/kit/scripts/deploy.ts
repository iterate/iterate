import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { kitEnvs } from "../../../envs.ts";
import { deployApp } from "../../../scripts/lib/deploy-app.ts";
import { firmwareCatalog } from "../src/firmware/catalog.ts";
import { deviceVendors } from "../src/firmware/device-client.ts";
import { syncFirmwareAssets } from "./sync-firmware-assets.ts";
import { verifyFirmwareAssets } from "./verify-firmware-assets.ts";

/** Kit's deploy (`pnpm deploy`, scripts/app.ts): the shared one plus the firmware — the released
 *  binaries synced into public/ before the build, every installer route smoked, and every public
 *  part compared with the release after. */
export async function deployKit(options: { env?: string }) {
  await deployApp({
    appRoot: fileURLToPath(new URL("..", import.meta.url)),
    appLabel: "apps/kit",
    envs: kitEnvs,
    dopplerProject: "kit",
    env: options.env,
    workerName: (env) => env.workerName,
    servingUrl: (env) => env.baseUrl,
    prepare: syncFirmwareAssets,
    smokes: (env) => [
      { url: `${env.baseUrl}/healthz`, ok: (status: number) => status === 200, label: "health" },
      ...firmwareCatalog.flatMap((device) => [
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
    ],
    afterDeploy: (ctx) => verifyFirmwareAssets(ctx.env.baseUrl),
  });
}
