/**
 * Shared test helpers for sandbox integration tests.
 */

import { DOCKER_API_URL, dockerApi } from "../backend/providers/local-docker.ts";

export { DOCKER_API_URL, dockerApi };

export function decodeDockerLogs(buffer: Uint8Array): string {
  const lines: string[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;

    const size =
      (buffer[offset + 4]! << 24) |
      (buffer[offset + 5]! << 16) |
      (buffer[offset + 6]! << 8) |
      buffer[offset + 7]!;

    offset += 8;
    if (offset + size > buffer.length) break;

    const line = new TextDecoder().decode(buffer.slice(offset, offset + size));
    lines.push(line);
    offset += size;
  }

  return lines.join("");
}

export async function execInContainer(containerId: string, cmd: string[]): Promise<string> {
  const execCreate = await dockerApi<{ Id: string }>("POST", `/containers/${containerId}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Cmd: cmd,
  });

  const response = await fetch(`${DOCKER_API_URL}/exec/${execCreate.Id}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Detach: false, Tty: false }),
  });

  const buffer = await response.arrayBuffer();
  return decodeDockerLogs(new Uint8Array(buffer));
}

export async function getContainerLogs(containerId: string): Promise<string> {
  const response = await fetch(
    `${DOCKER_API_URL}/containers/${containerId}/logs?stdout=true&stderr=true&timestamps=true`,
  );
  if (!response.ok) throw new Error("Failed to get logs");
  const buffer = await response.arrayBuffer();
  return decodeDockerLogs(new Uint8Array(buffer));
}

export async function waitForLogPattern(
  containerId: string,
  pattern: RegExp,
  timeoutMs = 60000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const logs = await getContainerLogs(containerId);
    if (pattern.test(logs)) return logs;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for log pattern: ${pattern}`);
}

export async function getServiceFileLogs(containerId: string, logPath: string): Promise<string> {
  return execInContainer(containerId, ["cat", logPath]);
}

export async function waitForFileLogPattern(
  containerId: string,
  logPath: string,
  pattern: RegExp,
  timeoutMs = 60000,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const logs = await execInContainer(containerId, ["cat", logPath]);
      if (pattern.test(logs)) return logs;
    } catch {
      // File might not exist yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timeout waiting for file log pattern in ${logPath}: ${pattern}`);
}
