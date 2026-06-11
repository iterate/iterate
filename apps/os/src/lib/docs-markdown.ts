import {
  eventDocs,
  getEventDocByPath,
  getProcessorDocByPath,
  processorDocs,
  type EventDoc,
  type EventReferenceDoc,
  type ProcessorDoc,
} from "~/lib/event-docs.ts";
import { isEventDocsHostname } from "~/lib/event-docs-host.ts";

export function handleDocsMarkdownFetch(input: {
  appBaseUrl: string | undefined;
  request: Request;
}) {
  const url = new URL(input.request.url);
  const isEventDocsHost = isEventDocsHostname({
    appBaseUrl: input.appBaseUrl,
    requestUrl: input.request.url,
  });
  const markdownRequest = resolveDocsMarkdownRequest({
    isEventDocsHost,
    pathname: url.pathname,
  });
  if (!markdownRequest) return null;

  if (!markdownRequest.forceMarkdown && !prefersMarkdown(input.request.headers.get("accept"))) {
    return null;
  }

  const markdown = renderDocsMarkdown(markdownRequest);
  if (!markdown) return null;

  return new Response(markdown, {
    headers: {
      "content-signal": "ai-train=yes, search=yes, ai-input=yes",
      "content-type": "text/markdown; charset=utf-8",
      vary: "accept",
      // Estimated token count: ~1.35 tokens per whitespace-separated word.
      "x-markdown-tokens": Math.ceil(
        markdown.split(/\s+/).filter(Boolean).length * 1.35,
      ).toString(),
    },
  });
}

type DocsMarkdownRequest =
  | { kind: "llms"; forceMarkdown: boolean }
  | { kind: "home"; forceMarkdown: boolean }
  | { kind: "stream-processors"; forceMarkdown: boolean }
  | { kind: "processor"; forceMarkdown: boolean; processor: ProcessorDoc }
  | { kind: "event"; forceMarkdown: boolean; event: EventDoc };

function resolveDocsMarkdownRequest(input: {
  isEventDocsHost: boolean;
  pathname: string;
}): DocsMarkdownRequest | null {
  const path = decodeURIComponent(input.pathname).replace(/^\/+|\/+$/g, "");
  const markdownPath = stripMarkdownIndexSuffix(path);
  const forceMarkdown = markdownPath !== path || path.endsWith(".md") || path.endsWith("llms.txt");

  if (input.isEventDocsHost) {
    if (markdownPath === "" || markdownPath === "docs") return { kind: "home", forceMarkdown };
    if (markdownPath === "llms.txt" || markdownPath === "docs/llms.txt") {
      return { kind: "llms", forceMarkdown: true };
    }
    if (markdownPath.startsWith("docs/")) {
      return resolveCanonicalDocsMarkdownPath({ forceMarkdown, markdownPath });
    }

    const [processorSlug, ...eventSlugParts] = markdownPath.split("/");
    if (!processorSlug) return null;
    if (eventSlugParts.length === 0) {
      const processor = getProcessorDocByPath(processorSlug);
      return processor ? { kind: "processor", processor, forceMarkdown } : null;
    }

    const event = getEventDocByPath(`${processorSlug}/${eventSlugParts.join("/")}`);
    return event ? { kind: "event", event, forceMarkdown } : null;
  }

  return resolveCanonicalDocsMarkdownPath({ forceMarkdown, markdownPath });
}

function resolveCanonicalDocsMarkdownPath(input: {
  forceMarkdown: boolean;
  markdownPath: string;
}): DocsMarkdownRequest | null {
  const { forceMarkdown, markdownPath } = input;
  if (markdownPath === "docs" || markdownPath === "docs/") return { kind: "home", forceMarkdown };
  if (markdownPath === "llms.txt" || markdownPath === "docs/llms.txt") {
    return { kind: "llms", forceMarkdown: true };
  }
  if (markdownPath === "docs/streams/processors") {
    return { kind: "stream-processors", forceMarkdown };
  }

  const processorMatch = markdownPath.match(/^docs\/streams\/processors\/([^/]+)$/);
  if (processorMatch?.[1]) {
    const processor = getProcessorDocByPath(processorMatch[1]);
    return processor ? { kind: "processor", processor, forceMarkdown } : null;
  }

  const eventMatch = markdownPath.match(/^docs\/streams\/processors\/([^/]+)\/events\/(.+)$/);
  if (eventMatch?.[1] && eventMatch[2]) {
    const event =
      getEventDocByPath(`${eventMatch[1]}/${eventMatch[2]}`) ?? getEventDocByPath(eventMatch[2]);
    return event ? { kind: "event", event, forceMarkdown } : null;
  }

  return null;
}

function renderDocsMarkdown(request: DocsMarkdownRequest) {
  switch (request.kind) {
    case "llms":
      return renderLlmsTxt();
    case "home":
      return (
        frontmatter({
          title: "Iterate OS docs",
          description: "Static documentation for Iterate OS runtime concepts.",
        }) +
        [
          "# Iterate OS docs",
          "",
          "Static documentation for Iterate OS runtime concepts.",
          "",
          "## Sections",
          "",
          `- [Stream Processors](/docs/streams/processors) - Processor contracts, event type URLs, payload schemas, and examples.`,
        ].join("\n")
      );
    case "stream-processors":
      return renderStreamProcessorsMarkdown();
    case "processor":
      return renderProcessorMarkdown(request.processor);
    case "event":
      return renderEventMarkdown(request.event);
  }
}

function renderLlmsTxt() {
  return [
    "# Iterate OS docs",
    "",
    "> Documentation index for agents. Request any page with `Accept: text/markdown` or append `/index.md` for Markdown.",
    "",
    "## Docs",
    "",
    "- [Docs home](/docs)",
    "- [Stream Processors](/docs/streams/processors)",
    "",
    "## Stream Processors",
    "",
    ...processorDocs.map(
      (processor) =>
        `- [${processor.slug}](${processor.href}) - ${processor.contract.description ?? "No description."}`,
    ),
  ].join("\n");
}

