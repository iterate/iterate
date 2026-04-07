export function markdownAnnotator(body: string, label: string) {
  const startMarker = `<!-- ${label} -->`;
  const endMarker = `<!-- /${label} -->`;
  const lines = body.split("\n");
  const startLine = lines.findIndex((line) => line.trim() === startMarker);
  const endLine = lines.findIndex((line, index) => index > startLine && line.trim() === endMarker);

  if (startLine === -1 || endLine === -1) {
    return {
      current: null,
      update: (contents: string) => {
        const trimmedBody = body.trim();
        const block = `${startMarker}\n${contents}\n${endMarker}`;

        return trimmedBody ? `${trimmedBody}\n\n${block}` : block;
      },
    };
  }

  return {
    current: lines.slice(startLine + 1, endLine).join("\n"),
    update: (contents: string) =>
      [
        ...lines.slice(0, startLine),
        startMarker,
        contents,
        endMarker,
        ...lines.slice(endLine + 1),
      ].join("\n"),
  };
}
