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

export type CustomHtmlRendererProjection = {
  insertionsByOffset: Map<number, StreamFeedItem[]>;
  eventCount: number;
  lastOffset?: number;
  rendererKey: string;
};

const matcherExpressions = new Map<string, ReturnType<typeof jsonata>>();

export function isHtmlRendererConfiguredEvent(event: Event) {
  return event.type === HTML_RENDERER_CONFIGURED_TYPE;
}

export async function buildCustomHtmlRendererInsertions(events: readonly Event[]) {
  const projection = await buildCustomHtmlRendererProjection({ events });
  return projection.insertionsByOffset;
}

export async function buildCustomHtmlRendererProjection({
  events,
  previousProjection,
  signal,
}: {
  events: readonly Event[];
  previousProjection?: CustomHtmlRendererProjection;
  signal?: AbortSignal;
}) {
  const renderers = collectHtmlRenderers(events);
  const rendererKey = getRendererKey(renderers);
  const canReusePrevious =
    previousProjection != null &&
    previousProjection.rendererKey === rendererKey &&
    previousProjection.eventCount <= events.length &&
    events[previousProjection.eventCount - 1]?.offset === previousProjection.lastOffset;
  const insertionsByOffset = canReusePrevious
    ? new Map(previousProjection.insertionsByOffset)
    : new Map<number, StreamFeedItem[]>();
  const startIndex = canReusePrevious ? previousProjection.eventCount : 0;

  if (renderers.size > 0) {
    for (const event of events.slice(startIndex)) {
      throwIfAborted(signal);
      if (isHtmlRendererConfiguredEvent(event)) {
        continue;
      }

      for (const renderer of renderers.values()) {
        const item = await renderCustomHtmlFeedItem({ event, renderer, signal });
        if (item == null) {
          continue;
        }

        const existing = insertionsByOffset.get(event.offset);
        if (existing) {
          insertionsByOffset.set(event.offset, [...existing, item]);
        } else {
          insertionsByOffset.set(event.offset, [item]);
        }
      }
    }
  }

  return {
    insertionsByOffset,
    eventCount: events.length,
    lastOffset: events.at(-1)?.offset,
    rendererKey,
  } satisfies CustomHtmlRendererProjection;
}

function collectHtmlRenderers(events: readonly Event[]) {
  const renderers = new Map<string, HtmlRendererDefinition>();

  for (const event of events) {
    const parsed = HtmlRendererConfiguredEvent.safeParse(event);
    if (!parsed.success) {
      continue;
    }

    renderers.set(parsed.data.payload.slug, parsed.data.payload);
  }

  return renderers;
}

async function renderCustomHtmlFeedItem({
  event,
  renderer,
  signal,
}: {
  event: Event;
  renderer: HtmlRendererDefinition;
  signal?: AbortSignal;
}): Promise<CustomHtmlRenderedEventFeedItem | CustomHtmlRenderErrorFeedItem | null> {
  try {
    let matcherExpression = matcherExpressions.get(renderer.matcher);
    if (matcherExpression == null) {
      matcherExpression = jsonata(renderer.matcher);
      matcherExpressions.set(renderer.matcher, matcherExpression);
    }

    const matched = await matcherExpression.evaluate(event);
    throwIfAborted(signal);
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

function getRendererKey(renderers: ReadonlyMap<string, HtmlRendererDefinition>) {
  return JSON.stringify(
    [...renderers.values()].map((renderer) => [renderer.slug, renderer.matcher, renderer.template]),
  );
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("HTML renderer projection aborted");
  }
}
