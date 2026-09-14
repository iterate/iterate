import { expect, test } from "vitest";
import {
  assertVoiceHandshakeOverlapScope,
  isVoiceHandshakeOverlapRequest,
  VoiceHandshakeOverlapInput,
  VOICE_HANDSHAKE_OVERLAP_PREFIX,
  VOICE_HANDSHAKE_OVERLAP_PROJECT_ID,
  VOICE_HANDSHAKE_OVERLAP_URL,
} from "./voice-handshake-overlap-control.ts";

const streamPath = `${VOICE_HANDSHAKE_OVERLAP_PREFIX}test`;
const activation = "cbe2f37f-93de-4ee5-b1f9-0378b3c221a7";

test("accepts only the exact preview proof project and treatment path", () => {
  expect(() =>
    assertVoiceHandshakeOverlapScope({
      deploymentEnv: "preview_17",
      projectId: VOICE_HANDSHAKE_OVERLAP_PROJECT_ID,
      streamPath,
    }),
  ).not.toThrow();
  expect(() =>
    assertVoiceHandshakeOverlapScope({
      deploymentEnv: "prd",
      projectId: VOICE_HANDSHAKE_OVERLAP_PROJECT_ID,
      streamPath,
    }),
  ).toThrow("preview_17");
  expect(() =>
    assertVoiceHandshakeOverlapScope({
      deploymentEnv: "preview_17",
      projectId: "prj_other",
      streamPath,
    }),
  ).toThrow("proof project");
  expect(() =>
    VoiceHandshakeOverlapInput.parse({
      streamPath: "/agents/voice/startup-colocated/handshake-overlap/ordinary/test",
      activation,
    }),
  ).toThrow();
});

test("recognizes only the normal live provider request fingerprint", () => {
  const request = new Request(VOICE_HANDSHAKE_OVERLAP_URL, {
    headers: { Upgrade: "websocket", Authorization: 'Bearer getSecret("/secrets/openai")' },
  });
  expect(isVoiceHandshakeOverlapRequest(request)).toBe(true);
  expect(isVoiceHandshakeOverlapRequest(new Request(VOICE_HANDSHAKE_OVERLAP_URL))).toBe(false);
  expect(
    isVoiceHandshakeOverlapRequest(
      new Request(VOICE_HANDSHAKE_OVERLAP_URL, {
        headers: { Upgrade: "websocket", Authorization: 'Bearer getSecret("/secrets/other")' },
      }),
    ),
  ).toBe(false);
});
