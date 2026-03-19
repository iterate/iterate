/**
 * Master Tour API Demo
 *
 * Demonstrates the full auth flow and API usage.
 *
 * Usage:
 *   cd experiments/master-tour-api
 *   pnpm install
 *   MASTERTOUR_USERNAME=you@example.com MASTERTOUR_PASSWORD=yourpass node demo.mjs
 */

import { getKeys, createClient } from "./client.mjs";

const username = process.env.MASTERTOUR_USERNAME;
const password = process.env.MASTERTOUR_PASSWORD;

if (!username || !password) {
  console.error("Set MASTERTOUR_USERNAME and MASTERTOUR_PASSWORD env vars.");
  process.exit(1);
}

// Step 1: Exchange credentials for OAuth key/secret
console.log("1. Exchanging credentials for OAuth keys...");
const { key, secret, raw } = await getKeys(username, password);
console.log(`   Got key: ${key.slice(0, 8)}...`);
console.log(`   Raw key data:`, raw);

// Step 2: Create authenticated client
console.log("\n2. Creating authenticated client...");
const mt = createClient(key, secret);

// Step 3: List tours
console.log("\n3. Fetching tours...");
const toursRes = await mt.getTours();
console.log(`   Success: ${toursRes.success}`);
console.log(`   Tours: ${toursRes.data?.length ?? 0}`);

if (toursRes.data?.length > 0) {
  const tour = toursRes.data[0];
  console.log(`\n   First tour: ${tour.name ?? tour.title ?? JSON.stringify(tour).slice(0, 100)}`);

  // Step 4: Get tour details
  console.log(`\n4. Fetching tour details for ${tour.id}...`);
  const tourDetail = await mt.getTour(tour.id);
  console.log(`   Days: ${tourDetail.data?.days?.length ?? "unknown"}`);
  console.log(`   Detail keys: ${Object.keys(tourDetail.data ?? {}).join(", ")}`);

  // Step 5: Get crew
  console.log(`\n5. Fetching crew for tour ${tour.id}...`);
  const crew = await mt.getCrew(tour.id);
  console.log(`   Crew members: ${crew.data?.length ?? 0}`);
}

console.log("\nDone.");
