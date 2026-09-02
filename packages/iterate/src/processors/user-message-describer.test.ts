import { expect, test } from "vitest";
import {
  describeUserMessage,
  formatAttachmentPartLine,
  type DescribedAttachment,
} from "./user-message-describer.ts";

// The attachment vocabulary's emitter and parser live side by side in this
// module so they cannot drift; this file pins the round trip.

const EVERY_KIND: DescribedAttachment[] = [
  { kind: "image", filename: "IMG_3909.png", width: 1200, height: 900 },
  {
    kind: "video",
    filename: "clip.mov",
    width: 1920,
    height: 1080,
    durationSeconds: 12,
    poster: "clip.mov.thumb.jpg",
  },
  { kind: "video", filename: "fresh-recording.mov" },
  {
    kind: "audio",
    filename: "note.m4a",
    durationSeconds: 7,
    transcript: "on my way, be there soon",
  },
  { kind: "audio", filename: "song.mp3" },
  { kind: "file", filename: "report.pdf", contentType: "application/pdf", sizeBytes: 9_800_000 },
  {
    kind: "location",
    latitude: 51.5074,
    longitude: -0.1278,
    accuracyMeters: 15,
    capturedAt: "2026-09-02T00:00:00.000Z",
  },
];

test("every attachment kind round-trips through its part line", () => {
  for (const attachment of EVERY_KIND) {
    const line = formatAttachmentPartLine(attachment);
    const described = describeUserMessage(`hello\n${line}`);
    expect(described, line).not.toBeNull();
    expect(described!.attachments[0], line).toEqual(attachment);
    expect(described!.text, line).toBe("hello");
  }
});

test("a full message describes to stripped text plus all attachments, in order", () => {
  const content = [
    "check these out",
    formatAttachmentPartLine(EVERY_KIND[0]!),
    formatAttachmentPartLine(EVERY_KIND[3]!),
    formatAttachmentPartLine(EVERY_KIND[6]!),
    "[Files attached: IMG_3909.png, note.m4a]",
  ].join("\n");
  expect(describeUserMessage(content)).toEqual({
    text: "check these out",
    attachments: [EVERY_KIND[0], EVERY_KIND[3], EVERY_KIND[6]],
  });
});

test("hostile filenames survive escaping", () => {
  const attachment: DescribedAttachment = {
    kind: "image",
    filename: 'we"ird <name> & co.png',
    width: 10,
    height: 10,
  };
  const line = formatAttachmentPartLine(attachment);
  expect(describeUserMessage(line)!.attachments[0]).toEqual(attachment);
});

test("plain messages and old-format xml parts derive nothing", () => {
  expect(describeUserMessage("just words")).toBeNull();
  expect(
    describeUserMessage('hi\n<attachment filename="a.png" width="10" height="10" />'),
  ).toBeNull();
  expect(describeUserMessage('<voice-note filename="v.m4a" duration-seconds="3" />')).toBeNull();
});

test("a mid-sentence tag mention never parses as an attachment", () => {
  expect(describeUserMessage('use an <img alt="x" width="1" height="1"> tag here')).toBeNull();
});
