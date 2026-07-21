import { useRef, useState } from "react";
import { formatFileSize } from "~/lib/feed-format.ts";

export const MAX_MESSAGE_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export function partitionFilesBySize(files: readonly File[]): {
  accepted: File[];
  rejected: File[];
} {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const file of files) {
    if (file.size <= MAX_MESSAGE_FILE_SIZE_BYTES) accepted.push(file);
    else rejected.push(file);
  }
  return { accepted, rejected };
}

export function fileSizeErrorMessage(rejected: readonly File[]): string | undefined {
  if (rejected.length === 0) return undefined;
  const label = rejected.length === 1 ? rejected[0]!.name : `${rejected.length} files`;
  return `${label} must be ${formatFileSize(MAX_MESSAGE_FILE_SIZE_BYTES)} or smaller.`;
}

export type AttachmentEntry = { id: string; file: File };

export type ComposerAttachments = ReturnType<typeof useComposerAttachments>;

/**
 * The one file-attachment state machine every composer shares: size limits,
 * the oversize warning, stable chip identity, and the hidden picker input
 * (render `AttachmentFileInput` from composer-attachments.tsx once next to
 * the composer).
 */
export function useComposerAttachments() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [entries, setEntries] = useState<AttachmentEntry[]>([]);
  const [fileError, setFileError] = useState<string>();

  function addFiles(fileList: FileList | null) {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    const { accepted, rejected } = partitionFilesBySize(files);
    setFileError(fileSizeErrorMessage(rejected));
    if (accepted.length > 0) {
      setEntries((previous) => [
        ...previous,
        ...accepted.map((file) => ({ id: crypto.randomUUID(), file })),
      ]);
    }
  }

  function removeFile(id: string) {
    setEntries((previous) => previous.filter((entry) => entry.id !== id));
    // The oversize warning is transient; any deliberate chip interaction
    // dismisses it.
    setFileError(undefined);
  }

  function clearFiles() {
    setEntries([]);
    setFileError(undefined);
  }

  return {
    entries,
    files: entries.map((entry) => entry.file),
    fileError,
    addFiles,
    removeFile,
    clearFiles,
    openFilePicker: () => inputRef.current?.click(),
    inputRef,
  };
}
