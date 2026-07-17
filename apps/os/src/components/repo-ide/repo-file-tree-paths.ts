export function untitledPath(directoryPath: string | null, taken: ReadonlySet<string>): string {
  const prefix =
    directoryPath === null || directoryPath === ""
      ? ""
      : directoryPath.endsWith("/")
        ? directoryPath
        : `${directoryPath}/`;
  for (let n = 0; ; n++) {
    const candidate = `${prefix}untitled${n === 0 ? "" : `-${n}`}.txt`;
    if (!taken.has(candidate)) return candidate;
  }
}
