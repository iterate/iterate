import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@iterate-com/ui/components/button";
import { UsbIcon } from "lucide-react";
import type { DeviceConfiguration } from "../firmware/config-image.ts";
import {
  firmwareArtifactPath,
  type EspSerialFirmwareRelease,
  type FirmwareDevice,
} from "../firmware/catalog.ts";
import { flashFirmwareInBrowser } from "../firmware/browser-flasher.ts";
import { prepareFirmwareFlashPlan } from "../firmware/prepare-flash-plan.ts";

type InstallerState =
  | { status: "idle" }
  | { status: "flashing"; percent: number; detail: string }
  | { status: "success" }
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
  release: EspSerialFirmwareRelease;
}) {
  const [state, setState] = useState<InstallerState>({ status: "idle" });
  const [serialSupported, setSerialSupported] = useState<boolean>();
  const flashing = useRef(false);

  useEffect(() => {
    setSerialSupported("serial" in navigator);
  }, []);

  return (
    <div className="flex w-full flex-col gap-2">
      <Button
        className="w-full"
        type="button"
        disabled={serialSupported !== true || state.status === "flashing"}
        onClick={() => {
          if (formRef.current?.reportValidity() === false || flashing.current) return;
          flashing.current = true;
          setState({ status: "flashing", percent: 0, detail: "Preparing verified firmware…" });
          void (async () => {
            try {
              const plan = await prepareFirmwareFlashPlan({
                configuration,
                device,
                release,
                loadPart: async (part) => {
                  const response = await fetch(
                    firmwareArtifactPath(device.id, release.version, part.fileName),
                  );
                  if (!response.ok) {
                    throw new Error(
                      `${part.fileName} returned HTTP ${response.status}.`,
                    );
                  }
                  return new Uint8Array(await response.arrayBuffer());
                },
              });
              await flashFirmwareInBrowser(plan, {
                onLog: (detail) => {
                  const trimmed = detail.trim();
                  if (trimmed) {
                    setState((current) =>
                      current.status === "flashing" ? { ...current, detail: trimmed } : current,
                    );
                  }
                },
                onProgress: ({ fileIndex, totalBytes, writtenBytes }) => {
                  const percent =
                    totalBytes === 0 ? 0 : Math.round((writtenBytes / totalBytes) * 100);
                  setState({
                    status: "flashing",
                    percent,
                    detail: `Writing ${plan.parts[fileIndex]?.label ?? `part ${fileIndex + 1}`}…`,
                  });
                },
              });
              setState({ status: "success" });
            } catch (error: unknown) {
              setState({
                status: "error",
                message: error instanceof Error ? error.message : "Firmware flashing failed.",
              });
            } finally {
              flashing.current = false;
            }
          })();
        }}
      >
        <UsbIcon data-icon="inline-start" />
        {state.status === "flashing"
          ? `Flashing ${state.percent}%`
          : state.status === "success"
            ? "Flashed successfully"
            : "Flash device"}
      </Button>
      {serialSupported === false && (
        <p role="alert" className="text-xs text-destructive">
          Web Serial is unavailable. Open this page in Chrome or Edge on desktop.
        </p>
      )}
      {state.status === "flashing" && (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {state.detail}
        </p>
      )}
      {state.status === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {state.message}
        </p>
      )}
    </div>
  );
}
