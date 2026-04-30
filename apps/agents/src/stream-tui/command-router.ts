import type { Event, EventInput, StreamPath } from "@iterate-com/events-contract";
import type { EventsStreamViewState } from "@iterate-com/ui/components/events/feed-items";
import { call, isProcedure, os, type AnyProcedure } from "@orpc/server";
import { z } from "zod";
import type { SlashCommandRecord } from "./command-discovery.ts";
import type { StreamTuiView } from "./navigation-state.ts";

export type StreamSummary = {
  path: StreamPath;
  createdAt: string;
};

export type TuiCommandMeta = {
  title: string;
  description?: string;
  category?: string;
  slash?: {
    name: string;
    aliases?: string[];
  };
  keybind?: string;
  menu?: {
    hidden?: boolean;
    suggested?: boolean;
  };
  input?: SlashCommandRecord["input"];
};

export type StreamApi = {
  append: (args: { event: EventInput; streamPath?: string }) => Promise<Event>;
  getState: (args?: { streamPath?: string }) => Promise<unknown>;
  listChildren: (args?: { streamPath?: string }) => Promise<StreamSummary[]>;
  reset: (args: { streamPath?: string; destroyChildren: boolean }) => Promise<unknown>;
  resolvePath: (streamPath?: string) => StreamPath;
};

export type AppContext = {
  get streamPath(): StreamPath;
  get reducedState(): EventsStreamViewState;
  streamApi: StreamApi;
  setActiveView: (view: StreamTuiView) => void;
  switchFeedMode: (mode: "raw" | "mixed" | "chat") => void;
  setStreamSummaries: (streams: StreamSummary[], filter?: string) => void;
  navigateToStream: (streamPath: StreamPath) => void;
  restartStream: () => void;
  prefillInput: (value: string) => void;
  collapseVisibleFeedItems: () => void;
  expandVisibleFeedItems: () => void;
  openEventDetail: (offset: number) => void;
  exit: () => void;
  toast: {
    info: (message: string) => void;
    success: (message: string) => void;
    error: (message: string) => void;
  };
};

export type CommandEntry = SlashCommandRecord & {
  pathSegments: string[];
  meta: TuiCommandMeta;
  procedure: CommandProcedure;
};

type CommandProcedure = AnyProcedure;

const commandBase = os.$context<AppContext>().$meta<{ tui: TuiCommandMeta }>({
  tui: { title: "Untitled command" },
});

