import { join } from "node:path";
import { Daytona, Image } from "@daytonaio/sdk";

/**
 * Constructs the stage/prefix the same way alchemy does:
 * - For dev: `local-${ITERATE_USER}` (mirrors `--stage local-$USER` in package.json)
 * - For stg/prd: Uses APP_STAGE directly
 */
function getStage(): string {
  const iterateUser = process.env.ITERATE_USER;
  const appStage = process.env.APP_STAGE;

  // For local dev with ITERATE_USER set
  if (iterateUser && iterateUser !== "unknown") {
    return `local-${iterateUser}`;
  }

  // For stg/prd, APP_STAGE should be set in Doppler
  if (appStage) {
    return appStage;
  }

  throw new Error("Cannot determine stage: set ITERATE_USER for dev or APP_STAGE for stg/prd");
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

const stage = getStage();
// Generate snapshot name: <stage>--<timestamp>
// e.g., "local-jonas--20260111-193045", "stg--20260111-193045"
const snapshotName = `${stage}--${generateTimestamp()}`;

console.log(`Creating snapshot: ${snapshotName}`);

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
});

// Dockerfile only needs entry.ts from the sandbox directory
const snapshot = await daytona.snapshot.create(
  {
    name: snapshotName,
    image: Image.fromDockerfile(join(import.meta.dirname, "Dockerfile")),
    resources: {
      disk: 10,
    },
  },
  {
    onLogs: console.log,
  },
);

console.log("Snapshot created successfully:", snapshot);
