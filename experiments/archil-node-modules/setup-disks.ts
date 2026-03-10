/**
 * Provisions (or reuses) an Archil disk for the benchmark experiment.
 * Creates one disk in the misha-archil-test R2 bucket:
 *   archil-bench-nm — for pnpm install benchmark (node_modules on archil)
 *
 * Outputs a JSON file (disk-config.json) with disk ID and mount token.
 *
 * Usage: doppler run -- npx tsx setup-disks.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Archil, ArchilApiError } from "@archildata/client/api";

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);

// ARCHIL_API_KEYS is a JSON object mapping region to API key (e.g. {"aws-eu-west-1": "key-..."})
// Falls back to legacy ARCHIL_API_KEY_EU_WEST / ARCHIL_API_KEY for backwards compat.
const ARCHIL_API_KEY = (() => {
  if (process.env.ARCHIL_API_KEYS) {
    const keys = JSON.parse(process.env.ARCHIL_API_KEYS) as Record<string, string>;
    const key = keys["aws-eu-west-1"];
    if (key) return key.replace(/^key-/, "");
  }
  return (process.env.ARCHIL_API_KEY_EU_WEST || process.env.ARCHIL_API_KEY || "").replace(
    /^key-/,
    "",
  );
})();
const ARCHIL_R2_ACCESS_KEY_ID = process.env.ARCHIL_R2_ACCESS_KEY_ID!;
const ARCHIL_R2_SECRET_ACCESS_KEY = process.env.ARCHIL_R2_SECRET_ACCESS_KEY!;
const CLOUDFLARE_ACCOUNT_ID =
  process.env.CLOUDFLARE_ACCOUNT_ID || "04b3b57291ef2626c6a8daa9d47065a7";

const REGION = "aws-eu-west-1";
const BUCKET_NAME = "misha-archil-test";
const BUCKET_ENDPOINT = `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`;

interface DiskConfig {
  diskId: string;
  mountToken: string;
  region: string;
}

async function createOrReuseDisk(
  archil: Archil,
  name: string,
  bucketPrefix: string,
): Promise<DiskConfig> {
  const tokenBytes = new Uint8Array(32);
  crypto.getRandomValues(tokenBytes);
  const tokenHex = Array.from(tokenBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const mountToken = `archil-bench-${tokenHex}`;

  const authMethod = {
    type: "token" as const,
    principal: mountToken,
    nickname: `bench-${name}`,
    tokenSuffix: tokenHex.slice(-4),
  };

  try {
    const disk = await archil.disks.create({
      name,
      mounts: [
        {
          type: "r2",
          bucketName: BUCKET_NAME,
          bucketEndpoint: BUCKET_ENDPOINT,
          accessKeyId: ARCHIL_R2_ACCESS_KEY_ID,
          secretAccessKey: ARCHIL_R2_SECRET_ACCESS_KEY,
          bucketPrefix,
        },
      ],
      authMethods: [authMethod],
    });

    console.log(`Created disk: ${disk.id} (${name})`);
    return { diskId: disk.id, mountToken, region: REGION };
  } catch (err) {
    if (err instanceof ArchilApiError && err.status === 409) {
      console.log(`Disk ${name} already exists, adding new auth token...`);
      const disks = await archil.disks.list();
      const disk = disks.find((d) => d.name === name);
      if (!disk) throw new Error(`Disk ${name} not found despite 409`);

      try {
        await disk.addUser(authMethod);
        console.log(`Added auth token to disk ${disk.id}`);
      } catch (addErr) {
        console.warn(`Warning: failed to add token:`, addErr);
      }

      return { diskId: disk.id, mountToken, region: REGION };
    }
    throw err;
  }
}

async function main() {
  if (!ARCHIL_API_KEY) {
    console.error("Missing ARCHIL_API_KEY. Run with: doppler run -- npx tsx setup-disks.ts");
    process.exit(1);
  }

  const archil = new Archil({ apiKey: ARCHIL_API_KEY, region: REGION });

  console.log("Provisioning Archil disk for benchmark...\n");

  const nmDisk = await createOrReuseDisk(archil, "archil-bench-nm", "bench/node-modules/");

  const config = { nm: nmDisk };

  const outPath = path.join(SCRIPT_DIR, "disk-config.json");
  fs.writeFileSync(outPath, JSON.stringify(config, null, 2));
  console.log(`\nWrote ${outPath}:`);
  console.log(JSON.stringify(config, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
