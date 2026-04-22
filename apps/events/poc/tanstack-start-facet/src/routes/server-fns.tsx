import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";

// ── Server function: echo with server-side transformation ──────────────────
const echoTransform = createServerFn({ method: "POST" })
  .inputValidator((data: { text: string }) => {
    if (!data.text || data.text.length > 200) throw new Error("Text must be 1-200 chars");
    return data;
  })
  .handler(async ({ data }) => {
    // This code runs server-side in the Durable Object
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data.text));
    const hashHex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    return {
      original: data.text,
      upper: data.text.toUpperCase(),
      reversed: data.text.split("").reverse().join(""),
      length: data.text.length,
      sha256: hashHex,
      processedAt: new Date().toISOString(),
      processedBy: "Durable Object Facet (TanStack Start SSR)",
    };
  });

// ── Server function: fetch external API (proves outbound fetch from DO) ────
const fetchExternalData = createServerFn({ method: "GET" }).handler(async () => {
  const start = Date.now();
  try {
    const resp = await fetch("https://httpbin.org/json");
    const data = (await resp.json()) as any;
    return {
      ok: true,
      status: resp.status,
      latencyMs: Date.now() - start,
      slideshow: data?.slideshow?.title ?? "unknown",
      fetchedAt: new Date().toISOString(),
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err.message,
      latencyMs: Date.now() - start,
      fetchedAt: new Date().toISOString(),
    };
  }
});

// ── Server function: fibonacci (proves CPU-bound work in DO) ───────────────
const computeFib = createServerFn({ method: "POST" })
  .inputValidator((data: { n: number }) => {
    if (data.n < 1 || data.n > 40) throw new Error("n must be 1-40");
    return data;
  })
  .handler(async ({ data }) => {
    const start = Date.now();
    function fib(n: number): number {
      if (n <= 1) return n;
      return fib(n - 1) + fib(n - 2);
    }
    const result = fib(data.n);
    return {
      n: data.n,
      result,
      computeMs: Date.now() - start,
      computedAt: new Date().toISOString(),
    };
  });

// ── Server function: generate UUID (uses crypto API in DO) ─────────────────
const generateId = createServerFn({ method: "POST" }).handler(async () => {
  const id = crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return {
    uuid: id,
    randomHex: Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
    generatedAt: new Date().toISOString(),
  };
});

export const Route = createFileRoute("/server-fns")({
  component: ServerFnsDemo,
});

function ServerFnsDemo() {
  const [echoInput, setEchoInput] = useState("Hello from a Durable Facet!");
  const [echoResult, setEchoResult] = useState<any>(null);
  const [echoLoading, setEchoLoading] = useState(false);

  const [fetchResult, setFetchResult] = useState<any>(null);
  const [fetchLoading, setFetchLoading] = useState(false);

  const [fibN, setFibN] = useState(30);
  const [fibResult, setFibResult] = useState<any>(null);
  const [fibLoading, setFibLoading] = useState(false);

  const [idResult, setIdResult] = useState<any>(null);
  const [idLoading, setIdLoading] = useState(false);

  async function handleEcho() {
    setEchoLoading(true);
    try {
      const result = await echoTransform({ data: { text: echoInput } });
      setEchoResult(result);
    } catch (err: any) {
      setEchoResult({ error: err.message });
    }
    setEchoLoading(false);
  }

  async function handleFetch() {
    setFetchLoading(true);
    try {
      const result = await fetchExternalData();
      setFetchResult(result);
    } catch (err: any) {
      setFetchResult({ error: err.message });
    }
    setFetchLoading(false);
  }

  async function handleFib() {
    setFibLoading(true);
    try {
      const result = await computeFib({ data: { n: fibN } });
      setFibResult(result);
    } catch (err: any) {
      setFibResult({ error: err.message });
    }
    setFibLoading(false);
  }

  async function handleGenId() {
    setIdLoading(true);
    try {
      const result = await generateId();
      setIdResult(result);
    } catch (err: any) {
      setIdResult({ error: err.message });
    }
    setIdLoading(false);
  }

  return (
    <main>
      <h1>Server Functions Demo</h1>
      <p>
        Each button calls a <code>createServerFn</code> that executes{" "}
        <strong>server-side inside the Durable Object</strong>. The client sends a POST to{" "}
        <code>/_serverFn/...</code>, TanStack Start routes it to the handler, and the result comes
        back.
      </p>

      {/* Echo Transform */}
      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
          1. Echo + Transform (POST with validation)
        </h2>
        <p style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
          Input is validated server-side (1-200 chars), then transformed with SHA-256 hashing via{" "}
          <code>crypto.subtle</code>.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
          <input
            type="text"
            value={echoInput}
            onChange={(e) => setEchoInput(e.target.value)}
            style={{
              flex: 1,
              padding: "0.5rem",
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: 6,
              color: "#e0e0e0",
              fontFamily: "monospace",
            }}
          />
          <button onClick={handleEcho} disabled={echoLoading}>
            {echoLoading ? "Processing..." : "Transform"}
          </button>
        </div>
        {echoResult && <ResultBox data={echoResult} />}
      </section>

      {/* External Fetch */}
      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
          2. External API Fetch (outbound from DO)
        </h2>
        <p style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
          Server function fetches <code>httpbin.org/json</code> from inside the Durable Object,
          proving outbound HTTP works.
        </p>
        <button onClick={handleFetch} disabled={fetchLoading}>
          {fetchLoading ? "Fetching..." : "Fetch External API"}
        </button>
        {fetchResult && <ResultBox data={fetchResult} />}
      </section>

      {/* Fibonacci */}
      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
          3. Fibonacci (CPU-bound in DO)
        </h2>
        <p style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
          Recursive fibonacci computed server-side. Proves CPU-bound work runs in the DO.
        </p>
        <div
          style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem" }}
        >
          <span style={{ color: "#888" }}>fib(</span>
          <input
            type="number"
            value={fibN}
            min={1}
            max={40}
            onChange={(e) => setFibN(Number(e.target.value))}
            style={{
              width: 60,
              padding: "0.5rem",
              background: "#1a1a1a",
              border: "1px solid #333",
              borderRadius: 6,
              color: "#e0e0e0",
              fontFamily: "monospace",
              textAlign: "center",
            }}
          />
          <span style={{ color: "#888" }}>)</span>
          <button onClick={handleFib} disabled={fibLoading}>
            {fibLoading ? "Computing..." : "Compute"}
          </button>
        </div>
        {fibResult && <ResultBox data={fibResult} />}
      </section>

      {/* UUID Generation */}
      <section style={{ marginTop: "1.5rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.5rem" }}>
          4. Crypto UUID (server-side crypto API)
        </h2>
        <p style={{ fontSize: "0.85rem", marginBottom: "0.5rem" }}>
          Generates UUIDs and random bytes using <code>crypto.randomUUID()</code> and{" "}
          <code>crypto.getRandomValues()</code> inside the DO.
        </p>
        <button onClick={handleGenId} disabled={idLoading}>
          {idLoading ? "Generating..." : "Generate ID"}
        </button>
        {idResult && <ResultBox data={idResult} />}
      </section>
    </main>
  );
}

function ResultBox({ data }: { data: Record<string, any> }) {
  return (
    <pre
      style={{
        background: "#111",
        border: "1px solid #333",
        borderRadius: 8,
        padding: "0.75rem",
        fontFamily: "monospace",
        fontSize: "0.8rem",
        lineHeight: 1.6,
        overflow: "auto",
        marginTop: "0.5rem",
        color: "#4ade80",
      }}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
