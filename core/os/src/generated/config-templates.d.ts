export const templates: { label: string; reference: string }[];
/** Each preset's files, by the reference `templates` lists it under. */
export const templateFiles: Record<string, { path: string; content: string }[]>;
/** core/configs/minimal's files: what a creation that names no template is seeded with. */
export const minimalConfigFiles: { path: string; content: string }[];
