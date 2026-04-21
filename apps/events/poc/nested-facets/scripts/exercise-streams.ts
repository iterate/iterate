#!/usr/bin/env npx tsx
// Exercise the agents app streams/facets architecture.
// Creates multiple streams, appends events to each, and verifies
// that each stream path gets its own StreamProcessor facet with independent state.
//
// Usage: npx tsx scripts/exercise-streams.ts

const BASE = process.argv[2] || "https://agents.test.iterate-dev-jonas.app";

async function post(path: string, body: object) {
  const resp = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await resp.json()) as any;
  return { status: resp.status, data };
}

async function get(path: string) {
  const resp = await fetch(`${BASE}${path}`);
  if (resp.headers.get("content-type")?.includes("json")) {
    return { status: resp.status, data: (await resp.json()) as any };
  }
  return { status: resp.status, text: await resp.text() };
}

async function main() {
  console.log("=== Exercising streams-demo agents app ===\n");
  console.log(`Base URL: ${BASE}\n`);

  // 1. Create 3 different streams by posting events
  const streams = ["orders/2026-04", "support/tickets", "webhooks/stripe"];

  for (const streamPath of streams) {
    console.log(`--- Stream: ${streamPath} ---`);

    // Post 3 events to each stream
    for (let i = 1; i <= 3; i++) {
      const result = await post("/events", {
        streamPath,
        type: `test-event-${i}`,
        payload: { stream: streamPath, seq: i, ts: new Date().toISOString() },
      });
      console.log(
        `  Event ${i}: status=${result.status} count=${result.data?.inner?.state?.eventCount ?? "?"}`,
      );
    }
  }

  // 2. Also post directly to /streams/:path/append (the events.iterate.com-style endpoint)
  const directStream = "direct/append-test";
  console.log(`\n--- Direct /append stream: ${directStream} ---`);
  for (let i = 1; i <= 2; i++) {
    const encoded = encodeURIComponent(directStream);
    const result = await post(`/streams/${encoded}/append`, {
      type: "direct-append",
      payload: { seq: i, via: "append-endpoint" },
      offset: i,
      streamPath: `/${directStream}`,
      createdAt: new Date().toISOString(),
    });
    console.log(
      `  Append ${i}: status=${result.status} count=${result.data?.state?.eventCount ?? "?"}`,
    );
  }

  // 3. Verify: list all streams
  console.log("\n=== Stream index ===");
  const streamsResult = await get("/api/streams");
  if (streamsResult.status === 200) {
    for (const s of (streamsResult.data as any).streams) {
      console.log(`  ${s.path}  events=${s.event_count}  last=${s.last_event_at}`);
    }
  } else {
    console.log(`  Error: ${streamsResult.status}`);
  }

  // 4. Check individual stream state via API
  console.log("\n=== Per-stream state ===");
  for (const streamPath of [...streams, directStream]) {
    const encoded = encodeURIComponent(streamPath);
    const result = await get(`/streams/${encoded}/api/state`);
    if (result.status === 200) {
      const d = result.data as any;
      console.log(
        `  ${d.streamPath}: eventCount=${d.state.eventCount} lastType=${d.state.lastEventType} doId=${d.doId?.slice(0, 12)}...`,
      );
    } else {
      console.log(`  ${streamPath}: error ${result.status}`);
    }
  }

  // 5. Print URLs for browser verification
  console.log("\n\n========================================");
  console.log("  BROWSER URLS — open these to verify");
  console.log("========================================\n");
  console.log(`  App dashboard (shows all streams):`);
  console.log(`    ${BASE}/\n`);
  for (const streamPath of [...streams, directStream]) {
    const encoded = encodeURIComponent(streamPath);
    console.log(`  Stream "${streamPath}" (own facet DO with mini UI):`);
    console.log(`    ${BASE}/streams/${encoded}\n`);
  }
  console.log(`  Stream index (JSON):`);
  console.log(`    ${BASE}/api/streams\n`);
}

main().catch(console.error);
