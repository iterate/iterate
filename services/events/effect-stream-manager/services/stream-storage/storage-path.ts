const DEFAULT_SQLITE_FILENAME = "events.sqlite";

const firstNonEmpty = (...values: Array<string | undefined>): string | undefined => {
  for (const value of values) {
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
};

export const resolveSqliteFilenameFromEnv = (env: Record<string, string | undefined>): string =>
  firstNonEmpty(env.DATABASE_URL) ?? DEFAULT_SQLITE_FILENAME;

export const defaultSqliteFilename = DEFAULT_SQLITE_FILENAME;
