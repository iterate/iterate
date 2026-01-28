import * as path from "node:path";

// Get the config path from command line or use default
const configPath = process.argv[2] || path.resolve("../config/iterate.config.ts");

console.log(`Server starting...`);
console.log(`Loading config from: ${configPath}`);

async function loadConfig() {
  try {
    // Dynamic import of the config file
    // The slack SDK dependency is resolved from the config package's node_modules
    const configModule = await import(configPath);

    console.log("\n--- Config loaded successfully! ---");
    console.log("Exports:", Object.keys(configModule));

    if (configModule.config) {
      console.log("\nConfig object:", configModule.config);
    }

    if (configModule.getSlackInfo) {
      console.log("\nCalling getSlackInfo()...");
      const result = configModule.getSlackInfo();
      console.log("Result:", result);
    }

    console.log("\n--- Server running (watching for changes) ---\n");
  } catch (error) {
    console.error("Failed to load config:", error);
  }
}

loadConfig();
