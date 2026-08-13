// The Expo-welded half of the screenshot sync engine: permission flow,
// screenshots-album enumeration, byte reads, and driving each new asset
// through the same capture pipeline the picker uses (media.ts) — now just
// hash + upload + one durable media/uploaded append per item; analysis is
// server-side (the MediaApp processor reacts to the event), so a pass is
// fast and backgrounding mid-pass loses ~nothing. The pure pass-planning
// rules live in media-sync-core.ts. Sync is device-initiated push per the
// original spec: the phone with the toggle on decides to run a pass (Media
// screen open, pull-to-refresh, or the ⋯ dialog's Sync now); there is no
// background task.

import * as Crypto from "expo-crypto";
import * as MediaLibrary from "expo-media-library";
import type { ProjectStub } from "iterate/sdk/itx/react";
import { uint8ArrayToBase64 } from "./encoding.ts";
import {
  buildUploadedEvent,
  mapWithConcurrency,
  MEDIA_STREAM_PATH,
  mediaFilePath,
  mediaIdempotencyKey,
  readWipeGeneration,
} from "./media.ts";
import {
  CONSECUTIVE_KNOWN_TO_STOP,
  createSyncPassTracker,
  MAX_NEW_PER_PASS,
} from "./media-sync-core.ts";

export type SyncPassResult =
  | { status: "denied" }
  | {
      status: "ran";
      accessPrivileges: "all" | "limited";
      synced: number;
      known: number;
      failed: number;
      /** True when the pass hit its per-pass cap — another pass will find more. */
      more: boolean;
    };

/**
 * One sync pass: newest screenshots first, hash each, skip what the stream
 * already has, upload the rest and append their birth events. Safe to run
 * repeatedly — the stop rule makes caught-up passes cheap.
 */
export type SyncCandidate = {
  previewUri: string;
  filename: string;
  /** Content hash — ties the pending card to the row it will become, so the
   * feed can morph one into the other with no gap. */
  stableKey: string;
  /** The asset's own creation time (ISO) — the pending card sorts by it so
   * the card sits where its row will land. */
  capturedAt: string | null;
};

export async function runSyncPass(input: {
  project: ProjectStub;
  /** Hard floor: assets created before this ISO instant are never touched.
   * The newest-first walk stops outright at the first older asset. */
  since: string;
  onProgress: (message: string) => void;
  /** A new (not-yet-captured) screenshot was found — show it immediately. */
  onCandidate: (candidate: SyncCandidate) => void;
  /** Its upload settled: the committed uploaded event's offset, or the
   * failure message. */
  onCandidateDone: (
    candidate: SyncCandidate,
    outcome: { uploadedOffset: number } | { error: string },
  ) => void;
}): Promise<SyncPassResult> {
  const permission = await MediaLibrary.requestPermissionsAsync();
  if (!permission.granted) return { status: "denied" };
  const accessPrivileges = permission.accessPrivileges === "limited" ? "limited" : "all";

  const stream = input.project.streams.get(MEDIA_STREAM_PATH);
  const wipeGeneration = await readWipeGeneration(stream);
  const tracker = createSyncPassTracker({
    consecutiveKnownToStop: CONSECUTIVE_KNOWN_TO_STOP,
    maxNewPerPass: MAX_NEW_PER_PASS,
  });
  let known = 0;
  const candidates: {
    stableKey: string;
    base64: string;
    filename: string;
    contentType: string;
    width: number;
    height: number;
    capturedAt: string | null;
    previewUri: string;
  }[] = [];

  // Discovery: walk newest-first, sequentially (the point is to stop early).
  let after: string | undefined;
  scan: while (tracker.shouldContinue()) {
    const page = await MediaLibrary.getAssetsAsync({
      mediaType: "photo",
      mediaSubtypes: "screenshot",
      sortBy: [["creationTime", false]],
      first: 50,
      ...(after && { after }),
    });
    const sinceMs = new Date(input.since).getTime();
    for (const asset of page.assets) {
      if (!tracker.shouldContinue()) break scan;
      if (asset.creationTime && asset.creationTime < sinceMs) break scan;
      input.onProgress(`Checking library (${candidates.length + known + 1} seen)…`);
      const read = await readAssetBase64(asset);
      if (!read) continue; // e.g. iCloud asset without a local copy
      const stableKey = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        read.base64,
      );
      if (
        await stream.getEvent({ idempotencyKey: mediaIdempotencyKey(stableKey, wipeGeneration) })
      ) {
        tracker.markKnown();
        known += 1;
      } else {
        tracker.markNew();
        const candidate = {
          stableKey,
          base64: read.base64,
          filename: read.filename,
          contentType: read.contentType,
          width: asset.width,
          height: asset.height,
          capturedAt: asset.creationTime ? new Date(asset.creationTime).toISOString() : null,
          previewUri: read.previewUri,
        };
        candidates.push(candidate);
        input.onCandidate(candidate);
      }
    }
    if (!page.hasNextPage) break;
    after = page.endCursor;
  }

  // Upload the discovered new ones, 3-wide like the picker flow: bytes to
  // files, then the durable birth event. Analysis follows server-side.
  let synced = 0;
  let failed = 0;
  await mapWithConcurrency(candidates, 3, async (candidate) => {
    input.onProgress(`Uploading ${synced + 1} of ${candidates.length} new…`);
    try {
      await input.project.files.get(mediaFilePath(candidate.stableKey, candidate.filename)).put({
        data: candidate.base64,
        contentType: candidate.contentType,
      });
      const [uploaded] = await stream.append(
        buildUploadedEvent({
          stableKey: candidate.stableKey,
          wipeGeneration,
          filename: candidate.filename,
          contentType: candidate.contentType,
          width: candidate.width,
          height: candidate.height,
          source: "library-sync",
          capturedAt: candidate.capturedAt,
          isScreenshot: true,
        }),
      );
      // The assertion restates append's contract: one input, one committed
      // (or deduped) event back.
      input.onCandidateDone(candidate, { uploadedOffset: uploaded!.offset });
      synced += 1;
    } catch (error) {
      // One failed upload must not sink the whole pass; its card shows the
      // error and the next pass will retry it.
      input.onCandidateDone(candidate, {
        error: error instanceof Error ? error.message : String(error),
      });
      failed += 1;
    }
  });

  return {
    status: "ran",
    accessPrivileges,
    synced,
    known,
    failed,
    more: candidates.length >= MAX_NEW_PER_PASS,
  };
}

async function readAssetBase64(asset: MediaLibrary.Asset): Promise<{
  base64: string;
  filename: string;
  contentType: string;
  previewUri: string;
} | null> {
  const info = await MediaLibrary.getAssetInfoAsync(asset);
  if (!info.localUri) return null;
  const response = await fetch(info.localUri);
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  // Screenshots are PNGs; trust the filename extension when present.
  const filename = asset.filename || `screenshot-${asset.id.replace(/[^\w-]+/g, "_")}.png`;
  const contentType =
    filename.toLowerCase().endsWith(".jpg") || filename.toLowerCase().endsWith(".jpeg")
      ? "image/jpeg"
      : "image/png";
  return { base64: uint8ArrayToBase64(bytes), filename, contentType, previewUri: info.localUri };
}
