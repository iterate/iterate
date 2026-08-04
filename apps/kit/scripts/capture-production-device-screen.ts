import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectItxReady } from "iterate/node";
import { z } from "zod";
import { kitDeviceCapabilityPath } from "../src/userspace/config-worker/device-id.ts";
import { resolveProductionProjectApiKey } from "../src/device/production-project-api-key.ts";

const projectId = process.env.ITERATE_KIT_PROJECT_ID?.trim() ?? "";
const deviceId = process.env.ITERATE_KIT_DEVICE_ID?.trim() || "stackchan";
const baseUrl = process.env.ITERATE_KIT_BASE_URL?.trim() || "https://os.iterate.com";
if (!/^prj_[A-Za-z0-9_-]+$/u.test(projectId)) {
  throw new Error("ITERATE_KIT_PROJECT_ID must identify the deployed device project.");
}
if (!/^[a-z0-9](?:[a-z0-9-]{0,62})$/u.test(deviceId)) {
  throw new Error("ITERATE_KIT_DEVICE_ID must be a canonical device slug.");
}

const projectApiKey = await resolveProductionProjectApiKey({
  adminApiSecret: process.env.APP_CONFIG_ADMIN_API_SECRET,
  baseUrl,
  projectApiKey: process.env.ITERATE_KIT_PROJECT_API_KEY,
  projectId,
});
using project = await connectItxReady(
  {
    auth: { projectId, secret: projectApiKey, type: "project-secret" },
    baseUrl,
    projectId,
  },
  {
    retryInitialConnection: {
      delayMs: 250,
      onRetry: ({ delayMs, error }) =>
        console.warn(
          JSON.stringify({ code: "device-screen-capture-connect-retry", delayMs, error }),
        ),
    },
  },
);

const root = project.capabilityHosts.get("/");
const screenshot = z.instanceof(Uint8Array).parse(
  await root.invokeCapability({
    args: [],
    path: [...kitDeviceCapabilityPath(deviceId), "captureScreen"],
  }),
);
const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
if (!pngSignature.every((byte, index) => screenshot[index] === byte)) {
  throw new Error(`${deviceId}.captureScreen() did not return a PNG image.`);
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(packageDirectory, "evidence", "device-screen-captures");
await mkdir(outputDirectory, { recursive: true });
const capturedAt = new Date().toISOString();
const outputPath = join(outputDirectory, `${deviceId}-${capturedAt.replaceAll(/[:.]/gu, "-")}.png`);
await writeFile(outputPath, screenshot);
console.log(
  JSON.stringify(
    {
      bytes: screenshot.byteLength,
      capturedAt,
      deviceId,
      outputPath,
      projectId,
      sha256: createHash("sha256").update(screenshot).digest("hex"),
    },
    undefined,
    2,
  ),
);
