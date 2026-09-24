import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { UsbIcon } from "lucide-react";
import type { DeviceConfiguration } from "../firmware/config-image.ts";
import type { FirmwareDevice } from "../firmware/catalog.ts";
import { prepareInstallManifest, type FirmwareManifest } from "../firmware/prepare-manifest.ts";

type InstallerState = { status: "loading" | "ready" } | { status: "error"; message: string };

/** Flashes `manifest`, a release the route already loaded and checked, with this install's
 *  configuration; esp-web-tools itself loads on mount. */
export function FirmwareInstallButton({
  configuration,
  device,
  formRef,
  manifest,
}: {
  configuration: DeviceConfiguration;
  device: FirmwareDevice;
  formRef: RefObject<HTMLFormElement | null>;
  manifest: FirmwareManifest;
}) {
  const [state, setState] = useState<InstallerState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [activationError, setActivationError] = useState<string>();
  const installerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let disposed = false;
    setState({ status: "loading" });
    import("esp-web-tools").then(
      () => {
        if (!disposed) setState({ status: "ready" });
      },
      (error: unknown) => {
        if (disposed) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not load the installer.",
        });
      },
    );
    return () => {
      disposed = true;
    };
  }, [attempt]);

  if (state.status === "loading") {
    return (
      <Button className="w-full" type="button" disabled>
        <UsbIcon data-icon="inline-start" />
        Preparing firmware…
      </Button>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex w-full flex-col gap-2">
        <Button className="w-full" type="button" onClick={() => setAttempt((value) => value + 1)}>
          <UsbIcon data-icon="inline-start" />
          Retry installer
        </Button>
        <p role="alert" data-type="error" className="text-xs text-destructive">
          {state.message}
        </p>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <esp-web-install-button ref={installerRef} className="block w-full">
        <Button
          slot="activate"
          className="w-full"
          type="button"
          onClickCapture={(event) => {
            if (formRef.current?.reportValidity() === false) {
              event.preventDefault();
              event.stopPropagation();
              return;
            }
            try {
              installerRef.current?.setAttribute(
                "manifest",
                prepareInstallManifest(manifest, device, configuration),
              );
              setActivationError(undefined);
            } catch (error: unknown) {
              event.preventDefault();
              event.stopPropagation();
              setActivationError(
                error instanceof Error ? error.message : "Could not prepare the installer.",
              );
            }
          }}
        >
          <UsbIcon data-icon="inline-start" />
          Flash device
        </Button>
        <p slot="not-allowed" className="text-sm text-destructive">
          Device flashing needs HTTPS or localhost.
        </p>
        <p slot="unsupported" className="text-sm text-destructive">
          This browser does not support Web Serial. Open this page in Chrome or Edge on desktop.
        </p>
      </esp-web-install-button>
      {activationError && (
        <p role="alert" data-type="error" className="text-xs text-destructive">
          {activationError}
        </p>
      )}
    </div>
  );
}
