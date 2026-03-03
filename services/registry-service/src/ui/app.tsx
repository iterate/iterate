/// <reference lib="dom" />

import { useEffect, useMemo, useState } from "react";
import { StatusBanner, type StatusTone } from "@iterate-com/ui";
import { Button } from "@iterate-com/ui/components/button";
import { Input } from "@iterate-com/ui/components/input";
import { Label } from "@iterate-com/ui/components/label";
import { Textarea } from "@iterate-com/ui/components/textarea";
import { createRegistryClient } from "../client.ts";

interface RouteRecord {
  readonly host: string;
  readonly target: string;
  readonly metadata: Record<string, string>;
  readonly tags: string[];
  readonly updatedAt: string;
}

interface ConfigEntry {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: string;
}

interface IngressEnvValues {
  readonly ITERATE_PUBLIC_BASE_URL: string | null;
  readonly ITERATE_PUBLIC_BASE_URL_TYPE: "prefix" | "subdomain";
}

const parseJsonObject = (raw: string): Record<string, string> => {
  if (raw.trim().length === 0) {
    return {};
  }

  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Metadata must be a JSON object");
  }

  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    next[key] = String(value);
  }

  return next;
};

const parseJsonUnknown = (raw: string): unknown => {
  if (raw.trim().length === 0) {
    return null;
  }

  return JSON.parse(raw);
};

const formatTime = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
};

const client = createRegistryClient({ url: "/orpc" });

