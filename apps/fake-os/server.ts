import { runBuiltServer } from "./scripts/start.ts";

const code = await runBuiltServer({
  env: process.env,
});

process.exit(code);