// Local TUI commands are modeled as oRPC procedures so hierarchy, input
// schemas, handlers, and display metadata live in one inspectable shape. This
// follows OpenCode's "one command registry feeds command discovery" model,
// while keeping this first pass slash-first and React/OpenTUI-agnostic:
// https://github.com/sst/opencode/blob/dev/packages/opencode/src/cli/cmd/tui/component/dialog-command.tsx
const commandRouter = {
  view: {
    feed: commandBase
      .meta({
        tui: {
          title: "Show feed",
          description: "Return to the event feed",
          category: "View",
          slash: { name: "view.feed", aliases: ["feed"] },
        },
      })
      .handler(({ context }) => {
        context.setActiveView("feed");
      }),
    raw: commandBase
      .meta({
        tui: {
          title: "Raw mode",
          description: "Show one raw YAML card per event",
          category: "View",
          slash: { name: "view.raw", aliases: ["raw"] },
        },
      })
      .handler(({ context }) => {
        context.switchFeedMode("raw");
      }),
    mixed: commandBase
      .meta({
        tui: {
          title: "Mixed mode",
          description: "Summary rows + pretty renderers (default)",
          category: "View",
          slash: { name: "view.mixed", aliases: ["mixed"] },
        },
      })
      .handler(({ context }) => {
        context.switchFeedMode("mixed");
      }),
    chat: commandBase
      .meta({
        tui: {
          title: "Chat mode",
          description: "Pretty renderers only (for conversational streams)",
          category: "View",
          slash: { name: "view.chat", aliases: ["chat"] },
        },
      })
      .handler(({ context }) => {
        context.switchFeedMode("chat");
      }),
    state: commandBase
      .meta({
        tui: {
          title: "Show reduced state",
          description: "Inspect the current reducer state",
          category: "View",
          slash: { name: "view.state", aliases: ["state"] },
        },
      })
      .handler(({ context }) => {
        context.setActiveView("state");
      }),
    commands: commandBase
      .meta({
        tui: {
          title: "Show command autocomplete",
          description: "Open slash command suggestions in the input",
          category: "View",
          slash: { name: "view.commands", aliases: ["help", "commands"] },
        },
      })
      .handler(({ context }) => {
        context.prefillInput("/");
      }),
    streams: commandBase
      .meta({
        tui: {
          title: "Show streams",
          description: "Show the most recently loaded stream list",
          category: "View",
          slash: { name: "view.streams", aliases: ["streams-view"] },
          menu: { hidden: true },
        },
      })
      .handler(({ context }) => {
        context.setActiveView("streams");
      }),
  },
  append: {
    message: commandBase
      .input(
        z.object({
          content: z.string().trim().min(1).meta({ positional: true }).describe("Message text"),
          streamPath: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Defaults to the current stream; absolute and dot-relative paths work."),
        }),
      )
      .meta({
        tui: {
          title: "Append message",
          description: "Append an agent-style user message",
          category: "Append",
          slash: { name: "append.message", aliases: ["message", "m"] },
          input: {
            positional: { name: "content", required: true },
            options: [{ name: "streamPath", flag: "--stream" }],
          },
        },
      })
      .handler(async ({ context, input }) => {
        const event: EventInput = {
          type: "events.iterate.com/agent/input-added",
          payload: { role: "user", content: input.content },
        };
        const appended = await context.streamApi.append({ event, streamPath: input.streamPath });
        context.toast.success(`sent offset ${appended.offset}`);
      }),
    debugInfoRequest: commandBase
      .meta({
        tui: {
          title: "Append debug info request",
          description: "Ask the agent processor to append debugging details",
          category: "Append",
          slash: { name: "append.debug", aliases: ["debug"] },
        },
      })
      .handler(async ({ context }) => {
        const appended = await context.streamApi.append({
          event: { type: "debug-info-requested", payload: {} },
        });
        context.toast.success(`sent offset ${appended.offset}`);
      }),
    error: commandBase
      .input(
        z.object({
          message: z.string().trim().min(1).meta({ positional: true }).describe("Error message"),
          streamPath: z.string().trim().min(1).optional(),
        }),
      )
      .meta({
        tui: {
          title: "Append error",
          description: "Append a built-in error event",
          category: "Append",
          slash: { name: "append.error", aliases: ["error"] },
          input: {
            positional: { name: "message", required: true },
            options: [{ name: "streamPath", flag: "--stream" }],
          },
        },
      })
      .handler(async ({ context, input }) => {
        const appended = await context.streamApi.append({
          streamPath: input.streamPath,
          event: {
            type: "https://events.iterate.com/events/stream/error-occurred",
            payload: { message: input.message },
          },
        });
        context.toast.success(`sent offset ${appended.offset}`);
      }),
  },
  stream: {
    open: commandBase
      .input(
        z.object({
          streamPath: z
            .string()
            .trim()
            .min(1)
            .meta({ positional: true })
            .describe("Absolute, dot-relative, or bare child stream path"),
        }),
      )
      .meta({
        tui: {
          title: "Open stream",
          description: "Navigate to another stream",
          category: "Stream",
          slash: { name: "stream.open", aliases: ["open"] },
          input: { positional: { name: "streamPath", required: true } },
        },
      })
      .handler(async ({ context, input }) => {
        const streamPath = context.streamApi.resolvePath(input.streamPath);
        await context.streamApi.getState({ streamPath });
        context.navigateToStream(streamPath);
      }),
    child: commandBase
      .input(
        z.object({
          streamPath: z
            .string()
            .trim()
            .min(1)
            .meta({ positional: true })
            .describe("Child stream path"),
        }),
      )
      .meta({
        tui: {
          title: "Create/open child stream",
          description: "Touch a child stream and navigate to it",
          category: "Stream",
          slash: { name: "stream.child", aliases: ["child"] },
          input: { positional: { name: "streamPath", required: true } },
        },
      })
      .handler(async ({ context, input }) => {
        const streamPath = context.streamApi.resolvePath(input.streamPath);
        await context.streamApi.getState({ streamPath });
        context.navigateToStream(streamPath);
      }),
    reset: commandBase
      .input(
        z.object({
          destroyChildren: z.boolean().default(true).describe("Also destroy child streams"),
          streamPath: z.string().trim().min(1).optional(),
        }),
      )
      .meta({
        tui: {
          title: "Reset stream",
          description: "Destroy this stream's persisted data",
          category: "Stream",
          slash: { name: "stream.reset", aliases: ["reset"] },
          input: {
            options: [{ name: "streamPath", flag: "--stream" }],
            flags: [{ name: "destroyChildren", flag: "--no-children", value: false }],
          },
        },
      })
      .handler(async ({ context, input }) => {
        await context.streamApi.reset({
          streamPath: input.streamPath,
          destroyChildren: input.destroyChildren,
        });
        context.toast.success(
          input.destroyChildren ? "reset stream and children" : "reset stream only",
        );
        context.setActiveView("feed");
        context.restartStream();
      }),
    children: commandBase
      .meta({
        tui: {
          title: "Show children",
          description: "Show streams under the current path",
          category: "Stream",
          slash: { name: "stream.children", aliases: ["children"] },
        },
      })
      .handler(async ({ context }) => {
        const children = await context.streamApi.listChildren({ streamPath: "/" });
        const filter = context.streamPath === "/" ? "" : context.streamPath + "/";
        context.setStreamSummaries(children, filter);
        context.toast.info(`${children.length} stream${children.length === 1 ? "" : "s"}`);
        context.setActiveView("streams");
      }),
  },
  streams: {
    tree: commandBase
      .meta({
        tui: {
          title: "Show stream tree",
          description: "Show all streams as a tree",
          category: "Stream",
          slash: { name: "streams.tree", aliases: ["streams", "tree"] },
        },
      })
      .handler(async ({ context }) => {
        const children = await context.streamApi.listChildren({ streamPath: "/" });
        context.setStreamSummaries(children);
        context.toast.info(`${children.length} stream${children.length === 1 ? "" : "s"}`);
        context.setActiveView("streams");
      }),
  },
  exit: commandBase
    .meta({
      tui: {
        title: "Exit",
        description: "Quit the TUI",
        category: "App",
        slash: { name: "exit", aliases: ["quit"] },
      },
    })
    .handler(({ context }) => {
      context.exit();
    }),
  event: {
    details: commandBase
      .input(
        z.object({
          offset: z
            .string()
            .trim()
            .min(1)
            .meta({ positional: true })
            .describe("Event offset number"),
        }),
      )
      .meta({
        tui: {
          title: "Event details",
          description: "Open the raw event payload inspector",
          category: "Event",
          slash: { name: "event.details", aliases: ["details", "inspect"] },
          input: { positional: { name: "offset", required: true } },
        },
      })
      .handler(({ context, input }) => {
        const offset = Number.parseInt(input.offset, 10);
        if (Number.isNaN(offset)) throw new Error(`Invalid offset: ${input.offset}`);
        context.openEventDetail(offset);
      }),
  },
};

