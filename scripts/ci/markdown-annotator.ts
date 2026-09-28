// scripts/ci/markdown-annotator.ts — THE MANAGED SECTIONS CI writes into a pull request's body
// (docs/pull-requests.md): `<!-- <label> -->`, the contents, `<!-- /<label> -->`, the markup Bugbot's
// `CURSOR_SUMMARY` section has too. The LOC report's (scripts/ci/loc-report.ts) and the preview's
// (apps/os/scripts/preview-config.ts).

function markers(label: string) {
  return { begin: `<!-- ${label} -->`, end: `<!-- /${label} -->` };
}

/** The contents of `body`'s section `label`, trimmed, or undefined when it has none. */
export function markedSection(body: string, label: string) {
  const { begin, end } = markers(label);
  const start = body.indexOf(begin);
  const stop = body.indexOf(end, start);
  if (start < 0 || stop < start) return undefined;
  return body.slice(start + begin.length, stop).trim();
}

/** `body` with its section `label` holding `contents`: the section replaced in place, or appended
 *  after a blank line. Everything a person wrote around it is kept verbatim. */
export function replaceMarkedSection(body: string, label: string, contents: string) {
  const { begin, end } = markers(label);
  const block = `${begin}\n${contents.trim()}\n${end}`;
  const start = body.indexOf(begin);
  const stop = body.indexOf(end, start);
  if (start >= 0 && stop > start)
    return body.slice(0, start) + block + body.slice(stop + end.length);
  const kept = body.trimEnd();
  return `${kept ? `${kept}\n\n` : ""}${block}\n`;
}
