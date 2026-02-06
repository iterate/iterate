import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

function filterLog(text: string, mode: string): string {
  if (mode === "all") return text;
  const lines = text.split("\n");
  if (mode === "inspect") return lines.filter((line) => line.includes("INSPECT_")).join("\n");
  if (mode === "transform") return lines.filter((line) => line.includes("TRANSFORM_")).join("\n");
  if (mode === "errors") {
    return lines
      .filter((line) =>
        ["TRANSFORM_ERROR", "TRANSFORM_TIMEOUT", "MITM_TRANSFORM_ERROR", "FETCH_ERROR"].some(
          (token) => line.includes(token),
        ),
      )
      .join("\n");
  }
  return text;
}

function App() {
  const [lines, setLines] = useState(300);
  const [mode, setMode] = useState("all");
  const [text, setText] = useState("loading...");

  useEffect(() => {
    let active = true;
    async function poll(): Promise<void> {
      try {
        const response = await fetch(`/api/tail?lines=${lines}&ts=${Date.now()}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`status=${response.status}`);
        const body = await response.text();
        if (active) setText(body);
      } catch (error) {
        if (active) {
          const message = error instanceof Error ? error.message : String(error);
          setText((prev) => `${prev}\n[viewer] poll error: ${message}\n`);
        }
      }
    }

    void poll();
    const timer = setInterval(() => void poll(), 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [lines]);

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Egress Proxy Live Log</h1>
          <p className="mt-1 text-sm text-slate-400">
            Polling /api/tail every second. Use filter to isolate request/response introspection.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-300">
          <label htmlFor="line-count">
            Lines
            <select
              id="line-count"
              className="ml-2 rounded-md border border-slate-600 bg-slate-800 px-2 py-1"
              value={lines}
              onChange={(event) => setLines(Number(event.target.value))}
            >
              <option value={100}>100</option>
              <option value={300}>300</option>
              <option value={600}>600</option>
              <option value={1000}>1000</option>
            </select>
          </label>
          <label htmlFor="mode">
            Filter
            <select
              id="mode"
              className="ml-2 rounded-md border border-slate-600 bg-slate-800 px-2 py-1"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="all">All</option>
              <option value="inspect">INSPECT only</option>
              <option value="transform">TRANSFORM only</option>
              <option value="errors">Errors only</option>
            </select>
          </label>
        </div>
      </div>
      <pre className="mt-4 max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-lg bg-black p-3 text-xs text-green-300">
        {filterLog(text, mode) || "\n"}
      </pre>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
