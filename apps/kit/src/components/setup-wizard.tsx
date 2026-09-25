import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseMutationResult } from "@tanstack/react-query";
import { Button } from "@iterate-com/ui/components/button";
import { Checkbox } from "@iterate-com/ui/components/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@iterate-com/ui/components/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Spinner } from "@iterate-com/ui/components/spinner";
import { UsbIcon } from "lucide-react";
import type { FirmwareDevice } from "../firmware/catalog.ts";
import type { DeviceConfiguration } from "../firmware/config-image.ts";
import {
  closeDeviceLogs,
  flashDevice,
  openDeviceLogs,
  type FlashProgress,
} from "../firmware/flash-device.ts";
import type { FirmwareManifest } from "../firmware/prepare-manifest.ts";
import { DeviceLogs } from "./device-logs.tsx";

/** What the setup form hands the wizard: a snapshot of the fields when it was submitted. */
export interface SetupInput {
  project: { id: string; slug: string };
  openaiKey: string;
  wifi: { ssid: string; password: string };
}

/**
 * Setting up a board, start to finish, in one dialog: prepare the project (`preparing`, which the
 * page's form starts), say what the browser is about to ask, flash, then say what to do with the
 * board. Each step is the state of a mutation, so there is nothing else to keep in sync: the
 * dialog is open while `preparing` has been started, and closing it resets them all. Show logs
 * (`logging`) covers whichever step it was opened from, and Back returns there.
 */
