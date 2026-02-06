import { FormEvent, useState } from "react";
import { createRoot } from "react-dom/client";

type FetchResult = {
  ok: boolean;
  status?: string;
  body?: string;
  error?: string;
};

function App() {
  const [targetUrl, setTargetUrl] = useState("http://neverssl.com/");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FetchResult | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch("/api/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: targetUrl }),
      });
      const data = (await response.json()) as FetchResult;
      setResult(data);
    } catch (error) {
      setResult({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm">
      <h1 className="text-lg font-semibold">Sandbox Outbound Fetch</h1>
      <p className="mt-1 text-sm text-slate-600">
        Enter any URL. The request runs from this machine through the egress proxy.
      </p>
      <form className="mt-4 space-y-3" onSubmit={onSubmit}>
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
        <pre className="mt-2 max-h-[32rem] overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-100">
          {result
            ? result.ok
              ? `ok\nstatus=${result.status ?? "unknown"}\n\n${result.body ?? ""}`
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
