import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MetaMcpError } from "../errors.ts";
import { MetaMcpServersFile, type MetaMcpConfig } from "./schema.ts";

function ensureParentDirectory(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function readOrCreateJsonFile(filePath: string, initialValue: unknown) {
  ensureParentDirectory(filePath);

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch {
    writeJsonFile(filePath, initialValue);
    return initialValue;
  }
}

function writeJsonFile(filePath: string, value: unknown) {
  ensureParentDirectory(filePath);
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readServersFile(serversPath: string): MetaMcpConfig {
  const parsed = MetaMcpServersFile.safeParse(readOrCreateJsonFile(serversPath, { servers: [] }));
  if (!parsed.success) {
    throw new MetaMcpError("INVALID_CONFIG", "Invalid meta MCP servers.json", {
      filePath: serversPath,
      issues: parsed.error.issues,
    });
  }

  return parsed.data;
}

export function writeServersFile(serversPath: string, serversFile: MetaMcpConfig): MetaMcpConfig {
  const parsed = MetaMcpServersFile.safeParse(serversFile);
  if (!parsed.success) {
    throw new MetaMcpError("INVALID_CONFIG", "Invalid meta MCP servers.json", {
      filePath: serversPath,
      issues: parsed.error.issues,
    });
  }

  writeJsonFile(serversPath, parsed.data);
  return parsed.data;
}

export function updateServersFile(
  serversPath: string,
  updater: (serversFile: MetaMcpConfig) => MetaMcpConfig,
): MetaMcpConfig {
  return writeServersFile(serversPath, updater(readServersFile(serversPath)));
}
