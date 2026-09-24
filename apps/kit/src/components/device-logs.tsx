import { useCallback, useRef } from "react";
import { useMutation } from "@tanstack/react-query";
import type { EwtConsole } from "esp-web-tools/dist/components/ewt-console.js";
import { Button } from "@iterate-com/ui/components/button";
import { DialogFooter } from "@iterate-com/ui/components/dialog";

/**
 * A board's serial output, live, in esp-web-tools' console element (what its "Logs & Console"
 * showed), with Reset board to watch it boot and join Wi-Fi again, and Copy logs. `port` is open
 * (flash-device.ts `openDeviceLogs`); leaving this view closes it, so flashing or another tab can
 * open it next.
 */
export function DeviceLogs({ port, onBack }: { port: SerialPort; onBack: () => void }) {
  const logsRef = useRef<EwtConsole>(null);
  // The element reads `port` as it connects, so it's built here rather than rendered by React.
  // Stable per port: a new callback on each render would rebuild it and lose the logs.
  const mount = useCallback(
    (host: HTMLDivElement | null) => {
      if (!host) return;
      const logs = document.createElement("ewt-console");
      logs.port = port;
      logs.logger = console;
      logs.allowInput = false;
      logs.style.height = "100%";
      host.appendChild(logs);
      logsRef.current = logs;
      return () => {
        logsRef.current = null;
        logs.remove();
        void logs
          .disconnect()
          .then(() => port.close())
          .catch((error: unknown) => console.warn("kit.logs_close_failed", error));
      };
    },
    [port],
  );
  const resetting = useMutation({ mutationFn: () => logsRef.current!.reset() });
  const copying = useMutation({
    mutationFn: () => navigator.clipboard.writeText(logsRef.current!.logs()),
  });

  return (
    <>
      <div ref={mount} className="h-[60vh] overflow-hidden rounded-md" />
      {resetting.isError && (
        <p role="alert" data-type="error" className="text-destructive">
          Couldn’t reset the board: {resetting.error.message}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button type="button" variant="outline" onClick={() => copying.mutate()}>
          {copying.isSuccess ? "Copied" : "Copy logs"}
        </Button>
        <Button type="button" disabled={resetting.isPending} onClick={() => resetting.mutate()}>
          Reset board
        </Button>
      </DialogFooter>
    </>
  );
}
