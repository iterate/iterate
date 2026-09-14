const fs = require("node:fs");
const path = require("node:path");

/**
 * Lint-codegen preset (see viseme-model.generated.ts): re-embeds the HeadAudio
 * viseme model binary viseme-model.bin as a base64 TypeScript module. Dynamic
 * workers read repo files as text only, so the binary must ride inside a
 * regular module; drift between the .bin and the generated module is a fixable
 * `codegen/codegen` lint error.
 *
 * The model asset comes from met4citizen/HeadAudio (MIT, Copyright (c) 2025
 * Mika Suominen) — see HEAD_AUDIO_LICENSE.txt alongside this file.
 */
exports.visemeModelBase64Module = ({ meta }) => {
  const binPath = path.resolve(path.dirname(meta.filename), "viseme-model.bin");
  const base64 = fs.readFileSync(binPath).toString("base64");
  const lines = [];
  for (let offset = 0; offset < base64.length; offset += 96) {
    lines.push(`  "${base64.slice(offset, offset + 96)}"`);
  }
  return [
    "const VISEME_MODEL_BASE64 =",
    `${lines.join(" +\n")};`,
    "",
    "/** Decodes the embedded HeadAudio model to the exact bytes of viseme-model.bin. */",
    "export function visemeModelBytes(): Uint8Array {",
    "  return Uint8Array.from(atob(VISEME_MODEL_BASE64), (character) => character.charCodeAt(0));",
    "}",
  ].join("\n");
};
