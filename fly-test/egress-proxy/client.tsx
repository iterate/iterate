import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

function App() {
  const [lines, setLines] = useState(300);
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
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Egress Proxy Live Log</h1>
          <p className="mt-1 text-sm text-slate-400">Polling /api/tail every second.</p>
        </div>
        <label className="text-sm text-slate-300" htmlFor="line-count">
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
      </div>
      <pre className="mt-4 max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-lg bg-black p-3 text-xs text-green-300">
        {text || "\n"}
      </pre>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(<App />);
