import type { SlashCommandInputMeta } from "./command-discovery.ts";

export class MissingCommandArgumentsError extends Error {
  readonly slashName: string;

  constructor(args: { commandTitle: string; slashName: string }) {
    super(`${args.commandTitle} needs input`);
    this.slashName = args.slashName;
  }
}

export type ParsedSlashInvocation = {
  slash: string;
  rawArgs: string;
};

export function parseSlashInvocation(input: string): ParsedSlashInvocation | undefined {
  if (!input.startsWith("/")) return undefined;

  const [slash = "", ...args] = input.slice(1).trim().split(/\s+/);
  return { slash, rawArgs: args.join(" ") };
}

export function parseSlashCommandInput(args: {
  commandTitle: string;
  slashName: string;
  input?: SlashCommandInputMeta;
  rawArgs: string;
}) {
  if (args.input == null) {
    if (args.rawArgs.trim().length > 0) {
      throw new Error(`/${args.slashName} takes no arguments`);
    }

    return undefined;
  }

  let remainingArgs = args.rawArgs.trim();
  const input: Record<string, unknown> = {};

  for (const option of args.input.options ?? []) {
    input[option.name] = readStringOption(remainingArgs, option.flag);
    remainingArgs = removeStringOption(remainingArgs, option.flag);
  }

  for (const flag of args.input.flags ?? []) {
    if (hasFlag(remainingArgs, flag.flag)) {
      input[flag.name] = flag.value;
      remainingArgs = removeFlag(remainingArgs, flag.flag);
    }
  }

  const positional = args.input.positional;
  if (positional != null) {
    if (remainingArgs.length === 0 && positional.required) {
      throw new MissingCommandArgumentsError({
        commandTitle: args.commandTitle,
        slashName: args.slashName,
      });
    }

    if (remainingArgs.length > 0) {
      input[positional.name] = remainingArgs;
    }
  } else if (remainingArgs.length > 0) {
    throw new Error(`/${args.slashName} takes no positional arguments`);
  }

  return input;
}

export function readStringOption(rawArgs: string, optionName: string) {
  return matchStringOption(rawArgs, optionName)?.value;
}

export function removeStringOption(rawArgs: string, optionName: string) {
  const match = matchStringOption(rawArgs, optionName);
  if (match == null) return rawArgs;

  return `${rawArgs.slice(0, match.start)} ${rawArgs.slice(match.end)}`.trim();
}

function requireRawArgs(args: { commandTitle: string; slashName: string; rawArgs: string }) {
  const rawArgs = removeStringOption(args.rawArgs, "--stream").trim();
  if (rawArgs.length === 0) {
    throw new MissingCommandArgumentsError({
      commandTitle: args.commandTitle,
      slashName: args.slashName,
    });
  }

  return rawArgs;
}

function matchStringOption(rawArgs: string, optionName: string) {
  const pattern = new RegExp(
    `(?:^|\\s)${escapeRegExp(optionName)}(?:=|\\s+)(?:"([^"]+)"|'([^']+)'|(\\S+))`,
  );
  const match = pattern.exec(rawArgs);
  if (match == null || match.index == null) return undefined;

  return {
    start: match.index,
    end: match.index + match[0].length,
    value: match[1] ?? match[2] ?? match[3] ?? "",
  };
}

function hasFlag(rawArgs: string, flagName: string) {
  return rawArgs.split(/\s+/).includes(flagName);
}

function removeFlag(rawArgs: string, flagName: string) {
  return rawArgs
    .split(/\s+/)
    .filter((part) => part !== flagName)
    .join(" ")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
