/**
 * Workspace naming. A workspace is its path under /workspaces/; a name is
 * whatever a person types there, pre-filled with three random words
 * (`apple-cow-hat`) so nobody has to invent one.
 */

const WORDS = [
  "apple",
  "bear",
  "birch",
  "boat",
  "brick",
  "cactus",
  "candle",
  "cedar",
  "cloud",
  "comet",
  "coral",
  "cow",
  "crane",
  "delta",
  "drum",
  "eagle",
  "ember",
  "fern",
  "flint",
  "fox",
  "garnet",
  "goose",
  "harbor",
  "hat",
  "hazel",
  "heron",
  "iris",
  "ivy",
  "jade",
  "kite",
  "lantern",
  "lemon",
  "lily",
  "lynx",
  "maple",
  "meadow",
  "moss",
  "oak",
  "olive",
  "orbit",
  "otter",
  "pearl",
  "pebble",
  "pine",
  "plum",
  "quartz",
  "raven",
  "reef",
  "river",
  "robin",
  "saffron",
  "sage",
  "slate",
  "sparrow",
  "spruce",
  "tiger",
  "tulip",
  "violet",
  "walnut",
  "willow",
  "yarrow",
  "zebra",
];

/** Three random words, dash-joined: the pre-filled name for a new workspace. */
export function newWorkspaceName(random: () => number = Math.random): string {
  const pick = () => WORDS[Math.floor(random() * WORDS.length)]!;
  return `${pick()}-${pick()}-${pick()}`;
}

/**
 * The path a typed name lands at: `/workspaces/<name>`. Segments may nest
 * (`team/notes`); each is letters, digits, dots, dashes, or underscores.
 * Returns null for anything else.
 */
export function workspacePathForName(name: string): string | null {
  const trimmed = name.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))) return null;
  return `/workspaces/${segments.join("/")}`;
}
