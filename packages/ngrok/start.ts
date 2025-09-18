#!/usr/bin/env node

import { spawn } from "child_process";

// Check if ITERATE_USER environment variable is set
const iterateUser = process.env.ITERATE_USER;
const port = process.env.PORT || 5173;

if (!iterateUser) {
  console.error("❌ Error: ITERATE_USER environment variable is not set");
  console.error("Please set ITERATE_USER before running ngrok:");
  console.error("  export ITERATE_USER=your-username");
  console.error("  pnpm dev");
  process.exit(1);
}

// Construct the ngrok URL
const ngrokUrl = `https://${iterateUser}.dev.iterate.com`;

console.log(`🚀 Starting ngrok tunnel to ${ngrokUrl}...`);

// Spawn the ngrok process
const ngrok = spawn("ngrok", ["http", "--url=" + ngrokUrl, port.toString(), "--log=stdout"], {
  stdio: "inherit",
});

// Handle process termination
ngrok.on("close", (code) => {
  console.log(`\n🛑 ngrok process exited with code ${code}`);
});

// Handle errors
ngrok.on("error", (error) => {
  console.error("❌ Failed to start ngrok:", error.message);
  process.exit(1);
});

// Handle SIGINT (Ctrl+C)
process.on("SIGINT", () => {
  console.log("\n🛑 Stopping ngrok...");
  ngrok.kill("SIGINT");
});
