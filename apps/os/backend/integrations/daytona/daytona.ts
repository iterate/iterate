/**
 * Daytona SDK integration - preview token management.
 */
import { eq, and } from "drizzle-orm";
import { Daytona, type Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import * as schema from "../../db/schema.ts";
import type { DB } from "../../db/client.ts";

export type TokenDeps = {
  db: DB;
  daytona: Daytona;
};

async function resolveSandboxByIdentifier(
  daytona: Daytona,
  sandboxIdentifier: string,
): Promise<DaytonaSandbox> {
  try {
    return await daytona.get(sandboxIdentifier);
  } catch {
    const response = await daytona.list();
    const match = (response.items ?? []).find((sandbox) => sandbox.name === sandboxIdentifier);
    if (!match?.id) {
      throw new Error(`Daytona sandbox not found for identifier '${sandboxIdentifier}'`);
    }
    return daytona.get(match.id);
  }
}

/**
 * Get cached preview token or fetch fresh from Daytona SDK
 */
export async function getPreviewToken(
  deps: TokenDeps,
  machineId: string,
  sandboxIdentifier: string,
  port: number,
): Promise<string> {
  const cached = await deps.db.query.daytonaPreviewToken.findFirst({
    where: and(
      eq(schema.daytonaPreviewToken.machineId, machineId),
      eq(schema.daytonaPreviewToken.port, String(port)),
    ),
  });

  if (cached) {
    return cached.token;
  }

  return refreshPreviewToken(deps, machineId, sandboxIdentifier, port);
}

/**
 * Fetch fresh token from Daytona SDK and cache it
 */
export async function refreshPreviewToken(
  deps: TokenDeps,
  machineId: string,
  sandboxIdentifier: string,
  port: number,
): Promise<string> {
  const sandbox = await resolveSandboxByIdentifier(deps.daytona, sandboxIdentifier);
  const previewInfo = await sandbox.getPreviewLink(port);

  await deps.db
    .insert(schema.daytonaPreviewToken)
    .values({
      machineId,
      port: String(port),
      token: previewInfo.token,
    })
    .onConflictDoUpdate({
      target: [schema.daytonaPreviewToken.machineId, schema.daytonaPreviewToken.port],
      set: {
        token: previewInfo.token,
        updatedAt: new Date(),
      },
    });

  return previewInfo.token;
}
