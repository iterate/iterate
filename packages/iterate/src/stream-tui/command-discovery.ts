export type SlashCommandRecord = {
  path: string;
  title: string;
  description?: string;
  slash: {
    name: string;
    aliases?: string[];
  };
  menu?: {
    hidden?: boolean;
  };
  input?: SlashCommandInputMeta;
};

export type SlashCommandInputMeta = {
  positional?: {
    name: string;
    required: boolean;
    placeholder?: string;
  };
  options?: SlashCommandStringOptionMeta[];
  flags?: SlashCommandBooleanFlagMeta[];
};

export type SlashCommandStringOptionMeta = {
  name: string;
  flag: `--${string}`;
};

export type SlashCommandBooleanFlagMeta = {
  name: string;
  flag: `--${string}`;
  value: boolean;
};

export type SlashCommandLabelSegment = {
  text: string;
  matched: boolean;
};

export type FuzzyMatchRange = {
  start: number;
  end: number;
};

/**
 * Extract the slash query from an input string like "/vie" → "vie".
 * Returns undefined if the input isn't a slash query (no leading "/" or has spaces).
 */
export function parseSlashAutocompleteQuery(input: string) {
  if (!input.startsWith("/")) return undefined;

  const query = input.slice(1);
  if (query.includes(" ")) return undefined;

  return query.toLowerCase();
}

/** Find a command by exact slash name or alias match. */
export function findSlashCommand<TCommand extends SlashCommandRecord>(args: {
  commands: readonly TCommand[];
  slash: string;
}) {
  const slash = args.slash.toLowerCase();
  return args.commands.find((command) => {
    const meta = command.slash;
    return (
      meta.name.toLowerCase() === slash ||
      meta.aliases?.some((alias) => alias.toLowerCase() === slash) === true
    );
  });
}

/**
 * Return up to `limit` commands matching the slash query in the input,
 * ranked by match quality (exact > prefix > substring > fuzzy).
 * Aliases are scored but don't create duplicate entries.
 */
export function suggestSlashCommands<TCommand extends SlashCommandRecord>(args: {
  commands: readonly TCommand[];
  input: string;
  limit: number;
}) {
  const query = parseSlashAutocompleteQuery(args.input);
  if (query == null) return [];

  return args.commands
    .filter((command) => !command.menu?.hidden)
    .map((command) => ({
      command,
      score: scoreSlashCommand({ command, query }),
    }))
    .filter((suggestion) => suggestion.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.command.path.localeCompare(right.command.path),
    )
    .slice(0, args.limit)
    .map((suggestion) => suggestion.command);
}

export function acceptedSlashInput(command: SlashCommandRecord) {
  return `/${command.slash.name}${commandNeedsInput(command) ? " " : ""}`;
}

export function formatSlashCommandLabel(command: SlashCommandRecord) {
  return formatSlashCommandLabelSegments({ command, input: "" })
    .map((segment) => segment.text)
    .join("");
}

export function formatSlashCommandLabelSegments(args: {
  command: SlashCommandRecord;
  input: string;
}): SlashCommandLabelSegment[] {
  const path = `/${args.command.slash.name}`;
  const description = args.command.description ?? args.command.title;
  const query = parseSlashAutocompleteQuery(args.input) ?? "";
  const ranges = query.length === 0 ? [] : fuzzyMatchRanges(args.command.slash.name, query);

  return [
    ...splitMatchedSegments({
      text: path.padEnd(17),
      ranges: ranges.map((range) => ({ start: range.start + 1, end: range.end + 1 })),
    }),
    { text: ` ${description}`, matched: false },
  ];
}

function scoreSlashCommand(args: { command: SlashCommandRecord; query: string }) {
  if (args.query.length === 0) return 1;

  const slash = args.command.slash.name.toLowerCase();
  const aliases = args.command.slash.aliases?.map((alias) => alias.toLowerCase()) ?? [];
  const title = args.command.title.toLowerCase();

  if (slash === args.query) return 100;
  if (aliases.includes(args.query)) return 90;
  if (slash.startsWith(args.query)) return 80;
  if (aliases.some((alias) => alias.startsWith(args.query))) return 70;
  if (slash.includes(args.query)) return 40;
  if (aliases.some((alias) => alias.includes(args.query))) return 35;
  if (title.includes(args.query)) return 20;
  if (aliases.some((alias) => fuzzyMatchRanges(alias, args.query).length > 0)) return 45;
  if (fuzzyMatchRanges(slash, args.query).length > 0) return 18;
  if (fuzzyMatchRanges(title, args.query).length > 0) return 10;
  return 0;
}

function commandNeedsInput(command: SlashCommandRecord) {
  return command.input?.positional?.required === true;
}

/**
 * Find character ranges in `value` that match `query` — first tries contiguous
 * substring, then falls back to sparse character-by-character fuzzy match.
 * Returns empty array if no match.
 */
export function fuzzyMatchRanges(value: string, query: string): FuzzyMatchRange[] {
  const normalizedValue = value.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  const contiguousIndex = normalizedValue.indexOf(normalizedQuery);

  if (contiguousIndex !== -1) {
    return [{ start: contiguousIndex, end: contiguousIndex + normalizedQuery.length }];
  }

  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;

  for (const char of normalizedQuery) {
    const index = normalizedValue.indexOf(char, cursor);
    if (index === -1) return [];

    ranges.push({ start: index, end: index + 1 });
    cursor = index + 1;
  }

  return ranges;
}

/** Split text into segments tagged as matched or unmatched based on fuzzy match ranges. */
export function splitMatchedSegments(args: { text: string; ranges: readonly FuzzyMatchRange[] }) {
  const segments: SlashCommandLabelSegment[] = [];
  let cursor = 0;

  for (const range of args.ranges) {
    if (range.start > cursor) {
      segments.push({ text: args.text.slice(cursor, range.start), matched: false });
    }

    segments.push({ text: args.text.slice(range.start, range.end), matched: true });
    cursor = range.end;
  }

  if (cursor < args.text.length) {
    segments.push({ text: args.text.slice(cursor), matched: false });
  }

  return segments.filter((segment) => segment.text.length > 0);
}
