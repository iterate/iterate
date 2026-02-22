import { Spinner } from "./ui/spinner.tsx";
import { getMachineStatus, type ConsumerInfo } from "./machine-status.ts";

interface DaemonStatusProps {
  state: "starting" | "active" | "detached" | "archived";
  lastEvent?: {
    name: string;
    payload: Record<string, unknown>;
    createdAt: Date;
  } | null;
  consumers?: ConsumerInfo[];
}

export function DaemonStatus({ state, lastEvent, consumers = [] }: DaemonStatusProps) {
  const { label, loading, errored } = getMachineStatus(state, lastEvent, consumers);

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
      {...(errored && { "data-type": "error" })}
    >
      {loading && <Spinner className="size-3" />}
      {label}
    </span>
  );
}
