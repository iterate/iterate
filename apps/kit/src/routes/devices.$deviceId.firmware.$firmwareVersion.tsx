import { useMemo, useRef, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@iterate-com/ui/components/alert";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import { CircleAlertIcon, UsbIcon } from "lucide-react";
import { z } from "zod";
import { FirmwareInstallButton } from "../components/firmware-install-button.tsx";
import {
  DEFAULT_DEVICE_ID,
  DEFAULT_FIRMWARE_VERSION,
  findFirmwareDevice,
  firmwareCatalog,
  isEspWebToolsRelease,
  resolveFirmwareRelease,
} from "../firmware/catalog.ts";
import { normalizeOsBaseUrl, type DeviceConfiguration } from "../firmware/config-image.ts";

const DEFAULT_OS_BASE_HOST = "os.iterate.com";
const Search = z.object({
  host: z.string().default(DEFAULT_OS_BASE_HOST).catch(DEFAULT_OS_BASE_HOST),
  project: z.string().default("").catch(""),
});

export const Route = createFileRoute("/devices/$deviceId/firmware/$firmwareVersion")({
  validateSearch: Search,
  beforeLoad: ({ params }) => {
    const device = findFirmwareDevice(params.deviceId);
    if (!device) {
      throw redirect({
        to: "/devices/$deviceId/firmware/$firmwareVersion",
        params: {
          deviceId: DEFAULT_DEVICE_ID,
          firmwareVersion: DEFAULT_FIRMWARE_VERSION,
        },
      });
    }
    if (
      params.firmwareVersion !== DEFAULT_FIRMWARE_VERSION &&
      !resolveFirmwareRelease(device, params.firmwareVersion)
    ) {
      throw redirect({
        to: "/devices/$deviceId/firmware/$firmwareVersion",
        params: {
          deviceId: device.id,
          firmwareVersion: DEFAULT_FIRMWARE_VERSION,
        },
      });
    }
  },
  component: KitPage,
});

const deviceItems = firmwareCatalog.map((device) => ({
  label: device.name,
  value: device.id,
}));
const horizontalFieldClassName =
  "grid gap-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-start sm:gap-4";

function KitPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const formRef = useRef<HTMLFormElement>(null);
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [projectApiKey, setProjectApiKey] = useState("");
  // beforeLoad redirects unknown IDs; the fallback also keeps hook order
  // stable during the redirect render.
  const device = findFirmwareDevice(params.deviceId) ?? firmwareCatalog[0]!;

  const release = resolveFirmwareRelease(device, params.firmwareVersion);
  const versionItems = [
    {
      label: release ? `Latest (${device.releases[0]?.version ?? release.version})` : "Latest",
      value: DEFAULT_FIRMWARE_VERSION,
    },
    ...device.releases.map((candidate) => ({
      label: candidate.version,
      value: candidate.version,
    })),
  ];
  const preparedConfiguration = useMemo<
    | { configuration: DeviceConfiguration; error?: undefined }
    | { configuration?: undefined; error: string }
  >(() => {
    try {
      return {
        configuration: {
          schemaVersion: 1,
          wifi: { ssid: wifiSsid, password: wifiPassword },
          iterate: {
            baseUrl: normalizeOsBaseUrl(search.host || DEFAULT_OS_BASE_HOST),
            projectSlug: search.project,
            projectApiKey,
          },
        },
      };
    } catch (error: unknown) {
      return {
        error: error instanceof Error ? error.message : "OS base host is invalid.",
      };
    }
  }, [projectApiKey, search.host, search.project, wifiPassword, wifiSsid]);

  return (
    <div className="grid w-full gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(28rem,1.2fr)] lg:gap-16">
      <section className="flex max-w-sm flex-col gap-6">
        <header className="flex items-center gap-3">
          <IterateLogo className="size-9" />
          <h1 className="text-xl font-semibold tracking-tight">Set up your device</h1>
        </header>
        <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            Connect an ESP32-S3 device to this computer over USB, choose its firmware, and enter the
            details alongside.
          </p>
          <p>
            Kit writes the Wi-Fi and Iterate credentials directly from this browser before flashing
            the device. Secrets never enter the page URL or the Kit Worker.
          </p>
        </div>
      </section>

      <section aria-label="Device configuration">
        <form ref={formRef} className="flex flex-col gap-6">
          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="device" className="sm:pt-2">
              Device
            </FieldLabel>
            <FieldContent>
              <Select
                items={deviceItems}
                value={device.id}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  void navigate({
                    to: "/devices/$deviceId/firmware/$firmwareVersion",
                    params: {
                      deviceId: value,
                      firmwareVersion: DEFAULT_FIRMWARE_VERSION,
                    },
                    search,
                  });
                }}
              >
                <SelectTrigger id="device" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {deviceItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{device.description}</FieldDescription>
            </FieldContent>
          </Field>

          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="firmware-version" className="sm:pt-2">
              Firmware
            </FieldLabel>
            <FieldContent>
              <Select
                items={versionItems}
                value={params.firmwareVersion}
                onValueChange={(value) => {
                  if (typeof value !== "string") return;
                  void navigate({
                    to: "/devices/$deviceId/firmware/$firmwareVersion",
                    params: { deviceId: device.id, firmwareVersion: value },
                    search,
                  });
                }}
              >
                <SelectTrigger id="firmware-version" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {versionItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </FieldContent>
          </Field>

          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="wifi-ssid" className="sm:pt-2">
              Wi-Fi network
            </FieldLabel>
            <FieldContent>
              <Input
                id="wifi-ssid"
                name="wifi-ssid"
                value={wifiSsid}
                onChange={(event) => setWifiSsid(event.target.value)}
                placeholder="Network name (SSID)"
                autoComplete="off"
                required
              />
            </FieldContent>
          </Field>

          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="wifi-password" className="sm:pt-2">
              Wi-Fi password
            </FieldLabel>
            <FieldContent>
              <Input
                id="wifi-password"
                name="wifi-password"
                type="password"
                value={wifiPassword}
                onChange={(event) => setWifiPassword(event.target.value)}
                autoComplete="new-password"
                required
              />
            </FieldContent>
          </Field>

          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="os-base-host" className="sm:pt-2">
              OS base host
            </FieldLabel>
            <FieldContent>
              <Input
                id="os-base-host"
                name="os-base-host"
                value={search.host}
                onChange={(event) => {
                  void navigate({
                    search: (previous) => ({ ...previous, host: event.target.value }),
                    replace: true,
                  });
                }}
                placeholder={DEFAULT_OS_BASE_HOST}
                required
              />
            </FieldContent>
          </Field>

          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="project-slug" className="sm:pt-2">
              Project slug
            </FieldLabel>
            <FieldContent>
              <Input
                id="project-slug"
                name="project-slug"
                value={search.project}
                onChange={(event) => {
                  void navigate({
                    search: (previous) => ({ ...previous, project: event.target.value }),
                    replace: true,
                  });
                }}
                placeholder="voice-lab"
                autoComplete="off"
                required
              />
            </FieldContent>
          </Field>

          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="project-api-key" className="sm:pt-2">
              Project API key
            </FieldLabel>
            <FieldContent>
              <Input
                id="project-api-key"
                name="project-api-key"
                type="password"
                value={projectApiKey}
                onChange={(event) => setProjectApiKey(event.target.value)}
                placeholder="itxk_…"
                autoComplete="new-password"
                required
              />
              <FieldDescription>
                Reveal <span className="font-mono">/secrets/project-api-key</span> in OS.
              </FieldDescription>
            </FieldContent>
          </Field>

          {!release && (
            <div className="grid sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
              <div className="sm:col-start-2">
                <Alert>
                  <CircleAlertIcon />
                  <AlertTitle>Firmware not published yet</AlertTitle>
                  <AlertDescription>
                    The installer is wired, but an Iterate-aware build for this device still needs
                    to be added to the firmware catalog.
                  </AlertDescription>
                </Alert>
              </div>
            </div>
          )}

          <div className="grid sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
            <div className="flex flex-col gap-2 sm:col-start-2">
              {release && isEspWebToolsRelease(release) && preparedConfiguration.configuration ? (
                <FirmwareInstallButton
                  configuration={preparedConfiguration.configuration}
                  device={device}
                  formRef={formRef}
                  release={release}
                />
              ) : (
                <>
                  <Button className="w-full" type="button" disabled>
                    <UsbIcon data-icon="inline-start" />
                    Flash device
                  </Button>
                  {preparedConfiguration.error && (
                    <p role="alert" className="text-xs text-destructive">
                      {preparedConfiguration.error}
                    </p>
                  )}
                </>
              )}
              <p className="text-xs text-muted-foreground">
                The link saves device, firmware, host, and project slug. Credentials stay private.
              </p>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
