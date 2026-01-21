import { Circle, CheckCircle2, XCircle, RefreshCw } from "lucide-react";

type DaemonStatusValue = "ready" | "error" | "restarting" | "stopping" | undefined;

interface DaemonStatusProps {
  state: "starting" | "active" | "archived";
  daemonStatus?: DaemonStatusValue;
  daemonReadyAt?: string;
  daemonStatusMessage?: string;
}

export function DaemonStatus({
  state,
  daemonStatus,
  daemonReadyAt,
  daemonStatusMessage,
}: DaemonStatusProps) {
  if (state === "archived") {
    return <span className="text-muted-foreground text-sm">-</span>;
  }

  if (!daemonStatus) {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground text-sm">
        <Circle className="h-3 w-3 animate-pulse" />
        Starting...
      </span>
    );
  }

  if (daemonStatus === "error") {
    return (
      <span
        className="flex items-center gap-1.5 text-destructive text-sm"
        title={daemonStatusMessage}
      >
        <XCircle className="h-3 w-3" />
        Error
      </span>
    );
  }

  if (daemonStatus === "restarting") {
    return (
      <span className="flex items-center gap-1.5 text-orange-600 text-sm">
        <RefreshCw className="h-3 w-3 animate-spin" />
        Restarting...
      </span>
    );
  }

  if (daemonStatus === "stopping") {
    return (
      <span className="flex items-center gap-1.5 text-orange-600 text-sm">
        <Circle className="h-3 w-3 animate-pulse" />
        Stopping...
      </span>
    );
  }

  return (
    <span
      className="flex items-center gap-1.5 text-green-600 text-sm"
      title={daemonReadyAt ? `Ready since ${new Date(daemonReadyAt).toLocaleString()}` : undefined}
    >
      <CheckCircle2 className="h-3 w-3" />
      Ready
    </span>
  );
}
