import {
  HTML_RENDERER_CONFIGURED_TYPE,
  HtmlRendererConfiguredEvent,
  type Event,
} from "@iterate-com/events-contract";
import jsonata from "jsonata";
import Mustache from "mustache";
import type {
  CustomHtmlRenderErrorFeedItem,
  CustomHtmlRenderedEventFeedItem,
  StreamFeedItem,
} from "~/lib/stream-feed-types.ts";

type HtmlRendererDefinition = {
  slug: string;
  matcher: string;
  template: string;
};

export function isHtmlRendererConfiguredEvent(event: Event) {
  return event.type === HTML_RENDERER_CONFIGURED_TYPE;
}

export async function buildCustomHtmlRendererInsertions(events: readonly Event[]) {
  const insertionsByOffset = new Map<number, StreamFeedItem[]>();
  const renderers = collectHtmlRenderers(events);

  if (renderers.size === 0) {
    return insertionsByOffset;
  }

  for (const event of events) {
    if (isHtmlRendererConfiguredEvent(event)) {
      continue;
    }

    for (const renderer of renderers.values()) {
      const item = await renderCustomHtmlFeedItem({ event, renderer });
      if (item == null) {
        continue;
      }

      const existing = insertionsByOffset.get(event.offset);
      if (existing) {
        existing.push(item);
      } else {
        insertionsByOffset.set(event.offset, [item]);
      }
    }
  }

  return insertionsByOffset;
}

function collectHtmlRenderers(events: readonly Event[]) {
  const renderers = new Map<string, HtmlRendererDefinition>();

  for (const event of events) {
    const parsed = HtmlRendererConfiguredEvent.safeParse(event);
    if (!parsed.success) {
      continue;
    }

    renderers.delete(parsed.data.payload.slug);
    renderers.set(parsed.data.payload.slug, parsed.data.payload);
  }

  return renderers;
}

async function renderCustomHtmlFeedItem({
  event,
  renderer,
}: {
  event: Event;
  renderer: HtmlRendererDefinition;
}): Promise<CustomHtmlRenderedEventFeedItem | CustomHtmlRenderErrorFeedItem | null> {
  try {
    const matched = await jsonata(renderer.matcher).evaluate(event);
    if (!matched) {
      return null;
    }

    return {
      kind: "custom-html-rendered-event",
      slug: renderer.slug,
      eventType: event.type,
      html: Mustache.render(renderer.template, event),
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  } catch (error) {
    return {
      kind: "custom-html-render-error",
      slug: renderer.slug,
      eventType: event.type,
      message: error instanceof Error ? error.message : String(error),
      timestamp: getTimestamp(event.createdAt),
      raw: event,
    };
  }
}

function getTimestamp(createdAt: string) {
  return Number.isNaN(Date.parse(createdAt)) ? Date.now() : Date.parse(createdAt);
}
