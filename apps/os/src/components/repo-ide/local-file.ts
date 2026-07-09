/** Open the browser's file picker; null when the user cancels. */
export function pickLocalFile(accept?: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (accept) input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] || null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** A picked file's bytes as standard base64 — the repo binary write lane. */
export async function localFileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
