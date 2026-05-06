import type { EventsStreamBuiltInElement } from "@iterate-com/ui/components/events/feed-items";

export type TuiSlashSuggestion = {
  path: string;
  segments: { text: string; matched: boolean }[];
};

export function getRawEventSummariesForTui(elements: readonly EventsStreamBuiltInElement[]) {
  return elements
    .flatMap((element) => (element.type === "grouped-raw-event" ? element.props.events : []))
    .sort((a, b) => a.offset - b.offset);
}

export function formatCommandDocsForTui(command: {
  slash: { name: string };
  description?: string;
  title: string;
  input?: {
    positional?: { name: string; required?: boolean; placeholder?: string };
    options?: readonly { flag: string; name: string }[];
    flags?: readonly { flag: string }[];
  };
}) {
  const lines = [`/${command.slash.name}  ${command.description ?? command.title}`];
  if (command.input?.positional) {
    const positional = command.input.positional;
    lines.push(
      `  <${positional.name}>${positional.required ? "" : "?"} ${positional.placeholder ?? ""}`,
    );
  }
  for (const option of command.input?.options ?? []) {
    lines.push(`  ${option.flag} <${option.name}>`);
  }
  for (const flag of command.input?.flags ?? []) {
    lines.push(`  ${flag.flag}`);
  }
  return lines;
}
