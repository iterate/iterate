export const templates: { label: string; reference: string }[];
/** Each preset's files, by the reference `templates` lists it under. */
export const templateFiles: Record<string, { path: string; content: string }[]>;
