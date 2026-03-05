export async function tImport(path: string) {
  try {
    // Try to import the file as a module with native import
    return await import(path);
  } catch {
    // If native import fails, use tsx's tsImport function
    const { tsImport } = await import("tsx/esm/api");
    return await tsImport(path, { parentURL: import.meta.url });
  }
}
