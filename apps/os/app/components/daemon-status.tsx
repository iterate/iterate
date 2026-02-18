import { Circle, CheckCircle2, XCircle, RefreshCw, SearchCheck } from "lucide-react";

interface DaemonStatusProps {
  state: "starting" | "active" | "detached" | "archived";
  lastEvent?: {
    name: string;
    payload: Record<string, unknown>;
    createdAt: Date;
  } | null;
}

export function DaemonStatus({ state, lastEvent }: DaemonStatusProps) {
  if (state === "archived") {
    return <span className="text-muted-foreground text-sm">-</span>;
  }

  if (state === "detached") {
    return <span className="text-muted-foreground text-sm">Detached</span>;
  }

  const eventName = lastEvent?.name;

  // No event yet — machine just created, waiting for daemon to start
  if (!eventName) {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground text-sm">
        <Circle className="h-3 w-3 animate-pulse" />
        Starting...
      </span>
    );
  }

  if (eventName === "machine:probe-failed") {
    const detail = lastEvent?.payload?.detail as string | undefined;
    return (
      <span className="flex items-center gap-1.5 text-destructive text-sm" title={detail}>
        <XCircle className="h-3 w-3" />
        Error
      </span>
    );
  }

  if (eventName === "machine:restart-requested") {
    return (
      <span className="flex items-center gap-1.5 text-orange-600 text-sm">
        <RefreshCw className="h-3 w-3 animate-spin" />
        Restarting...
      </span>
    );
  }

  if (eventName === "machine:created") {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground text-sm">
        <Circle className="h-3 w-3 animate-pulse" />
        Provisioning...
      </span>
    );
  }

  if (eventName === "machine:daemon-ready" || eventName === "machine:probe-sent") {
    return (
      <span className="flex items-center gap-1.5 text-blue-600 text-sm">
        <SearchCheck className="h-3 w-3 animate-pulse" />
        Verifying...
      </span>
    );
  }

  // machine:probe-succeeded or machine:activated → ready
  return (
    <span className="flex items-center gap-1.5 text-green-600 text-sm">
      <CheckCircle2 className="h-3 w-3" />
      Ready
    </span>
  );
}
