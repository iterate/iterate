import { useRef, useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
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
import { LogOutIcon, UsbIcon } from "lucide-react";
import { ensureVoiceAgent, VoiceInstall } from "../../voice/install.ts";
import { dashEnvs, kitEnvs } from "../../../../../envs.ts";
import { FirmwareInstallButton } from "../../components/firmware-install-button.tsx";
import {
  DEFAULT_DEVICE_ID,
  DEFAULT_FIRMWARE_VERSION,
  findFirmwareDevice,
  firmwareCatalog,
  resolveFirmwareRelease,
} from "../../firmware/catalog.ts";
import { deviceVendors } from "../../firmware/device-client.ts";
import type { DeviceConfiguration } from "../../firmware/config-image.ts";

export const Route = createFileRoute("/_auth/devices/$deviceId/firmware/$firmwareVersion")({
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
  loader: async ({ context }) => ({ projects: await context.api.projects.list() }),
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
  const navigate = Route.useNavigate();
  const { api, info } = Route.useRouteContext();
  const { projects } = Route.useLoaderData();
  const formRef = useRef<HTMLFormElement>(null);
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  // beforeLoad redirects unknown IDs; the fallback also keeps hook order
  // stable during the redirect render.
  const device = findFirmwareDevice(params.deviceId) || firmwareCatalog[0]!;

  const release = resolveFirmwareRelease(device, params.firmwareVersion) || device.releases[0]!;
  const versionItems = [
    {
      label: `Latest (${device.releases[0]?.version || release.version})`,
      value: DEFAULT_FIRMWARE_VERSION,
    },
    ...device.releases.map((candidate) => ({
      label: candidate.version,
      value: candidate.version,
    })),
  ];
  const projectItems = projects.map((project) => ({ label: project.slug, value: project.id }));
  const preparationKey = JSON.stringify([projectId, device.id]);
  const [openaiKey, setOpenaiKey] = useState("");
  const [needsOpenaiKey, setNeedsOpenaiKey] = useState<string>();
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<{
    key: string;
    projectId: string;
    baseUrl: string;
    token: string;
  }>();
  const [preparationError, setPreparationError] = useState<{ key: string; message: string }>();
  const configuration: DeviceConfiguration | undefined =
    prepared?.key === preparationKey
      ? {
          wifi: { ssid: wifiSsid, password: wifiPassword },
          iterate: {
            baseUrl: prepared.baseUrl,
            projectId: prepared.projectId,
            projectApiKey: prepared.token,
          },
        }
      : undefined;

  return (
    <div className="grid w-full gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(28rem,1.2fr)] lg:gap-16">
      <section className="flex max-w-sm flex-col gap-6">
        <header className="flex items-center gap-3">
          <IterateLogo className="size-9" />
          <h1 className="text-xl font-semibold tracking-tight">Set up your device</h1>
        </header>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>Signed in as {info.principal.email || info.principal.actor}.</span>
          <form method="post" action="/.auth/logout">
            <Button type="submit" variant="outline" size="sm">
              <LogOutIcon data-icon="inline-start" />
              Log out
            </Button>
          </form>
        </div>
        <div className="flex flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            Open this page in Chrome or Edge on a computer. Connect your device with a USB data
            cable, choose its model, and enter your Wi-Fi.
          </p>
          <p>
            Choose the project the device belongs to. Prepare device installs a voice agent if your
            project needs one, then creates an access token for the device. The token is written to
            the device and can be revoked any time from your sessions list in OS.
          </p>
          <p>If your project needs an OpenAI API key, we’ll ask for it during setup.</p>
          <p>
            Flash device opens the USB port chooser. Select your device and keep it connected until
            installation finishes. It will restart and join your project.
          </p>
          <p>Wi-Fi and the token stay in this browser until they are written to the device.</p>
        </div>
      </section>

      <section aria-label="Device configuration">
        <form
          ref={formRef}
          className="flex flex-col gap-6"
          onSubmit={(event) => event.preventDefault()}
        >
          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="device" className="sm:pt-2">
              Device
            </FieldLabel>
            <FieldContent>
              <Select
                items={deviceItems}
                value={device.id}
                onValueChange={(value) => {
                  if (!value) return;
                  void navigate({
                    to: "/devices/$deviceId/firmware/$firmwareVersion",
                    params: {
                      deviceId: value,
                      firmwareVersion: DEFAULT_FIRMWARE_VERSION,
                    },
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
              <FieldDescription className="flex items-center gap-2">
                <img
                  src={`/vendors/${deviceVendors[device.id]!.icon}`}
                  alt={deviceVendors[device.id]!.name}
                  className="size-6 object-contain"
                />
                {device.description}
              </FieldDescription>
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
                  if (!value) return;
                  void navigate({
                    to: "/devices/$deviceId/firmware/$firmwareVersion",
                    params: { deviceId: device.id, firmwareVersion: value },
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
              />
              <FieldDescription>Leave empty for an open network.</FieldDescription>
            </FieldContent>
          </Field>

          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="project" className="sm:pt-2">
              Project
            </FieldLabel>
            <FieldContent>
              <Select
                items={projectItems}
                value={projectId}
                onValueChange={(value) => {
                  setProjectId(value || "");
                  setOpenaiKey("");
                }}
              >
                <SelectTrigger id="project" className="w-full" disabled={projects.length === 0}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {projectItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                {projects.length === 0 ? (
                  <>
                    You have no projects yet. Create one in{" "}
                    <a href={info.platformOrigin} className="underline underline-offset-2">
                      OS
                    </a>
                    , then reload this page.
                  </>
                ) : (
                  <>
                    The device gets its own access token for this project. Revoke it from{" "}
                    <a
                      href={`${dashEnvs.prd.baseUrl}/.auth/connect?${new URLSearchParams({ issuer: info.platformOrigin, next: "/sessions", scope: "iterate account organizations:write" })}`}
                      className="underline underline-offset-2"
                    >
                      your sessions
                    </a>{" "}
                    in OS.
                  </>
                )}
              </FieldDescription>
            </FieldContent>
          </Field>

          {needsOpenaiKey === projectId && (
            <Field className={horizontalFieldClassName}>
              <FieldLabel htmlFor="openai-key">OpenAI API key</FieldLabel>
              <FieldContent>
                <Input
                  id="openai-key"
                  type="password"
                  autoComplete="new-password"
                  value={openaiKey}
                  onChange={(event) => setOpenaiKey(event.target.value)}
                  required
                />
                <FieldDescription>
                  Your project needs an OpenAI key for voice calls. It is saved securely in your
                  project and is never written to the device.
                </FieldDescription>
              </FieldContent>
            </Field>
          )}
          <div className="grid sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
            <div className="flex flex-col gap-2 sm:col-start-2">
              {configuration ? (
                <FirmwareInstallButton
                  key={`${device.id}:${release.version}`}
                  configuration={configuration}
                  device={device}
                  formRef={formRef}
                  release={release}
                />
              ) : (
                <Button
                  className="w-full"
                  type="button"
                  disabled={preparing || projects.length === 0}
                  aria-busy={preparing}
                  onClick={async () => {
                    if (!formRef.current?.reportValidity()) return;
                    setPreparing(true);
                    setPreparationError(undefined);
                    try {
                      using itx = await api.projects.get(projectId);
                      const voice = await ensureVoiceAgent(
                        itx,
                        async () => {
                          const response = await fetch("/voice-install.json", {
                            signal: AbortSignal.timeout(30_000),
                          });
                          if (!response.ok)
                            throw new Error("Could not download voice setup. Please try again.");
                          return VoiceInstall.parse(await response.json());
                        },
                        openaiKey,
                      );
                      if (voice === "needs-openai-key") {
                        setNeedsOpenaiKey(projectId);
                        return;
                      }
                      setOpenaiKey("");
                      setNeedsOpenaiKey(undefined);
                      const { token } = await api.grants.mint({
                        name: `Kit ${device.name} ${new Date().toISOString().slice(0, 10)}`,
                        projects: [projectId],
                        // The issuer must fetch public HTTPS metadata, including during local development.
                        clientId: `${kitEnvs.prd.baseUrl}/devices/${device.id}/clients/${crypto.randomUUID()}.json`,
                        // The device can neither refresh nor reflash itself: it is retired by
                        // revocation from the sessions list, not by expiry.
                        expiresAt: Date.now() + 10 * 365 * 24 * 3600_000,
                      });
                      setPrepared({
                        key: preparationKey,
                        projectId,
                        baseUrl: info.platformOrigin,
                        token,
                      });
                    } catch (error: unknown) {
                      setPreparationError({
                        key: preparationKey,
                        message:
                          error instanceof Error ? error.message : "Could not prepare your device.",
                      });
                    } finally {
                      setPreparing(false);
                    }
                  }}
                >
                  <UsbIcon data-icon="inline-start" />
                  {preparing ? "Preparing your project…" : "Prepare device"}
                </Button>
              )}
              {preparationError?.key === preparationKey && (
                <p role="alert" className="text-xs text-destructive">
                  {preparationError.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                The link saves device and firmware. Wi-Fi and the token stay private.
              </p>
            </div>
          </div>
        </form>
      </section>
    </div>
  );
}