export function SetupWizard({
  preparing,
  device,
  manifest,
}: {
  preparing: UseMutationResult<DeviceConfiguration, Error, SetupInput>;
  device: FirmwareDevice;
  manifest: FirmwareManifest;
}) {
  const queryClient = useQueryClient();
  const flashing = useMutation({
    mutationFn: (input: { configuration: DeviceConfiguration; erase: boolean; attempt: string }) =>
      flashDevice({
        manifest,
        device,
        configuration: input.configuration,
        erase: input.erase,
        onProgress: (progress) =>
          queryClient.setQueryData(flashProgressKey(input.attempt), progress),
      }),
  });
  const logging = useMutation({ mutationFn: openDeviceLogs });
  // Back from the logs waits for the port to close, so the next Choose port or Show logs can open it
  const closingLogs = useMutation({
    mutationFn: closeDeviceLogs,
    onSettled: () => logging.reset(),
  });
  // `flashDevice` reports progress into the query cache, one entry per attempt; this reads it back
  const progress = useQuery<FlashProgress>({
    queryKey: flashProgressKey(flashing.variables?.attempt),
    queryFn: skipToken,
  }).data;

  return (
    <Dialog
      open={!preparing.isIdle}
      onOpenChange={(open) => {
        // a board unplugged mid-write has to be flashed again, so the wizard stays until it's done
        if (open || flashing.isPending) return;
        const resetAll = () => {
          preparing.reset();
          flashing.reset();
          logging.reset();
        };
        if (logging.isSuccess) closingLogs.mutate(logging.data, { onSettled: resetAll });
        else resetAll();
      }}
      disablePointerDismissal
    >
      <DialogContent
        showCloseButton={!flashing.isPending}
        className={logging.isIdle ? "sm:max-w-md" : "sm:max-w-3xl"}
      >
        {logging.isIdle ? (
          <>
            {preparing.isPending && (
              <>
                <DialogHeader>
                  <DialogTitle>Preparing {preparing.variables.project.slug}</DialogTitle>
                  <DialogDescription>
                    Installing the voice agent if the project needs one, then creating the device’s
                    access token.
                  </DialogDescription>
                </DialogHeader>
                <Spinner />
              </>
            )}

            {preparing.isError && (
              <>
                <DialogHeader>
                  <DialogTitle>Couldn’t prepare {preparing.variables.project.slug}</DialogTitle>
                </DialogHeader>
                <p role="alert" data-type="error" className="text-destructive">
                  {preparing.error.message}
                </p>
                <DialogFooter showCloseButton>
                  <Button type="button" onClick={() => preparing.mutate(preparing.variables)}>
                    Try again
                  </Button>
                </DialogFooter>
              </>
            )}

            {preparing.isSuccess && flashing.isIdle && (
              <form
                className="contents"
                onSubmit={(event) => {
                  event.preventDefault();
                  flashing.mutate({
                    configuration: preparing.data,
                    erase: new FormData(event.currentTarget).has("erase"),
                    attempt: crypto.randomUUID(),
                  });
                }}
              >
                <DialogHeader>
                  <DialogTitle>Flash {device.name}</DialogTitle>
                  <DialogDescription>
                    {preparing.variables.project.slug} is ready. Next, write the firmware to the
                    board.
                  </DialogDescription>
                </DialogHeader>
                <ol className="flex list-decimal flex-col gap-2 pl-5">
                  <li>
                    Plug the board into this computer with a USB data cable (some only charge).
                  </li>
                  <li>
                    Click Choose port. Chrome lists serial ports: pick{" "}
                    <strong>USB JTAG/serial debug unit</strong> (cu.usbmodem… on a Mac, COM… on
                    Windows), not Bluetooth or debug-console, then Connect.
                  </li>
                  <li>Keep it plugged in until it’s done, a minute or two.</li>
                </ol>
                <Field orientation="horizontal">
                  <Checkbox id="erase" name="erase" defaultChecked />
                  <FieldContent>
                    <FieldLabel htmlFor="erase">Erase the board first</FieldLabel>
                    <FieldDescription>
                      Clears what other firmware left behind, such as Home Assistant’s. Slower, and
                      recommended the first time.
                    </FieldDescription>
                  </FieldContent>
                </Field>
                <DialogFooter>
                  {/* for a board that's already flashed: see what it's doing instead */}
                  <Button type="button" variant="outline" onClick={() => logging.mutate(undefined)}>
                    Show logs
                  </Button>
                  <Button type="submit">
                    <UsbIcon data-icon="inline-start" />
                    Choose port
                  </Button>
                </DialogFooter>
              </form>
            )}

            {flashing.isPending && (
              <>
                <DialogHeader>
                  <DialogTitle>Flashing {device.name}</DialogTitle>
                  <DialogDescription>Keep it plugged in and this tab open.</DialogDescription>
                </DialogHeader>
                <p aria-live="polite">{describe(progress)}</p>
                <progress
                  className="h-2 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary"
                  max={100}
                  // no value: an indeterminate bar, until writing says how far it is
                  value={progress?.state === "writing" ? progress.details.percentage : undefined}
                />
              </>
            )}

            {flashing.isError && (
              <>
                <DialogHeader>
                  <DialogTitle>Flashing didn’t finish</DialogTitle>
                </DialogHeader>
                <p role="alert" data-type="error" className="text-destructive">
                  {flashing.error.message}
                </p>
                <DialogFooter showCloseButton>
                  <Button type="button" variant="outline" onClick={() => logging.mutate(undefined)}>
                    Show logs
                  </Button>
                  <Button type="button" onClick={() => flashing.reset()}>
                    Try again
                  </Button>
                </DialogFooter>
              </>
            )}

            {preparing.isSuccess && flashing.isSuccess && (
              <>
                <DialogHeader>
                  <DialogTitle>{device.name} is set up</DialogTitle>
                  <DialogDescription>
                    It’s restarting, then it joins {preparing.variables.wifi.ssid}. That takes about
                    20 seconds.
                  </DialogDescription>
                </DialogHeader>
                <ol className="flex list-decimal flex-col gap-2 pl-5">
                  <li>{device.startCall}</li>
                  <li>
                    Ask “What’s my project called?” It should say “
                    {preparing.variables.project.slug}”.
                  </li>
                </ol>
                <p className="text-muted-foreground">
                  If it can’t connect, Show logs says what it’s doing. It only joins 2.4 GHz
                  networks; for a wrong network or password, flash it again.
                </p>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => logging.mutate(flashing.data)}
                  >
                    Show logs
                  </Button>
                  <DialogClose render={<Button />}>Done</DialogClose>
                </DialogFooter>
              </>
            )}
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{device.name} logs</DialogTitle>
              <DialogDescription>
                What the board prints over USB. Reset board restarts it, to watch it boot and join
                the Wi-Fi.
              </DialogDescription>
            </DialogHeader>
            {logging.isPending && (
              <p aria-live="polite">
                {logging.variables
                  ? "Opening the port…"
                  : "Pick the board in Chrome’s list of ports."}
              </p>
            )}
            {logging.isError && (
              <>
                <p role="alert" data-type="error" className="text-destructive">
                  {logging.error.message}
                </p>
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={() => logging.reset()}>
                    Back
                  </Button>
                  <Button type="button" onClick={() => logging.mutate(logging.variables)}>
                    Try again
                  </Button>
                </DialogFooter>
              </>
            )}
            {logging.isSuccess && (
              <DeviceLogs logs={logging.data} onBack={() => closingLogs.mutate(logging.data)} />
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function flashProgressKey(attempt: string | undefined) {
  return ["kit", "flash-progress", attempt];
}

function describe(progress: FlashProgress | undefined) {
  switch (progress?.state) {
    case undefined:
      return "Pick the board in Chrome’s list of ports.";
    case "initializing":
      return "Connecting to the board…";
    case "preparing":
      return "Downloading the firmware…";
    case "erasing":
      return "Erasing the board…";
    case "writing":
      return `Writing the firmware… ${progress.details.percentage}%`;
  }
}
