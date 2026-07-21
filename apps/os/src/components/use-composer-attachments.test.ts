import { expect, test } from "vitest";
import {
  fileSizeErrorMessage,
  MAX_MESSAGE_FILE_SIZE_BYTES,
  partitionFilesBySize,
} from "./use-composer-attachments.ts";

function fakeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "text/plain" });
}

test("partitionFilesBySize splits accepted and rejected at the size limit", () => {
  const small = fakeFile("ok.txt", 10);
  const atLimit = fakeFile("edge.bin", MAX_MESSAGE_FILE_SIZE_BYTES);
  const large = fakeFile("big.bin", MAX_MESSAGE_FILE_SIZE_BYTES + 1);
  const result = partitionFilesBySize([small, atLimit, large]);
  expect(result.accepted).toEqual([small, atLimit]);
  expect(result.rejected).toEqual([large]);
});

test("fileSizeErrorMessage names one file or a count", () => {
  expect(fileSizeErrorMessage([])).toBeUndefined();
  expect(fileSizeErrorMessage([fakeFile("photo.png", 1)])).toBe(
    "photo.png must be 25 MB or smaller.",
  );
  expect(fileSizeErrorMessage([fakeFile("a.bin", 1), fakeFile("b.bin", 1)])).toBe(
    "2 files must be 25 MB or smaller.",
  );
});
