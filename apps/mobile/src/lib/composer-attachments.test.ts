import { expect, test } from "vitest";
import {
  attachmentKey,
  attachmentLabel,
  attachmentUploads,
  formatClipDuration,
  locationXmlPart,
  MAX_UPLOAD_BYTES,
  messageWithXmlParts,
  oversizeReason,
  type ComposerAttachment,
} from "./composer-attachments.ts";

const photo: ComposerAttachment = {
  kind: "photo",
  image: {
    assetId: "a1",
    filename: "sunset.jpg",
    contentType: "image/jpeg",
    base64: Buffer.from("jpeg bytes").toString("base64"),
    previewUri: "file:///tmp/sunset.jpg",
    width: 100,
    height: 80,
  },
};

const voiceClip: ComposerAttachment = {
  kind: "audio",
  filename: "voice-123.m4a",
  contentType: "audio/mp4",
  uri: "file:///tmp/voice-123.m4a",
  durationSeconds: 83,
};

const location: ComposerAttachment = {
  kind: "location",
  latitude: 51.5074,
  longitude: -0.1278,
  accuracyMeters: 12.4,
  capturedAt: "2026-08-30T12:00:00.000Z",
};

test("uploads: photos carry their own base64, everything else reads lazily", async () => {
  const reads: string[] = [];
  const uploads = await attachmentUploads([photo, voiceClip, location], async (uri) => {
    reads.push(uri);
    return Buffer.from("audio bytes").toString("base64");
  });
  expect(reads).toEqual(["file:///tmp/voice-123.m4a"]);
  expect(uploads).toMatchObject([
    { filename: "sunset.jpg", contentType: "image/jpeg" },
    { filename: "voice-123.m4a", contentType: "audio/mp4" },
  ]);
  expect(Buffer.from(uploads[1]!.data).toString()).toBe("audio bytes");
});

test("uploads: a file that reads back oversized refuses with the filename", async () => {
  const big: ComposerAttachment = {
    kind: "file",
    filename: "huge.pdf",
    contentType: "application/pdf",
    uri: "file:///tmp/huge.pdf",
    sizeBytes: null,
  };
  await expect(
    attachmentUploads([big], async () =>
      Buffer.alloc(MAX_UPLOAD_BYTES + 1024 * 1024).toString("base64"),
    ),
  ).rejects.toThrow(/huge\.pdf.*too big/);
});

test("location becomes a self-describing xml part appended to the text", () => {
  expect(messageWithXmlParts("meet me here", [photo, location])).toBe(
    'meet me here\n<user-location latitude="51.5074" longitude="-0.1278" accuracy-meters="12" captured-at="2026-08-30T12:00:00.000Z" />',
  );
  // Location-only send: no leading newline.
  expect(messageWithXmlParts("", [location])).toBe(
    '<user-location latitude="51.5074" longitude="-0.1278" accuracy-meters="12" captured-at="2026-08-30T12:00:00.000Z" />',
  );
  // No location → the text passes through untouched.
  expect(messageWithXmlParts("hi", [photo])).toBe("hi");
});

test("xml attributes escape reserved characters", () => {
  expect(
    locationXmlPart({
      latitude: 1,
      longitude: 2,
      accuracyMeters: null,
      capturedAt: '"<&>"',
    }),
  ).toBe('<user-location latitude="1" longitude="2" captured-at="&quot;&lt;&amp;&gt;&quot;" />');
});

test("oversize guard and labels", () => {
  expect(oversizeReason(null)).toBeNull();
  expect(oversizeReason(MAX_UPLOAD_BYTES)).toBeNull();
  expect(oversizeReason(MAX_UPLOAD_BYTES + 1)).toMatch(/too big/);
  expect(formatClipDuration(83)).toBe("1:23");
  expect(formatClipDuration(4)).toBe("0:04");
  expect(attachmentLabel(voiceClip)).toBe("voice · 1:23");
  expect(attachmentLabel(location)).toBe("51.50740, -0.12780");
  expect(attachmentKey(photo)).toBe("photo:file:///tmp/sunset.jpg");
  expect(attachmentKey(location)).toBe("location:2026-08-30T12:00:00.000Z");
});
