import { expect, test } from "vitest";
import { base64ToInt16, FRAME_SAMPLES, int16ToBase64 } from "./audio.ts";

test("a 50 ms frame round-trips through the relay's base64 wire shape", () => {
  const frame = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < frame.length; i += 1) frame[i] = Math.round(Math.sin(i / 7) * 0x7000);
  const wire = int16ToBase64(frame);
  expect(wire.length).toBe(Math.ceil((FRAME_SAMPLES * 2) / 3) * 4); // 1,600 bytes of PCM
  expect(Array.from(base64ToInt16(wire))).toEqual(Array.from(frame));
});

test("silence is the all-A string the relay recognises without decoding", () => {
  expect(int16ToBase64(new Int16Array(FRAME_SAMPLES))).toMatch(/^A+=*$/);
});

test("an odd byte count on the way back drops the dangling byte instead of throwing", () => {
  const three = btoa(String.fromCharCode(1, 2, 3));
  expect(base64ToInt16(three).length).toBe(1);
});
