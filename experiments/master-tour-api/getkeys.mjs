/**
 * Master Tour API - Step 1: Get OAuth keys
 *
 * The Eventric API uses OAuth 1.0a for signing requests.
 * First, you exchange username/password for a key/secret pair via the getkeys endpoint.
 * Then you use that key/secret to sign all subsequent API requests.
 *
 * Usage:
 *   MASTERTOUR_USERNAME=you@example.com MASTERTOUR_PASSWORD=yourpass node getkeys.mjs
 */

const BASE_URL = "https://my.eventric.com/portal/api/v5";

async function getKeys(username, password) {
  const url = new URL(`${BASE_URL}/getkeys`);
  url.searchParams.set("username", username);
  url.searchParams.set("password", password);
  url.searchParams.set("version", "10");

  console.log(`\nRequesting keys from: ${url.origin}${url.pathname}`);
  console.log(`(credentials redacted from log)\n`);

  const res = await fetch(url.toString());

  console.log(`Status: ${res.status} ${res.statusText}`);
  console.log(`Content-Type: ${res.headers.get("content-type")}`);

  const body = await res.text();

  try {
    const json = JSON.parse(body);
    console.log("\nResponse JSON:");
    console.log(JSON.stringify(json, null, 2));
    return json;
  } catch {
    console.log("\nRaw response body:");
    console.log(body.slice(0, 2000));
    return null;
  }
}

// --- Main ---
const username = process.env.MASTERTOUR_USERNAME;
const password = process.env.MASTERTOUR_PASSWORD;

if (!username || !password) {
  console.log("Master Tour API - getkeys endpoint PoC\n");
  console.log("Set MASTERTOUR_USERNAME and MASTERTOUR_PASSWORD env vars to authenticate.");
  console.log("Running with dummy credentials to prove the API shape...\n");

  // Use dummy creds to show we get a proper 400 / auth error rather than a 404
  await getKeys("test@example.com", "not-a-real-password");
} else {
  await getKeys(username, password);
}
