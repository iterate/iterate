import { type Daytona, type Sandbox as DaytonaSandbox } from "@daytonaio/sdk";

export async function resolveDaytonaSandboxByIdentifier(
  daytona: Daytona,
  sandboxIdentifier: string,
): Promise<DaytonaSandbox> {
  try {
    const direct = await daytona.get(sandboxIdentifier);
    if (direct.id) return direct;
  } catch {
    // Identifier can be a sandbox name instead of Daytona's internal ID.
  }

  const response = await daytona.list();
  const match = (response.items ?? []).find((sandbox) => sandbox.name === sandboxIdentifier);
  if (!match?.id) {
    throw new Error(`Daytona sandbox not found for identifier '${sandboxIdentifier}'`);
  }
  return daytona.get(match.id);
}
