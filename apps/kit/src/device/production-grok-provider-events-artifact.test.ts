import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE } from "../userspace/config-worker/provider-event-stream.ts";
import type { ProductionGrokProviderEvent } from "./production-grok-provider-events.ts";
import { writeProductionGrokProviderEventsArtifact } from "./production-grok-provider-events-artifact.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryArtifactPath() {
  const directory = await mkdtemp(join(tmpdir(), "iterate-provider-events-"));
  temporaryDirectories.push(directory);
  return join(directory, "provider-events.jsonl");
}

describe("production Grok provider-event artifact", () => {
  test("writes exact raw frames in provider sequence order with their stream envelope", async () => {
    /*
     * Stream offsets and API response order are not the provider chronology.
     * The provider-assigned sequence is the loss detector, so the durable
     * artifact must be readable linearly in that order while retaining the
     * original offset and byte-for-byte raw JSON string for later diagnosis.
     */
    const rawFirst = '{ "type":"session.updated",\n "session":{"turn_detection":null} }';
    const rawSecond = '{"type":"response.done","response":{"id":"response_2"}}';
    const events: ProductionGrokProviderEvent[] = [
      {
        createdAt: "2026-08-01T00:00:02.000Z",
        offset: 91,
        providerType: "response.done",
        raw: rawSecond,
        receivedAtMs: 2_002,
        sequence: 2,
        sessionId: "pcm-session-7",
      },
      {
        createdAt: "2026-08-01T00:00:01.000Z",
        offset: 94,
        providerType: "session.updated",
        raw: rawFirst,
        receivedAtMs: 2_001,
        sequence: 1,
        sessionId: "pcm-session-7",
      },
    ];
    const artifactPath = await temporaryArtifactPath();

    const artifact = await writeProductionGrokProviderEventsArtifact({
      artifactPath,
      deviceId: "stackchan",
      events,
      sensitiveValues: ["itxk_not_in_this_artifact", "xai-not-in-this-artifact"],
    });
    const records = (await readFile(artifactPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(artifact).toEqual({
      continuity: {
        discontinuities: [],
        expectedFirstSequence: 1,
        firstObservedSequence: 1,
        lastObservedSequence: 2,
        verdict: "contiguous-from-one",
      },
      eventCount: 2,
      path: artifactPath,
      sessionId: "pcm-session-7",
    });
    expect(records).toEqual([
      {
        createdAt: "2026-08-01T00:00:01.000Z",
        offset: 94,
        path: "/devices/stackchan",
        providerType: "session.updated",
        raw: rawFirst,
        receivedAtMs: 2_001,
        sequence: 1,
        sessionId: "pcm-session-7",
        type: KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
      },
      {
        createdAt: "2026-08-01T00:00:02.000Z",
        offset: 91,
        path: "/devices/stackchan",
        providerType: "response.done",
        raw: rawSecond,
        receivedAtMs: 2_002,
        sequence: 2,
        sessionId: "pcm-session-7",
        type: KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
      },
    ]);
    expect(records.map((record) => record.raw)).toEqual([rawFirst, rawSecond]);
  });

  test("retains discontinuous failure frames and reports every observed sequence break", async () => {
    /*
     * A sequence gap is itself the failure evidence. The artifact writer must
     * not repeat the success gate and erase the only frames that explain why
     * continuity failed; it records the available chronology and judges the
     * missing prefix/gap separately in the linked descriptor.
     */
    const artifactPath = await temporaryArtifactPath();

    const artifact = await writeProductionGrokProviderEventsArtifact({
      artifactPath,
      deviceId: "m5sticks3",
      events: [
        {
          createdAt: "2026-08-01T00:00:06.000Z",
          offset: 12,
          providerType: "response.done",
          raw: '{"type":"response.done"}',
          receivedAtMs: 6,
          sequence: 6,
          sessionId: "failed-session",
        },
        {
          createdAt: "2026-08-01T00:00:04.000Z",
          offset: 10,
          providerType: "response.created",
          raw: '{"type":"response.created"}',
          receivedAtMs: 4,
          sequence: 4,
          sessionId: "failed-session",
        },
      ],
      sensitiveValues: [],
    });
    const records = (await readFile(artifactPath, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(records.map((record) => record.sequence)).toEqual([4, 6]);
    expect(artifact.continuity).toEqual({
      discontinuities: [
        { expectedSequence: 1, observedSequence: 4 },
        { expectedSequence: 5, observedSequence: 6 },
      ],
      expectedFirstSequence: 1,
      firstObservedSequence: 4,
      lastObservedSequence: 6,
      verdict: "discontinuous",
    });
  });

  test("describes a contiguous warm-session suffix from the proof baseline", async () => {
    /*
     * The Stick keeps one device PCM session alive while individual Grok calls
     * come and go. A later proof therefore retains a strict suffix such as
     * 148..150, not a new 1..3 stream. Labelling that exact suffix
     * `discontinuous` makes the durable artifact contradict the gate that just
     * proved it. The artifact must carry the same explicit baseline as the
     * parser while still reporting any missing event after that boundary.
     */
    const artifactPath = await temporaryArtifactPath();
    const event = (sequence: number): ProductionGrokProviderEvent => ({
      createdAt: `2026-08-02T11:00:${sequence}.000Z`,
      offset: 5_000 + sequence,
      providerType: "ping",
      raw: `{"type":"ping","sequence":${sequence}}`,
      receivedAtMs: 10_000 + sequence,
      sequence,
      sessionId: "warm-session",
    });

    const artifact = await writeProductionGrokProviderEventsArtifact({
      artifactPath,
      deviceId: "m5sticks3",
      events: [event(148), event(149), event(150)],
      expectedFirstSequence: 148,
      sensitiveValues: [],
    });

    expect(artifact.continuity).toEqual({
      discontinuities: [],
      expectedFirstSequence: 148,
      firstObservedSequence: 148,
      lastObservedSequence: 150,
      verdict: "contiguous-from-expected",
    });
  });

  test("refuses to create an artifact when an untouched raw frame contains a runtime secret", async () => {
    /*
     * Redaction would violate the artifact's lossless contract. Refusing the
     * write is the safe failure mode if a provider unexpectedly reflects a
     * bearer: no partially redacted evidence and no credential on disk.
     */
    const projectApiKey = "itxk_super_secret_project_key";
    const artifactPath = await temporaryArtifactPath();

    await expect(
      writeProductionGrokProviderEventsArtifact({
        artifactPath,
        deviceId: "m5sticks3",
        events: [
          {
            createdAt: "2026-08-01T00:00:00.000Z",
            offset: 1,
            providerType: "error",
            raw: JSON.stringify({ message: projectApiKey, type: "error" }),
            receivedAtMs: 1,
            sequence: 1,
            sessionId: "pcm-session-secret",
          },
        ],
        sensitiveValues: [projectApiKey],
      }),
    ).rejects.toThrow("protected runtime secret");
    await expect(stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
