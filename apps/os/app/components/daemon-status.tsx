interface DaemonStatusProps {
  state: "starting" | "active" | "detached" | "archived";
  lastEvent?: {
    name: string;
    payload: Record<string, unknown>;
    createdAt: Date;
  } | null;
  pendingConsumers?: string[];
}

export function DaemonStatus({ state, lastEvent, pendingConsumers = [] }: DaemonStatusProps) {
  const lastEventName = lastEvent?.name ?? "null";
  const pendingConsumersRaw =
    pendingConsumers.length > 0 ? `[${pendingConsumers.join(",")}]` : "[]";

  return (
    <span className="font-mono text-xs text-muted-foreground break-all">
      {`state=${state} lastEvent=${lastEventName} pendingConsumers=${pendingConsumersRaw}`}
    </span>
  );
}
