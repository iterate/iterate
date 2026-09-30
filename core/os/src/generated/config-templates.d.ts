export const templates: { label: string; reference: string }[];
export const defaultFiles: { path: string; content: string }[];
/** Each preset's files, by the reference `templates` lists it under. */
export const templateFiles: Record<string, { path: string; content: string }[]>;
