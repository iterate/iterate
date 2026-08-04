import type { DeviceConfiguration } from "./config-image.ts";

/**
 * Changes only the network credential in an already-provisioned image. The
 * device's project token and the two production origins are identities, not
 * convenient defaults: regenerating or guessing them during a Wi-Fi move can
 * produce a board that reaches the Internet but silently mounts in the wrong
 * project. Starting from decoded flash bytes makes preservation structural.
 */
export function withReprovisionedWifi(
  existing: DeviceConfiguration,
  wifi: DeviceConfiguration["wifi"],
): DeviceConfiguration {
  return {
    ...existing,
    wifi: { ...wifi },
    iterate: { ...existing.iterate },
  };
}

/**
 * Verifies the bytes read back after the bounded partition write without
 * putting any secret value into an exception. A successful esptool `--verify`
 * proves what was transmitted during that process; a separate decode/readback
 * proves the application-visible config and catches offset/build drift.
 */
export function assertWifiReprovisionReadback(
  before: DeviceConfiguration,
  expected: DeviceConfiguration,
  actual: DeviceConfiguration,
) {
  const mismatches: string[] = [];
  if (actual.schemaVersion !== expected.schemaVersion) mismatches.push("schema version");
  if (actual.wifi.ssid !== expected.wifi.ssid) mismatches.push("Wi-Fi network name");
  if (actual.wifi.password !== expected.wifi.password) mismatches.push("Wi-Fi password");
  if (actual.iterate.baseUrl !== before.iterate.baseUrl) mismatches.push("OS origin");
  if (actual.iterate.pcmBaseUrl !== before.iterate.pcmBaseUrl) mismatches.push("PCM origin");
  if (actual.iterate.projectId !== before.iterate.projectId) mismatches.push("project ID");
  if (actual.iterate.projectApiKey !== before.iterate.projectApiKey) {
    mismatches.push("project API key");
  }
  if (mismatches.length > 0) {
    throw new Error(`Wi-Fi reprovision readback mismatch: ${mismatches.join(", ")}.`);
  }
}
