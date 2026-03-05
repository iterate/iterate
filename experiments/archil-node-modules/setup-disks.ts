/**
 * Provisions (or reuses) Archil disks for the benchmark experiment.
 * Creates two disks in the misha-archil-test R2 bucket:
 *   1. archil-bench-nm     — for pnpm install benchmark (node_modules on archil)
 *   2. archil-bench-bundle — for git-bundle sync benchmark
 *
 * Outputs a JSON file (disk-config.json) with disk IDs and mount tokens.
 *
 * Usage: doppler run -- npx tsx setup-disks.ts
 */
import { Archil, ArchilApiError } from "@archildata/client/api";
import * as fs from "node:fs";

// SDK prepends "key-" to the apiKey, so strip it if already present
const ARCHIL_API_KEY = process.env.ARCHIL_API_KEY!.replace(/^key-/, "");
const ARCHIL_R2_ACCESS_KEY_ID = process.env.ARCHIL_R2_ACCESS_KEY_ID!;
const ARCHIL_R2_SECRET_ACCESS_KEY = process.env.ARCHIL_R2_SECRET_ACCESS_KEY!;
const CLOUDFLARE_ACCOUNT_ID =
  process.env.CLOUDFLARE_ACCOUNT_ID || "04b3b57291ef2626c6a8daa9d47065a7";

const REGION = "aws-us-east-1";
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
      } catch (addErr) {
        console.warn(`Warning: failed to add token, will try anyway`);
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

  console.log("Provisioning Archil disks for benchmark...\n");

  const [nmDisk, bundleDisk] = await Promise.all([
    createOrReuseDisk(archil, "archil-bench-nm", "bench/node-modules/"),
    createOrReuseDisk(archil, "archil-bench-bundle", "bench/git-bundle/"),
  ]);

  const config = {
    nm: nmDisk,
    bundle: bundleDisk,
  };

  fs.writeFileSync("disk-config.json", JSON.stringify(config, null, 2));
  console.log("\nWrote disk-config.json:");
  console.log(JSON.stringify(config, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
