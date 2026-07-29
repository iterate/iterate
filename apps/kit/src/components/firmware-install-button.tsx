import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { UsbIcon } from "lucide-react";
import type { DeviceConfiguration } from "../firmware/config-image.ts";
import type { EspWebToolsFirmwareRelease, FirmwareDevice } from "../firmware/catalog.ts";
import {
  loadInstallManifestTemplate,
  type InstallManifestTemplate,
} from "../firmware/prepare-manifest.ts";

type InstallerState =
  | { status: "loading" }
  | { status: "ready"; template: InstallManifestTemplate }
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
  const [activationError, setActivationError] = useState<string>();
  const installerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let disposed = false;
    setState({ status: "loading" });

    const prepareInstaller = async () => {
      try {
        const [, template] = await Promise.all([
          import("esp-web-tools"),
          loadInstallManifestTemplate({ device, release }),
        ]);
        if (disposed) return;
        setState({ status: "ready", template });
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
    };
  }, [device, release]);

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
              const prepared = state.template.prepare(configuration);
              installerRef.current?.setAttribute("manifest", prepared.manifestUrl);
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
        <p role="alert" className="text-xs text-destructive">
          {activationError}
        </p>
      )}
    </div>
  );
}