function renderStreamProcessorsMarkdown() {
  return (
    frontmatter({
      title: "Stream Processors",
      description: "Processor contracts, event type URLs, payload schemas, and examples.",
    }) +
    [
      "# Stream Processors",
      "",
      `Processor contracts: ${processorDocs.length}`,
      `Event types: ${eventDocs.length}`,
      "",
      "## Processors",
      "",
      ...processorDocs.flatMap((processor) => [
        `### [${processor.slug}](${processor.href})`,
        "",
        processor.contract.description ?? "No description.",
        "",
        `Owned events: ${processor.events.length}`,
        "",
      ]),
    ].join("\n")
  );
}

function renderProcessorMarkdown(processor: ProcessorDoc) {
  return (
    frontmatter({
      title: `${processor.slug} stream processor`,
      description: processor.contract.description ?? "Stream processor contract documentation.",
    }) +
    [
      `# ${processor.slug}`,
      "",
      processor.contract.description ?? "No description.",
      "",
      `- Canonical docs path: \`${processor.href}\``,
      `- Contract slug: \`${processor.contract.slug}\``,
      processor.contract.version ? `- Version: \`${processor.contract.version}\`` : undefined,
      "",
      ...sectionList(
        "Processor deps",
        processor.processorDeps.map((dep) => `- [${dep.slug}](${dep.href})`),
      ),
      ...eventReferenceSection("Consumes", processor.consumes),
      ...stringSection("External consumes", processor.unresolvedConsumes),
      ...eventReferenceSection(
        "Emits",
        (processor.contract.emits ?? [])
          .map((type) => eventDocs.find((event) => event.type === type))
          .filter((event): event is EventDoc => event != null),
      ),
      ...stringSection("External emits", processor.unresolvedEmits),
      ...sectionList(
        "Owned events",
        processor.events.map((event) =>
          [`- [${event.type}](${event.href})`, event.description ? `  ${event.description}` : ""]
            .filter(Boolean)
            .join("\n"),
        ),
      ),
    ]
      .filter((line): line is string => line != null)
      .join("\n")
  );
}

function renderEventMarkdown(event: EventDoc) {
  const examples =
    event.examples.length > 0
      ? event.examples
      : [{ description: "Minimal event input", payload: {} }];

  return (
    frontmatter({
      title: event.type,
      description: event.description ?? "Event type documentation.",
    }) +
    [
      `# ${event.type}`,
      "",
      event.description ?? "No description.",
      "",
      `- Canonical event URL: \`https://${event.type}\``,
      `- Canonical docs path: \`${event.href}\``,
      `- Owning processor: [${event.processor.slug}](${event.processor.href})`,
      "",
      "## Payload JSON schema",
      "",
      "```json",
      JSON.stringify(event.payloadJsonSchema, null, 2),
      "```",
      "",
      examples.length === 1 ? "## Example event input" : "## Example event inputs",
      "",
      ...examples.flatMap((example) => [
        `### ${example.description}`,
        "",
        "```json",
        JSON.stringify({ type: event.type, payload: example.payload }, null, 2),
        "```",
        "",
      ]),
    ].join("\n")
  );
}

function eventReferenceSection(title: string, events: readonly EventReferenceDoc[]) {
  return sectionList(
    title,
    events.map((event) => `- ${event.href ? `[${event.type}](${event.href})` : event.type}`),
  );
}

function stringSection(title: string, values: readonly string[]) {
  return sectionList(
    title,
    values.map((value) => `- ${value}`),
  );
}

function sectionList(title: string, items: readonly string[]) {
  if (items.length === 0) return [] as string[];
  return [`## ${title}`, "", ...items, ""];
}

function frontmatter(input: { description: string; title: string }) {
  return [
    "---",
    `title: ${yamlString(input.title)}`,
    `description: ${yamlString(input.description)}`,
    "---",
    "",
  ].join("\n");
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function stripMarkdownIndexSuffix(path: string) {
  if (path === "index.md") return "";
  if (path.endsWith("/index.md")) return path.slice(0, -"/index.md".length);
  if (path.endsWith(".md")) return path.slice(0, -".md".length);
  return path;
}

function prefersMarkdown(accept: string | null) {
  const parsed = parseAccept(accept);
  if (parsed.length === 0) return false;

  const markdown = bestQuality(parsed, ["text/markdown", "text/*"]);
  const html = bestQuality(parsed, ["text/html", "application/xhtml+xml"]);
  const all = bestQuality(parsed, ["*/*"]);

  if (markdown == null) return false;
  if (html == null && all == null) return true;
  return markdown > Math.max(html ?? 0, all ?? 0);
}

function parseAccept(accept: string | null) {
  if (!accept) return [] as Array<{ mediaType: string; q: number }>;

  return accept
    .split(",")
    .map((part) => {
      const [mediaType, ...params] = part.trim().split(";");
      const qParam = params.find((param) => param.trim().startsWith("q="));
      const q = qParam ? Number(qParam.trim().slice(2)) : 1;
      return mediaType
        ? { mediaType: mediaType.toLowerCase(), q: Number.isFinite(q) ? q : 0 }
        : null;
    })
    .filter((item): item is { mediaType: string; q: number } => item != null && item.q > 0);
}

function bestQuality(parsed: readonly { mediaType: string; q: number }[], mediaTypes: string[]) {
  const matches = parsed.filter((item) => mediaTypes.includes(item.mediaType));
  if (matches.length === 0) return null;
  return Math.max(...matches.map((item) => item.q));
}
