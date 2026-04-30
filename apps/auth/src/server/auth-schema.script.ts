import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { formatSql } from "sqlfu/api";
import { generateSchema } from "auth/api";
import { getAdapter } from "better-auth/db/adapter";
import { getAuthPlugins } from "./auth-plugins.ts";

const db = new DatabaseSync(":memory:");
const options = {
  baseURL: "http://localhost:3000",
  database: db,
  plugins: getAuthPlugins({
    VITE_ENABLE_EMAIL_OTP_SIGNIN: "true",
    BETTER_AUTH_SECRET: "secret",
    BETTER_AUTH_URL: "http://localhost:3000",
    ...process.env,
  }),
};

const adapter = await getAdapter(options);
const { code } = await generateSchema({ adapter, options });

if (!code) throw new Error("Failed to generate schema for better-auth");

const oldDefinitions = await readFile(
  join(import.meta.dirname, "./db/definitions.sql"),
  "utf8",
).catch(() => "");

let newDefinitions: string;

const startMarker = "-- better-auth-schema BEGIN";
const endMarker = "-- better-auth-schema END";
if (oldDefinitions.trim()) {
  const startIndex = oldDefinitions.indexOf(startMarker);
  const endIndex = oldDefinitions.indexOf(endMarker, startIndex);

  if (startIndex === -1 || endIndex === -1)
    throw new Error("Failed to find better-auth schema markers in definitions");
  newDefinitions =
    oldDefinitions.slice(0, startIndex) +
    startMarker +
    "\n" +
    formatSql(code) +
    "\n" +
    oldDefinitions.slice(endIndex);
} else {
  newDefinitions = startMarker + "\n" + formatSql(code) + "\n" + endMarker;
}

await writeFile(join(import.meta.dirname, "./db/definitions.sql"), newDefinitions);