export function App() {
  const [routes, setRoutes] = useState<RouteRecord[]>([]);
  const [entries, setEntries] = useState<ConfigEntry[]>([]);
  const [ingressEnv, setIngressEnv] = useState<IngressEnvValues | null>(null);
  const [selectedHost, setSelectedHost] = useState("");

  const [host, setHost] = useState("demo.iterate.localhost");
  const [target, setTarget] = useState("127.0.0.1:19010");
  const [tagsInput, setTagsInput] = useState("demo");
  const [metadataInput, setMetadataInput] = useState('{\n  "owner": "registry-ui"\n}');

  const [listenAddress, setListenAddress] = useState("");
  const [adminUrl, setAdminUrl] = useState("");
  const [invocationPreview, setInvocationPreview] = useState("");

  const [configKey, setConfigKey] = useState("caddy.sync.mode");
  const [configValueInput, setConfigValueInput] = useState('"manual"');
  const [internalURL, setInternalURL] = useState("http://events.iterate.localhost");
  const [publicURL, setPublicURL] = useState("");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [statusTone, setStatusTone] = useState<StatusTone>("neutral");

  const selectedRoute = useMemo(
    () => routes.find((route) => route.host === selectedHost),
    [routes, selectedHost],
  );

  const setError = (message: string) => {
    setStatus(message);
    setStatusTone("error");
  };

  const setInfo = (message: string) => {
    setStatus(message);
    setStatusTone("neutral");
  };

  const loadRoutes = async () => {
    const response = await client.routes.list({});
    setRoutes(response.routes as RouteRecord[]);
    if (response.routes.length > 0 && selectedHost.length === 0) {
      setSelectedHost(response.routes[0].host);
    }
    return response.total;
  };

  const loadConfig = async () => {
    const response = await client.config.list({});
    setEntries(response.entries as ConfigEntry[]);
    return response.total;
  };

  const loadIngressEnv = async () => {
    const response = await fetch("/api/ingress-env");
    if (!response.ok) {
      throw new Error(`Failed to load ingress env (${response.status})`);
    }
    const payload = (await response.json()) as IngressEnvValues;
    setIngressEnv(payload);
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const [routeTotal, configTotal] = await Promise.all([
        loadRoutes(),
        loadConfig(),
        loadIngressEnv(),
      ]);
      setInfo(
        `Loaded ${String(routeTotal)} route(s) and ${String(configTotal)} config entr${configTotal === 1 ? "y" : "ies"}`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onUpsert = async () => {
    setBusy(true);
    try {
      const metadata = parseJsonObject(metadataInput);
      const tags = tagsInput
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

      const response = await client.routes.upsert({
        host,
        target,
        metadata,
        ...(tags.length > 0 ? { tags } : {}),
      });

      setSelectedHost(response.route.host);
      await loadRoutes();
      setInfo(`Saved route ${response.route.host}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    const hostToRemove = selectedHost || host;
    if (hostToRemove.length === 0) {
      return;
    }

    setBusy(true);
    try {
      const response = await client.routes.remove({ host: hostToRemove });
      if (selectedHost === hostToRemove) {
        setSelectedHost("");
      }
      await loadRoutes();
      setInfo(
        response.removed ? `Removed route ${hostToRemove}` : `Route ${hostToRemove} did not exist`,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onCaddyInvocation = async (apply: boolean) => {
    setBusy(true);
    try {
      const response = await client.routes.caddyLoadInvocation({
        ...(listenAddress.trim().length > 0 ? { listenAddress: listenAddress.trim() } : {}),
        ...(adminUrl.trim().length > 0 ? { adminUrl: adminUrl.trim() } : {}),
        apply,
      });
      setInvocationPreview(JSON.stringify(response.invocation, null, 2));
      setInfo(apply ? "Applied Caddy load invocation" : "Generated Caddy load invocation preview");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onSetConfig = async () => {
    setBusy(true);
    try {
      const value = parseJsonUnknown(configValueInput);
      const response = await client.config.set({ key: configKey, value });
      await loadConfig();
      setInfo(`Saved config ${response.entry.key}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const onGetPublicURL = async () => {
    setBusy(true);
    try {
      const response = await client.getPublicURL({
        internalURL,
      });
      setPublicURL(response.publicURL);
      setInfo(`Resolved public URL for ${internalURL}`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial data load should run once on mount
  }, []);

  return (
    <main className="mx-auto w-full max-w-7xl p-4 md:p-6">
      <div className="grid gap-4 lg:grid-cols-[1.7fr_1fr]">
        <section className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-xl font-semibold">Registry Service</h1>
            <Button
              disabled={busy}
              onClick={() => void refresh()}
              type="button"
              variant="secondary"
            >
              Refresh
            </Button>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted p-3 text-xs">
            <h2 className="text-sm font-semibold">Get public URL</h2>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">Internal URL</Label>
              <Input onChange={(event) => setInternalURL(event.target.value)} value={internalURL} />
            </div>
            <div>
              <Button disabled={busy} onClick={() => void onGetPublicURL()} type="button">
                getPublicURL
              </Button>
            </div>
            <p className="break-all text-[11px]">
              Result: <span className="font-mono">{publicURL || "—"}</span>
            </p>
            <p className="break-all text-[11px]">
              ITERATE_PUBLIC_BASE_URL:{" "}
              <span className="font-mono">{ingressEnv?.ITERATE_PUBLIC_BASE_URL ?? "unset"}</span>
            </p>
            <p className="break-all text-[11px]">
              ITERATE_PUBLIC_BASE_URL_TYPE:{" "}
              <span className="font-mono">
                {ingressEnv?.ITERATE_PUBLIC_BASE_URL_TYPE ?? "prefix"}
              </span>
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">Host</Label>
              <Input onChange={(event) => setHost(event.target.value)} value={host} />
            </div>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">Target</Label>
              <Input onChange={(event) => setTarget(event.target.value)} value={target} />
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">Tags (comma separated)</Label>
              <Input onChange={(event) => setTagsInput(event.target.value)} value={tagsInput} />
            </div>
            <div className="grid gap-2">
              <Label className="text-muted-foreground">Metadata (JSON object)</Label>
              <Textarea
                className="min-h-24 font-mono text-xs"
                onChange={(event) => setMetadataInput(event.target.value)}
                value={metadataInput}
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void onUpsert()} type="button">
              Upsert route
            </Button>
            <Button
              disabled={busy || (selectedHost || host).length === 0}
              onClick={() => void onRemove()}
              type="button"
              variant="destructive"
            >
              Remove route
            </Button>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted p-3 text-xs">
            <h2 className="text-sm font-semibold">Caddy load invocation</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Listen address (optional)</Label>
                <Input
                  onChange={(event) => setListenAddress(event.target.value)}
                  placeholder=":80"
                  value={listenAddress}
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Admin URL (optional)</Label>
                <Input
                  onChange={(event) => setAdminUrl(event.target.value)}
                  placeholder="http://127.0.0.1:2019"
                  value={adminUrl}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() => void onCaddyInvocation(false)}
                type="button"
                variant="secondary"
              >
                Preview /load payload
              </Button>
              <Button disabled={busy} onClick={() => void onCaddyInvocation(true)} type="button">
                Apply /load now
              </Button>
            </div>
            {invocationPreview.length > 0 ? (
              <pre className="max-h-56 overflow-auto rounded-md border border-border bg-background p-3 text-[11px] leading-5">
                {invocationPreview}
              </pre>
            ) : null}
          </div>

          <StatusBanner tone={statusTone}>{status}</StatusBanner>
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold">Routes</h2>
            <div className="mt-3 max-h-[60vh] space-y-2 overflow-auto pr-1">
              {routes.map((route) => {
                const selected = selectedHost === route.host;
                return (
                  <button
                    className={[
                      "w-full rounded-md border px-3 py-2 text-left text-xs",
                      selected
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent hover:text-accent-foreground",
                    ].join(" ")}
                    key={route.host}
                    onClick={() => setSelectedHost(route.host)}
                    type="button"
                  >
                    <div className="font-mono">{route.host}</div>
                    <div className="text-muted-foreground">{route.target}</div>
                  </button>
                );
              })}
              {routes.length === 0 ? (
                <p className="text-sm text-muted-foreground">No routes yet.</p>
              ) : null}
            </div>

            {selectedRoute ? (
              <div className="mt-3 space-y-2 rounded-lg border bg-muted p-3 text-xs">
                <p className="font-mono text-[11px]">{selectedRoute.host}</p>
                <p>Target: {selectedRoute.target}</p>
                <p>Tags: {selectedRoute.tags.join(", ") || "none"}</p>
                <p>Updated: {formatTime(selectedRoute.updatedAt)}</p>
              </div>
            ) : null}
          </div>

          <div>
            <h2 className="text-base font-semibold">Config</h2>
            <div className="mt-3 space-y-4">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Key</Label>
                <Input onChange={(event) => setConfigKey(event.target.value)} value={configKey} />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Value (JSON)</Label>
                <Textarea
                  className="min-h-20 font-mono text-xs"
                  onChange={(event) => setConfigValueInput(event.target.value)}
                  value={configValueInput}
                />
              </div>
              <div>
                <Button
                  disabled={busy}
                  onClick={() => void onSetConfig()}
                  type="button"
                  variant="secondary"
                >
                  Set config
                </Button>
              </div>
              <div className="space-y-2 rounded-lg border bg-muted p-3 text-xs">
                {entries.map((entry) => (
                  <div key={entry.key}>
                    <p className="font-mono text-[11px]">{entry.key}</p>
                    <p className="break-all text-[11px] text-muted-foreground">
                      {JSON.stringify(entry.value)}
                    </p>
                    <p>Updated: {formatTime(entry.updatedAt)}</p>
                  </div>
                ))}
                {entries.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No config entries.</p>
                ) : null}
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
