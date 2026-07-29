import type { RefObject } from "react";
import { useEffect, useState } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { UsbIcon } from "lucide-react";
import type { DeviceConfiguration } from "../firmware/config-image.ts";
import type { EspWebToolsFirmwareRelease, FirmwareDevice } from "../firmware/catalog.ts";
import {
  prepareInstallManifest,
  type PreparedInstallManifest,
} from "../firmware/prepare-manifest.ts";

type InstallerState =
  | { status: "loading" }
  | { status: "ready"; prepared: PreparedInstallManifest }
  | { status: "error"; message: string };

export function FirmwareInstallButton({
  configuration,
  device,
  formRef,
  release,
}: {
  configuration: DeviceConfiguration;
  device: FirmwareDevice;
  formRef: RefObject<HTMLFormElement | null>;
  release: EspWebToolsFirmwareRelease;
}) {
  const [state, setState] = useState<InstallerState>({ status: "loading" });

  useEffect(() => {
    let disposed = false;
    let prepared: PreparedInstallManifest | undefined;
    setState({ status: "loading" });

    const prepareInstaller = async () => {
      try {
        const [, nextPrepared] = await Promise.all([
          import("esp-web-tools"),
          prepareInstallManifest({ configuration, device, release }),
        ]);
        if (disposed) {
          nextPrepared.dispose();
          return;
        }
        prepared = nextPrepared;
        setState({ status: "ready", prepared: nextPrepared });
      } catch (error: unknown) {
        if (disposed) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Could not prepare the installer.",
        });
      }
    };

    void prepareInstaller();

    return () => {
      disposed = true;
      prepared?.dispose();
    };
  }, [configuration, device, release]);

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
        <Button className="w-full" type="button" disabled>
          <UsbIcon data-icon="inline-start" />
          Installer unavailable
        </Button>
        <p role="alert" className="text-xs text-destructive">
          {state.message}
        </p>
      </div>
    );
  }

  return (
    <esp-web-install-button manifest={state.prepared.manifestUrl}>
      <Button
        slot="activate"
        className="w-full"
        type="button"
        onClick={(event) => {
          if (formRef.current?.reportValidity() === false) {
            event.preventDefault();
            event.stopPropagation();
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
  );
}
