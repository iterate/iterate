import type { ComponentProps } from "react";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { z } from "zod";
import { Button } from "@iterate-com/ui/components/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@iterate-com/ui/components/field";
import { Input } from "@iterate-com/ui/components/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
} from "@iterate-com/ui/components/input-group";
import { IterateLogo } from "@iterate-com/ui/components/iterate-logo";
import { SecretInput } from "@iterate-com/ui/components/not-recorded";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@iterate-com/ui/components/select";
import { EyeIcon, EyeOffIcon, LogOutIcon, UsbIcon } from "lucide-react";
import { ensureVoiceAgent, fetchVoiceInstall } from "../../../../agents/voice/install.ts";
import { SetupWizard, type SetupInput } from "../../components/setup-wizard.tsx";
import { isStatusVoice, statusVoices } from "../../firmware/config-image.ts";
import {
  DEFAULT_DEVICE_ID,
  DEFAULT_FIRMWARE_VERSION,
  FIRMWARE_REPOSITORY,
  findFirmwareDevice,
  firmwareReleaseTag,
} from "../../firmware/catalog.ts";
import { deviceVendors } from "../../firmware/device-client.ts";
import { selectFirmware } from "../../firmware/releases.ts";

export const Route = createFileRoute("/_auth/devices/$deviceId/firmware/$firmwareVersion")({
  // the project's slug, so the OpenAI key check below follows the picker (and a link keeps it)
  validateSearch: z.object({ project: z.string().optional().catch(undefined) }),
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
    return { device };
  },
  // In the browser (`_auth` is `ssr: false`), which lists the releases itself (releases.ts). A
  // version that is not released stays in the URL and shows as the picker's problem, not a redirect.
  loader: async ({ context, params }) => {
    const [projects, firmware] = await Promise.all([
      context.api.projects.list(),
      selectFirmware(context.device, params.firmwareVersion, fetch),
    ]);
    return { projects, firmware };
  },
  // Picking a project changes only the search: keep the projects and releases as loaded instead of
  // listing them again (GitHub rate-limits the release list per address). A reload refreshes them.
  staleTime: Infinity,
  component: KitPage,
});

/** The root loader's: this deployment's dash, when it has one (routes/__root.tsx). */
const root = getRouteApi("__root__");

const horizontalFieldClassName =
  "grid gap-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-start sm:gap-4";

