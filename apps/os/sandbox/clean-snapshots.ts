import { Daytona } from "@daytonaio/sdk";

const daytona = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
});

// List all snapshots
const snapshots = await daytona.snapshot.list();
console.log("Total snapshots:", snapshots.length);

// Filter snapshots that don't start with "iterate-"
const toDelete = snapshots.filter((s) => !s.name.startsWith("iterate-"));
console.log(`\nSnapshots to delete (${toDelete.length}):`);
toDelete.forEach((s) => console.log(`  - ${s.name}`));

if (toDelete.length === 0) {
  console.log("\nNo snapshots to delete.");
  process.exit(0);
}

// Delete each non-iterate snapshot
console.log("\nDeleting snapshots...");
for (const snapshot of toDelete) {
  try {
    await daytona.snapshot.delete(snapshot.name);
    console.log(`  ✓ Deleted: ${snapshot.name}`);
  } catch (error) {
    console.error(`  ✗ Failed to delete ${snapshot.name}:`, error);
  }
}

console.log("\nDone!");
