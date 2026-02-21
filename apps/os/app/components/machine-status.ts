import * as R from "remeda";

export interface ConsumerInfo {
  name: string;
  status: "pending" | "retrying" | "failed";
  readCount: number;
  lastResult: string | null;
}

const properCase = (str: string) => {
  const words = R.toKebabCase(str).split("-").join(" ");
  return words.slice(0, 1).toUpperCase() + words.slice(1);
};

/**
 * Derive a human-readable status from machine state + pipeline progress.
 *
 * Returns `{ label, loading }` where `loading` means the machine is mid-pipeline
 * and the UI should show a spinner / "..." text so the spinner-waiter picks it up.
 */
export function getMachineStatus(
  state: "starting" | "active" | "detached" | "archived",
  lastEvent?: {
    name: string;
    payload: Record<string, unknown>;
    createdAt: Date;
  } | null,
  consumers: ConsumerInfo[] = [],
): { label: string; loading: boolean } {
  if (state === "active" || state === "archived" || state === "detached") {
    return { label: properCase(state), loading: false };
  }

  // state === "starting" — derive progress from pipeline events
  const unique = R.uniqueBy(consumers, (c) => c.name);
  const current = properCase(lastEvent?.name?.replace("machine:", "") || state);

  if (unique.length > 0) {
    // Show the most interesting consumer: failed > retrying > pending
    const byPriority = R.sortBy(unique, [
      (c) => (c.status === "failed" ? 0 : c.status === "retrying" ? 1 : 2),
      "asc",
    ]);
    const top = byPriority[0];
    const consumerLabel = properCase(top.name).toLowerCase();

    if (top.status === "failed") {
      return { loading: false, label: `Failed: ${consumerLabel}` };
    }
    if (top.status === "retrying") {
      return {
        loading: true,
        label: `Retrying ${consumerLabel} (attempt ${top.readCount + 1})...`,
      };
    }
    return { loading: true, label: `${current}. Running ${consumerLabel}...` };
  }

  return { label: `Status: ${current}. Waiting...`, loading: true };
}
