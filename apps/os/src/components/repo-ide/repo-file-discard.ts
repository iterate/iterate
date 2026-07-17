export const NEW_FILE_DISCARD_CONFIRMATION =
  "Are you sure? You may not be able to recover this file";

export function discardRepoFile({
  path,
  headHasPath,
  selected,
  confirmDiscard,
  discardWorking,
  removeWorkingFile,
  closeSelectedFile,
}: {
  path: string;
  headHasPath: boolean;
  selected: boolean;
  confirmDiscard: (message: string) => boolean;
  discardWorking: (path: string) => void;
  removeWorkingFile: (path: string) => void;
  closeSelectedFile: () => void;
}): void {
  if (headHasPath) {
    discardWorking(path);
    return;
  }
  if (!confirmDiscard(NEW_FILE_DISCARD_CONFIRMATION)) return;
  if (selected) closeSelectedFile();
  removeWorkingFile(path);
}
