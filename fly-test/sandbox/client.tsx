import { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type FetchPayload = {
  url: string;
  method: string;
  body: string;
};

type FetchResult = {
  ok: boolean;
  status?: string;
  body?: string;
  method?: string;
  targetUrl?: string;
  error?: string;
  proofDetected?: boolean;
  responseHeaders?: Record<string, string>;
  requestId?: string;
};

export function App() {
  const [targetUrl, setTargetUrl] = useState("http://public-http:18090/");
  const [method, setMethod] = useState("GET");
  const [body, setBody] = useState('{"hello":"world"}');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FetchResult | null>(null);

  useEffect(() => {
    let active = true;
    async function loadConfig(): Promise<void> {
      try {
        const response = await fetch("/api/config", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { defaultTargetUrl?: string };
        const configured = String(data.defaultTargetUrl ?? "").trim();
        if (active && configured.length > 0) {
          setTargetUrl(configured);
        }
      } catch {
        // keep fallback target
      }
    }
    void loadConfig();
    return () => {
      active = false;
    };
  }, []);

  async function runFetch(payload: FetchPayload): Promise<void> {
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as FetchResult;
      setResult(data);
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await runFetch({ url: targetUrl, method, body });
  }

  const localMode = targetUrl.includes("public-http");
  const demos: Array<{ label: string; payload: FetchPayload }> = localMode
    ? [
        {
          label: "GET JSON /",
          payload: { method: "GET", url: "http://public-http:18090/", body: "" },
        },
        {
          label: "GET Text /text (mutated)",
          payload: { method: "GET", url: "http://public-http:18090/text", body: "" },
        },
        {
          label: "GET HTML /html (mutated)",
          payload: { method: "GET", url: "http://public-http:18090/html", body: "" },
        },
        {
          label: "POST Echo /echo",
          payload: {
            method: "POST",
            url: "http://public-http:18090/echo?from=browser-demo",
            body: '{"demo":"browser","value":42}',
          },
        },
        {
          label: "GET Slow /slow?ms=9000 (timeout demo)",
          payload: { method: "GET", url: "http://public-http:18090/slow?ms=9000", body: "" },
        },
        {
          label: "GET Blocked iterate.com (policy)",
          payload: { method: "GET", url: "https://iterate.com/", body: "" },
        },
      ]
    : [
        {
          label: "GET example.com (allowed)",
          payload: { method: "GET", url: "https://example.com/", body: "" },
        },
        {
          label: "GET Blocked iterate.com (policy)",
          payload: { method: "GET", url: "https://iterate.com/", body: "" },
        },
      ];

  return (
    <div className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm">
      <h1 className="text-lg font-semibold">Sandbox Outbound Fetch</h1>
      <p className="mt-1 text-sm text-slate-600">
        Use demo buttons or custom inputs. Requests run from sandbox through gateway and MITM.
      </p>
      <section className="mt-4">
        <h2 className="text-sm font-semibold">Browser Demos</h2>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {demos.map((entry) => (
            <button
              key={entry.label}
              className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-2 text-left text-sm hover:bg-slate-200 disabled:opacity-60"
              type="button"
              disabled={busy}
              onClick={() => {
                setMethod(entry.payload.method);
                setTargetUrl(entry.payload.url);
                setBody(entry.payload.body);
                void runFetch(entry.payload);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </section>
      <form className="mt-4 space-y-3" onSubmit={onSubmit}>
        <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
          <label className="block text-sm font-medium" htmlFor="method">
            Method
          </label>
          <select
            id="method"
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            value={method}
            onChange={(event) => setMethod(event.target.value)}
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="PATCH">PATCH</option>
            <option value="DELETE">DELETE</option>
            <option value="HEAD">HEAD</option>
          </select>
          <label className="block text-sm font-medium" htmlFor="target-url">
            Target URL
          </label>
          <input
            id="target-url"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            type="url"
            required
            value={targetUrl}
            onChange={(event) => setTargetUrl(event.target.value)}
          />
          <label className="block text-sm font-medium" htmlFor="body">
            Body (JSON/text)
          </label>
          <textarea
            id="body"
            className="min-h-24 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
            value={body}
            disabled={method === "GET" || method === "HEAD"}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
        <button
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
          type="submit"
          disabled={busy}
        >
          {busy ? "Fetching..." : "Fetch Through Proxy"}
        </button>
      </form>
      <section className="mt-4">
        <h2 className="text-sm font-semibold">Result</h2>
        <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
          <div>status: {result?.status ?? "-"}</div>
          <div>method: {result?.method ?? "-"}</div>
          <div>target: {result?.targetUrl ?? "-"}</div>
          <div>proofDetected: {result?.proofDetected ? "yes" : "no"}</div>
          <div>requestId: {result?.requestId ?? "-"}</div>
        </div>
        <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-600">
          MITM Headers
        </h3>
        <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
          {JSON.stringify(result?.responseHeaders ?? {}, null, 2)}
        </pre>
        <h3 className="mt-3 text-xs font-semibold uppercase tracking-wide text-slate-600">Body</h3>
        <pre className="mt-2 max-h-[32rem] overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
          {result
            ? result.ok
              ? `${result.body ?? ""}`
              : `error\n${result.error ?? "unknown"}`
            : "Submit the form to trigger outbound fetch."}
        </pre>
      </section>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
