/** The next free `untitled.<extension>` (then `untitled-1.…`) inside a directory. */
export function untitledPath(
  directoryPath: string | null,
  taken: ReadonlySet<string>,
  extension = "txt",
): string {
  const prefix =
    directoryPath === null || directoryPath === ""
      ? ""
      : directoryPath.endsWith("/")
        ? directoryPath
        : `${directoryPath}/`;
  for (let n = 0; ; n++) {
    const candidate = `${prefix}untitled${n === 0 ? "" : `-${n}`}.${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}
