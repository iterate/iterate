const fs = require("node:fs");
const path = require("node:path");

/**
 * Lint-codegen preset (see voice-template.generated.ts): embeds the
 * configs/voice-agent guest-worker sources in the app bundle, walked from the
 * entry point's own relative imports — the exact rule
 * apps/os/scripts/voicelab/deploy.ts uses to decide what travels, so the two
 * can never disagree about what a complete install is. The app commits these
 * into a project's config repo when a call finds no voice agent installed
 * (auto-install during the ring). Embedded rather than fetched so the
 * installed template is ALWAYS the version this app was built against —
 * a runtime fetch of main could install a facet whose certificate schema
 * rejects this app's own setup options. Drift between the folder and the
 * generated module is a fixable `codegen/codegen` lint error.
 */
exports.voiceAgentTemplateFiles = ({ meta }) => {
  const templateDir = path.resolve(path.dirname(meta.filename), "../../../../configs/voice-agent");
  const entryName = "voice-agent.ts";
  const files = new Map();
  const queue = [entryName];
  while (queue.length > 0) {
    const name = queue.shift();
    if (files.has(name)) continue;
    const content = fs.readFileSync(path.join(templateDir, name), "utf8");
    files.set(name, content);
    for (const match of content.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']*)["']/g)) {
      const specifier = match[1];
      const imported = specifier.slice(2);
      if (!specifier.startsWith("./") || imported.includes("/")) {
        throw new Error(
          `${name} imports ${specifier}, but a project's config repo is flat: ` +
            `everything the guest imports must sit beside it.`,
        );
      }
      queue.push(imported);
    }
  }
  const quote = (value) => JSON.stringify(value).replaceAll("codegen:", "\\u0063odegen:");
  const entries = [...files].map(([name, content]) => ({ content, path: name }));
  return [
    "export const VOICE_AGENT_TEMPLATE_FILES: { content: string; path: string }[] = [",
    ...entries.flatMap((entry) => {
      // One emitted line per source line (each segment keeps its trailing
      // \n), so git merges this file exactly when it merges the template.
      // An ARRAY joined at runtime, not a `+` chain: voice-agent.ts is
      // ~5600 lines, and a binary-operator chain that long overflows the
      // parser stack of every bundler that touches this module.
      const segments = entry.content.split(/(?<=\n)/);
      return [
        "  {",
        `    path: ${quote(entry.path)},`,
        "    content: [",
        ...segments.map((segment) => `      ${quote(segment)},`),
        '    ].join(""),',
        "  },",
      ];
    }),
    "];",
  ].join("\n");
};
