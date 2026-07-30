import { resolve } from "node:path";
import {
  normalizeOsBaseUrl,
  type DeviceConfiguration,
} from "./config-image.ts";

export interface LocalFlashCliOptions {
  buildDirectory: string;
  configuration: DeviceConfiguration;
  dryRun: boolean;
  port: string;
}

type Environment = Readonly<Record<string, string | undefined>>;

export function parseLocalFlashCliOptions(
  args: readonly string[],
  environment: Environment,
  workingDirectory: string,
): LocalFlashCliOptions {
  const values: {
    baseUrl?: string;
    buildDirectory?: string;
    port?: string;
    projectId?: string;
    wifiSsid?: string;
  } = {};
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "--" && index === 0) continue;
    if (option === "--dry-run") {
      if (dryRun) throw new Error("Option --dry-run was provided more than once.");
      dryRun = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option ${option} requires a value.`);
    }
    index += 1;
    switch (option) {
      case "--base-url":
        setOnce(values, "baseUrl", value, option);
        break;
      case "--build-directory":
        setOnce(values, "buildDirectory", value, option);
        break;
      case "--port":
        setOnce(values, "port", value, option);
        break;
      case "--project-id":
        setOnce(values, "projectId", value, option);
        break;
      case "--wifi-ssid":
        setOnce(values, "wifiSsid", value, option);
        break;
      default:
        throw new Error(`Unknown option ${option}.`);
    }
  }

  const port = values.port ?? environment.ITERATE_KIT_PORT;
  const wifiSsid = values.wifiSsid ?? environment.ITERATE_KIT_WIFI_SSID;
  const projectId = values.projectId ?? environment.ITERATE_KIT_PROJECT_ID;
  const wifiPassword = environment.ITERATE_KIT_WIFI_PASSWORD;
  const projectApiKey = environment.ITERATE_KIT_PROJECT_API_KEY;
  const missing: string[] = [];
  if (!port) missing.push("--port or ITERATE_KIT_PORT");
  if (!wifiSsid) {
    missing.push("--wifi-ssid or ITERATE_KIT_WIFI_SSID");
  }
  if (!projectId) {
    missing.push("--project-id or ITERATE_KIT_PROJECT_ID");
  }
  if (wifiPassword === undefined) {
    missing.push("ITERATE_KIT_WIFI_PASSWORD");
  }
  if (!projectApiKey) {
    missing.push("ITERATE_KIT_PROJECT_API_KEY");
  }
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(", ")}.`);
  }
  const requiredPort = present(port);
  const requiredWifiSsid = present(wifiSsid);
  const requiredWifiPassword = present(wifiPassword);
  const requiredProjectId = present(projectId);
  const requiredProjectApiKey = present(projectApiKey);

  return {
    buildDirectory: resolve(
      workingDirectory,
      values.buildDirectory ?? ".build/m5sticks3",
    ),
    configuration: {
      schemaVersion: 1,
      wifi: {
        ssid: requiredWifiSsid,
        password: requiredWifiPassword,
      },
      iterate: {
        baseUrl: normalizeOsBaseUrl(
          values.baseUrl ??
            environment.ITERATE_KIT_OS_BASE_URL ??
            "https://os.iterate.com",
        ),
        projectId: requiredProjectId,
        projectApiKey: requiredProjectApiKey,
      },
    },
    dryRun,
    port: requiredPort,
  };
}

function present(value: string | undefined) {
  if (value === undefined) {
    throw new Error("Required flash option was lost after validation.");
  }
  return value;
}

function setOnce<Key extends keyof {
  baseUrl?: string;
  buildDirectory?: string;
  port?: string;
  projectId?: string;
  wifiSsid?: string;
}>(
  values: {
    baseUrl?: string;
    buildDirectory?: string;
    port?: string;
    projectId?: string;
    wifiSsid?: string;
  },
  key: Key,
  value: string,
  option: string,
) {
  if (values[key] !== undefined) {
    throw new Error(`Option ${option} was provided more than once.`);
  }
  values[key] = value;
}
