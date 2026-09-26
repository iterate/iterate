import { expect, test, vi } from "vitest";
import { sendPostHogEvents, systemEvent } from "./posthog-events.ts";

test("uses a stable top-level PostHog UUID for retry and replay deduplication", () => {
  const at = "2026-09-24T05:00:00Z";
  const first = systemEvent("ci job attempt finished", "depot-job-attempt:a1", "w:1", {}, at);
  const replay = systemEvent("ci job attempt finished", "depot-job-attempt:a1", "w:1", {}, at);
  const other = systemEvent("ci job attempt finished", "depot-job-attempt:a2", "w:1", {}, at);

  expect(first).toMatchObject({ uuid: replay.uuid });
  expect(first).not.toMatchObject({ uuid: other.uuid });
  expect(first.uuid).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
  expect(first.properties).toMatchObject({
    $insert_id: "depot-job-attempt:a1",
    $process_person_profile: false,
  });
});

test("posts batches of 1,000 to the project's batch endpoint and retries a failed request", async () => {
  using posthog = stubbedFetch(
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValue(new Response("{}")),
  );
  const events = Array.from({ length: 1_001 }, (_, index) =>
    systemEvent("ci job attempt finished", `a${index}`, "w:1", {}, "2026-09-24T05:00:00Z"),
  );

  const sent = sendPostHogEvents(events, { apiKey: "phc_test", host: "https://eu.i.posthog.com" });
  await vi.runAllTimersAsync();
  await sent;

  expect(posthog.fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://eu.i.posthog.com/batch/",
    "https://eu.i.posthog.com/batch/",
    "https://eu.i.posthog.com/batch/",
  ]);
  const bodies = posthog.fetch.mock.calls.map(
    ([, init]) => JSON.parse(String(init?.body)) as { api_key: string; batch: unknown[] },
  );
  expect(bodies.map((body) => [body.api_key, body.batch.length])).toEqual([
    ["phc_test", 1_000],
    ["phc_test", 1_000],
    ["phc_test", 1],
  ]);
});

test("fails after three failed requests for one batch", async () => {
  using posthog = stubbedFetch(
    vi.fn<typeof fetch>().mockImplementation(async () => new Response("no", { status: 500 })),
  );
  const event = systemEvent("ci job attempt finished", "a", "w:1", {}, "2026-09-24T05:00:00Z");

  const sent = sendPostHogEvents([event], { apiKey: "phc_test", host: "https://eu.i.posthog.com" });
  const failure = expect(sent).rejects.toThrow("PostHog CI telemetry delivery failed");
  await vi.runAllTimersAsync();
  await failure;
  expect(posthog.fetch).toHaveBeenCalledTimes(3);
});

/** `fetch` replaced by `mock`, with fake timers so retry delays pass at once. */
function stubbedFetch(mock: ReturnType<typeof vi.fn<typeof fetch>>) {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", mock);
  return {
    fetch: mock,
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
}
