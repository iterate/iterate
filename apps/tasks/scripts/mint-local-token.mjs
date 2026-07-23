// Mint a project-app-session JWT for LOCAL dev (HS256, same shape the auth
// worker mints in prod — see apps/os/src/auth/project-app-session-token.ts).
// Secret comes from the os app's doppler dev config:
//   cd ../iterate-collab-poc/apps/os && doppler secrets get APP_CONFIG_PROJECT_APP_SESSION_SECRET --plain
// Usage: node scripts/mint-local-token.mjs <projectId> [userId] [audience]
//   env: SESSION_SECRET (required)
import { createHmac } from "node:crypto";

const [projectId, userId = "usr_local_dev", audience = "http://localhost:5199"] =
  process.argv.slice(2);
const secret = process.env.SESSION_SECRET;
if (!projectId || !secret) {
  console.error("usage: SESSION_SECRET=... node mint-local-token.mjs <projectId> [userId] [audience]");
  process.exit(1);
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64url(
  JSON.stringify({
    audience,
    exp: now + 900,
    iat: now,
    projectId,
    type: "project-app-session",
    userId,
  }),
);
const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
console.log(`${header}.${payload}.${signature}`);
