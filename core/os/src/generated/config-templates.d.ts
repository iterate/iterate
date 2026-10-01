/** The presets a creation may name, by their label in the dash: core/configs/default first (what
 *  the dash and the consent page start a person's project from), then core's other configs, then
 *  the build's `--template`s (scripts/build.ts). */
export const templates: [ConfigTemplateOption, ...ConfigTemplateOption[]];
type ConfigTemplateOption = { label: string; reference: string };
/** Each preset's files, by the reference `templates` lists it under. */
export const templateFiles: Record<string, { path: string; content: string }[]>;
/** core/configs/minimal's files: what a creation that names no template is seeded with. */
export const minimalConfigFiles: { path: string; content: string }[];