// TODO: feedback from flashing a Home Assistant Voice Preview Edition against a self-hosted platform:
// - a board whose platform has gone away just fails its calls; nothing tells the person
// - Log out is blocked by a platform that's gone, like device login was (the shared app-server sign-out)
function KitPage() {
  const params = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { api, info, deviceSession, device } = Route.useRouteContext();
  const { projects, firmware } = Route.useLoaderData();
  const { dashOrigin } = root.useLoaderData();
  const queryClient = useQueryClient();
  const project = projects.find((candidate) => candidate.slug === search.project) || projects[0];
  const newest = firmware.versions[0];
  const versionItems = [
    { label: newest ? `Latest (${newest})` : "Latest", value: DEFAULT_FIRMWARE_VERSION },
    ...firmware.versions.map((version) => ({ label: version, value: version })),
    // the Select shows only listed values, so an unreleased version in the URL is listed as such
    ...(params.firmwareVersion === DEFAULT_FIRMWARE_VERSION ||
    firmware.versions.includes(params.firmwareVersion)
      ? []
      : [
          {
            label: `${params.firmwareVersion} (not published)`,
            value: params.firmwareVersion,
          },
        ]),
  ];
  const projectItems = projects.map((item) => ({ label: item.slug, value: item.slug }));
  // asked as soon as a project is picked, so its key goes in with the Wi-Fi instead of after a
  // failed first try
  const openaiKey = useQuery({
    queryKey: ["kit", "has-openai-key", project?.id],
    queryFn: project
      ? async () => {
          using itx = await api.projects.get(project.id);
          const secrets = await itx.secrets.list();
          return secrets.some((secret) => secret.path === "/secrets/openai");
        }
      : skipToken,
  });
  // Chrome and Edge on a computer, over HTTPS; without it nothing is prepared that can't be flashed
  const webSerial = "serial" in navigator;
  const platformHost = new URL(info.platformOrigin).host;
  const preparing = useMutation({
    mutationFn: async (input: SetupInput) => {
      try {
        using itx = await api.projects.get(input.project.id);
        const voice = await ensureVoiceAgent(itx, fetchVoiceInstall, input.openaiKey);
        if (voice === "needs-openai-key")
          throw new Error(`${input.project.slug} needs an OpenAI API key. Close this and add one.`);
        const { token } = await api.grants.mint({
          name: `Kit ${device.name} ${new Date().toISOString().slice(0, 10)}`,
          projects: [input.project.id],
          // The same identity the person saw and authorized, chosen before login: the key is
          // listed as this device.
          clientId: deviceSession.clientId,
          // No `expiresAt`: the device cannot reflash itself, so its key never expires and is
          // retired by revocation from the sessions list.
        });
        return {
          wifi: input.wifi,
          iterate: {
            baseUrl: info.platformOrigin,
            projectId: input.project.id,
            projectApiKey: token,
          },
          statusVoice: input.statusVoice,
        };
      } catch (error) {
        // capnweb says `Peer closed WebSocket: 1006`; `api` opens a fresh socket on its next call
        if (error instanceof Error && /WebSocket/.test(error.message))
          throw new ConnectionDropped(`The connection to ${platformHost} dropped. Try again.`, {
            cause: error,
          });
        throw error;
      }
    },
    // Once, for a dropped connection (what the dogfood's first try hit): the voice install is safe
    // to repeat, and a repeated mint at worst lists one unused token in the sessions list.
    retry: (failures, error) => failures < 1 && error instanceof ConnectionDropped,
    onSuccess: (_configuration, input) =>
      queryClient.invalidateQueries({ queryKey: ["kit", "has-openai-key", input.project.id] }),
  });

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
            Open this page in Chrome or Edge on a computer, and connect your device with a USB data
            cable.
          </p>
          <p>
            Flash device installs a voice agent in your project if it needs one, creates an access
            token for the device, then writes the firmware, your Wi-Fi and the token to it. You can
            revoke the token any time from your sessions list in OS.
          </p>
          <p>
            The browser can remember your Wi-Fi for next time, in its password manager. The token
            never leaves this page except to the device.
          </p>
        </div>
      </section>

      <section aria-label="Device configuration">
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (!project) return;
            const form = new FormData(event.currentTarget);
            const wifi = {
              ssid: String(form.get("wifi-ssid")),
              password: String(form.get("wifi-password")),
            };
            // Chrome offers to save it, then fills these fields next time (they're marked
            // username and current-password); an open network has nothing to keep
            if (wifi.password && "PasswordCredential" in window)
              navigator.credentials
                .store(new PasswordCredential({ id: wifi.ssid, password: wifi.password }))
                .catch((error: unknown) => console.warn("kit.wifi_not_saved", error));
            const statusVoice = String(form.get("status-voice"));
            if (!isStatusVoice(statusVoice)) throw new Error(`Unknown status voice ${statusVoice}`);
            preparing.mutate({
              project,
              openaiKey: String(form.get("openai-key") || ""),
              wifi,
              statusVoice,
            });
          }}
        >
          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="device" className="sm:pt-2">
              Device
            </FieldLabel>
            <FieldContent>
              <div className="flex flex-wrap items-center justify-between gap-2 sm:pt-2">
                <span id="device">{device.name}</span>
                {/* through Kit's connect route (device-auth.ts): back to device selection, keeping
                    this session's platform when it isn't the default one */}
                <a
                  href={`/.auth/connect?${new URLSearchParams({ issuer: info.platformOrigin, next: `/devices/${device.id}/firmware/${DEFAULT_FIRMWARE_VERSION}` })}`}
                  className="text-xs underline underline-offset-4"
                >
                  Set up another device
                </a>
              </div>
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
                    // keep the picked project: without it the picker falls back to the first one
                    search: (previous) => previous,
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
              {firmware.manifest ? (
                <FieldDescription>
                  {firmware.version !== newest && (
                    <>Older releases may not work with the current platform. </>
                  )}
                  {/* a new tab keeps what is typed on this page */}
                  <a
                    href={`https://github.com/${FIRMWARE_REPOSITORY}/releases/tag/${firmwareReleaseTag(device.id, firmware.version)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Release notes
                  </a>
                </FieldDescription>
              ) : (
                <p role="alert" data-type="error" className="text-sm text-destructive">
                  {firmware.problem}
                </p>
              )}
            </FieldContent>
          </Field>

          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="project" className="sm:pt-2">
              Project
            </FieldLabel>
            <FieldContent>
              <Select
                items={projectItems}
                value={project?.slug || ""}
                onValueChange={(slug) => {
                  if (!slug) return;
                  void navigate({ search: { project: slug }, replace: true });
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
                    {dashOrigin ? (
                      <a
                        href={`${dashOrigin}/.auth/connect?${new URLSearchParams({ issuer: info.platformOrigin, next: "/sessions", scope: "iterate account organizations:write" })}`}
                        className="underline underline-offset-2"
                      >
                        your sessions
                      </a>
                    ) : (
                      "your sessions"
                    )}{" "}
                    in OS.
                  </>
                )}
              </FieldDescription>
            </FieldContent>
          </Field>

          {openaiKey.data === false && (
            <Field className={horizontalFieldClassName}>
              <FieldLabel htmlFor="openai-key" className="sm:pt-2">
                OpenAI API key
              </FieldLabel>
              <FieldContent>
                <SecretInput
                  id="openai-key"
                  name="openai-key"
                  type="password"
                  autoComplete="off"
                  required
                />
                <FieldDescription>
                  {project?.slug} needs one for voice calls. It’s saved as a secret in your project,
                  only ever sent to api.openai.com, and never written to the device.
                </FieldDescription>
              </FieldContent>
            </Field>
          )}
          {openaiKey.isError && (
            <p role="alert" data-type="error" className="text-sm text-destructive">
              Couldn’t check {project?.slug} for an OpenAI API key: {openaiKey.error.message}
            </p>
          )}

          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="wifi-ssid" className="sm:pt-2">
              Wi-Fi network
            </FieldLabel>
            <FieldContent>
              <Input
                id="wifi-ssid"
                name="wifi-ssid"
                placeholder="Network name (SSID)"
                autoComplete="username"
                required
              />
              <FieldDescription>
                2.4 GHz only: the boards can’t join 5 GHz networks.
              </FieldDescription>
            </FieldContent>
          </Field>

          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="wifi-password" className="sm:pt-2">
              Wi-Fi password
            </FieldLabel>
            <FieldContent>
              <PasswordInput
                id="wifi-password"
                name="wifi-password"
                autoComplete="current-password"
              />
              <FieldDescription>Leave empty for an open network.</FieldDescription>
            </FieldContent>
          </Field>

          <Field className={horizontalFieldClassName}>
            <FieldLabel htmlFor="status-voice" className="sm:pt-2">
              Status voice
            </FieldLabel>
            <FieldContent>
              <Select name="status-voice" items={statusVoices} defaultValue="greensleeves">
                <SelectTrigger id="status-voice" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {statusVoices.map((voice) => (
                      <SelectItem key={voice.value} value={voice.value}>
                        {voice.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                How the board says “Connecting to Wi-Fi”, “Ready” and the like while it connects,
                and answers “Jarvis” with “Hello”.
              </FieldDescription>
            </FieldContent>
          </Field>

          <div className="grid sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
            <div className="flex flex-col gap-2 sm:col-start-2">
              <Button
                className="w-full"
                type="submit"
                disabled={!webSerial || !project || !firmware.manifest || openaiKey.isLoading}
              >
                <UsbIcon data-icon="inline-start" />
                Flash device
              </Button>
              {!webSerial && (
                <p role="alert" data-type="error" className="text-xs text-destructive">
                  This browser can’t reach USB devices (it has no Web Serial). Open this page in
                  Chrome or Edge on a computer.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                The link saves device, firmware and project. Wi-Fi and the token stay private.
              </p>
            </div>
          </div>
        </form>
        {firmware.manifest && (
          <SetupWizard preparing={preparing} device={device} manifest={firmware.manifest} />
        )}
      </section>
    </div>
  );
}

/** A dropped connection to the platform, which preparing a device retries once. */
class ConnectionDropped extends Error {}

/** A password field with a show/hide button. Whether it shows lives in the query cache (like the
 *  wizard's flash progress), per field. */
function PasswordInput(props: ComponentProps<"input"> & { id: string }) {
  const queryClient = useQueryClient();
  const shownKey = ["kit", "password-shown", props.id];
  const shown = useQuery({ queryKey: shownKey, queryFn: skipToken, initialData: false }).data;
  return (
    <InputGroup>
      {/* InputGroupInput's slot and look, on the SecretInput that keeps it out of session replay */}
      <SecretInput
        {...props}
        type={shown ? "text" : "password"}
        data-slot="input-group-control"
        className="flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 dark:bg-transparent"
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          size="icon-xs"
          aria-label="Show password"
          aria-pressed={shown}
          onClick={() => queryClient.setQueryData(shownKey, !shown)}
        >
          {shown ? <EyeOffIcon /> : <EyeIcon />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
