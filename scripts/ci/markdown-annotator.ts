// scripts/ci/markdown-annotator.ts — THE MANAGED SECTIONS CI writes into a pull request's body
// (docs/pull-requests.md): a line `<!-- <label> -->`, the contents, a line `<!-- /<label> -->`, the
// markup Bugbot's `CURSOR_SUMMARY` section has too. The LOC report's (scripts/ci/loc-report.ts) and
// the preview's (scripts/os/preview-config.ts). A marker is a line of its own: one a person
// quotes inside a sentence is prose.

function markerLines(lines: string[], label: string) {
  const start = lines.findIndex((line) => line.trim() === `<!-- ${label} -->`);
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === `<!-- /${label} -->`,
  );
  return start >= 0 && end > start ? { start, end } : undefined;
}

/** The contents of `body`'s section `label`, trimmed, or undefined when it has none. */
export function markedSection(body: string, label: string) {
  const lines = body.split("\n");
  const markers = markerLines(lines, label);
  if (!markers) return undefined;
  return lines
    .slice(markers.start + 1, markers.end)
    .join("\n")
    .trim();
}

/** `body` with its section `label` holding `contents`: the section replaced in place, or appended
 *  after a blank line. Every line a person wrote around it is kept verbatim. */
export function replaceMarkedSection(body: string, label: string, contents: string) {
  const block = `<!-- ${label} -->\n${contents.trim()}\n<!-- /${label} -->`;
  const lines = body.split("\n");
  const markers = markerLines(lines, label);
  if (markers)
    return [...lines.slice(0, markers.start), block, ...lines.slice(markers.end + 1)].join("\n");
  const kept = body.trimEnd();
  return `${kept ? `${kept}\n\n` : ""}${block}\n`;
}