export const commandEntries = collectCommandEntries(commandRouter);

export async function runCommand(args: {
  appContext: AppContext;
  command: CommandEntry;
  inputValue: unknown;
}) {
  await call(args.command.procedure, args.inputValue, {
    context: args.appContext,
    path: args.command.pathSegments,
  });
}

function collectCommandEntries(
  router: Record<string, unknown>,
  prefix: string[] = [],
): CommandEntry[] {
  const entries: CommandEntry[] = [];

  for (const [key, value] of Object.entries(router)) {
    const pathSegments = [...prefix, key];

    if (isProcedure(value)) {
      const path = pathSegments.join(".");
      const meta = readCommandMeta(value);
      if (meta.slash == null) {
        throw new Error(`Command ${path} is missing meta.tui.slash.`);
      }

      entries.push({
        path,
        pathSegments,
        title: meta.title,
        description: meta.description,
        slash: meta.slash,
        menu: meta.menu,
        input: meta.input,
        meta,
        procedure: value,
      });
      continue;
    }

    if (isRecord(value)) {
      entries.push(...collectCommandEntries(value, pathSegments));
    }
  }

  return entries;
}

function readCommandMeta(procedure: CommandProcedure) {
  const meta = procedure["~orpc"].meta as { tui?: TuiCommandMeta };
  if (meta.tui == null) {
    throw new Error("Command procedure is missing meta.tui.");
  }

  return meta.tui;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
