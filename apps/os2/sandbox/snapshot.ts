import { join } from "node:path";
import { Daytona, Image } from "@daytonaio/sdk";

const prefix = process.env.DAYTONA_SNAPSHOT_PREFIX;
if (!prefix) {
  throw new Error("DAYTONA_SNAPSHOT_PREFIX environment variable is required");
}

/**
 * Generates a timestamp in YYYYMMDD-HHMMSS format (UTC).
 */
function generateTimestamp(): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hours = String(now.getUTCHours()).padStart(2, "0");
  const minutes = String(now.getUTCMinutes()).padStart(2, "0");
  const seconds = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

// Generate snapshot name: <prefix><timestamp>
// e.g., "iterate-sandbox-dev--20260111-193045"
const snapshotName = `${prefix}${generateTimestamp()}`;

console.log(`Creating snapshot: ${snapshotName}`);

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
});

const snapshot = await daytona.snapshot.create(
  {
    name: snapshotName,
    image: Image.fromDockerfile(join(import.meta.dirname, "./Dockerfile")),
    resources: {
      cpu: 2,
      memory: 4,
      disk: 10,
    },
  },
  {
    onLogs: console.log,
  },
);

console.log("Snapshot created successfully:", snapshot);
