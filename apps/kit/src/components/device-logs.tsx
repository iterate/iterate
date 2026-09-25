import { useMutation } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import { DialogFooter } from "@iterate-com/ui/components/dialog";
import type { openDeviceLogs } from "../firmware/flash-device.ts";

/**
 * A board's serial output, live, in esp-web-tools' console element (what its "Logs & Console"
 * showed), with Reset board to watch it boot and join Wi-Fi again, and Copy logs. `session` is
 * flash-device.ts `openDeviceLogs`'s, with its port open; `onBack` closes it.
 */
export function DeviceLogs({
  session: { logs, mount },
  onBack,
}: {
  session: Awaited<ReturnType<typeof openDeviceLogs>>;
  onBack: () => void;
}) {
  const resetting = useMutation({ mutationFn: () => logs.reset() });
  const copying = useMutation({ mutationFn: () => navigator.clipboard.writeText(logs.logs()) });

  return (
    <>
      {/* esp-web-tools' element, built with its port: placed here, not rendered by React */}
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
