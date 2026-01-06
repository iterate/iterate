import { execSync } from "node:child_process";
import { createOpencode, type OpencodeClient } from "@opencode-ai/sdk";
import { Context, Effect, Layer, Option, Queue, Ref, Stream } from "effect";
import { SessionManager } from "./session-manager.ts";
import { translateOpenCodeEvent, type TranslatedEvent } from "./event-translator.ts";

export interface OpenCodeConfig {
  baseWorkingDirectory: string;
  port?: number;
  hostname?: string;
}

export class OpenCodeService extends Context.Tag("OpenCodeService")<
  OpenCodeService,
  {
    readonly start: () => Effect.Effect<void, Error>;
    readonly stop: () => Effect.Effect<void, Error>;
    readonly getOrCreateSession: (agentId: string) => Effect.Effect<string, Error>;
    readonly sendPromptAsync: (agentId: string, text: string) => Effect.Effect<void, Error>;
    readonly subscribeToEvents: () => Stream.Stream<TranslatedEvent, Error>;
    readonly autoApprovePermission: (
      sessionId: string,
      permissionId: string,
    ) => Effect.Effect<void, Error>;
    readonly isRunning: () => Effect.Effect<boolean, never>;
  }
>() {}

export const makeOpenCodeService = (config: OpenCodeConfig) =>
  Layer.scoped(
    OpenCodeService,
    Effect.gen(function* () {
      const sessionManager = yield* SessionManager;
      const clientRef = yield* Ref.make<OpencodeClient | null>(null);
      const serverCloseRef = yield* Ref.make<(() => void) | null>(null);
      const eventQueue = yield* Queue.unbounded<TranslatedEvent>();

      const ensureWorkingDirectory = (_agentId: string): string => {
        return config.baseWorkingDirectory;
      };

      const port = config.port ?? 4096;
      const hostname = config.hostname ?? "127.0.0.1";
      const baseUrl = `http://${hostname}:${port}`;

      const forceKillOnPort = (targetPort: number) =>
        Effect.sync(() => {
          try {
            const result = execSync(`lsof -ti :${targetPort}`, { encoding: "utf-8" });
            const pids = result.trim().split("\n").filter(Boolean);
            const myPid = process.pid.toString();
            for (const pid of pids) {
              if (pid === myPid) {
                continue; // Don't kill ourselves
              }
              try {
                execSync(`kill -9 ${pid}`, { stdio: "ignore" });
              } catch {
                // Process might have already exited
              }
            }
          } catch {
            // No processes on port
          }
        });

      const start = () =>
        Effect.gen(function* () {
          const existingClient = yield* Ref.get(clientRef);
          if (existingClient) {
            return;
          }

          yield* Effect.logDebug(`Starting OpenCode server on ${hostname}:${port}`);

          const result = yield* Effect.tryPromise({
            try: async () => {
              const { client, server } = await createOpencode({
                hostname,
                port,
                timeout: 30000,
              });
              return { client, server };
            },
            catch: (error) => new Error(`Failed to start OpenCode server: ${error}`),
          }).pipe(Effect.withSpan("opencode.createServer"));

          yield* Ref.set(clientRef, result.client);
          yield* Ref.set(serverCloseRef, () => result.server.close());

          const events = yield* Effect.tryPromise({
            try: () => result.client.event.subscribe(),
            catch: (error) => new Error(`Failed to subscribe to events: ${error}`),
          });

          yield* Effect.fork(
            Effect.async<void, never>((resume) => {
              void (async () => {
                try {
                  for await (const event of events.stream) {
                    const translated = translateOpenCodeEvent(event);
                    if (translated) {
                      await Effect.runPromise(Queue.offer(eventQueue, translated));
                    }
                  }
                } catch {
                  // Stream closed
                }
                resume(Effect.void);
              })();
            }),
          );

          yield* Effect.logDebug("OpenCode server started and event stream connected");
        }).pipe(Effect.withSpan("opencode.start"));

      const stop = () =>
        Effect.gen(function* () {
          yield* Effect.logDebug("Stopping OpenCode server...");
          const closeServer = yield* Ref.get(serverCloseRef);
          if (closeServer) {
            closeServer();
            yield* Ref.set(serverCloseRef, null);
            // Give graceful shutdown a moment, then force kill
            yield* Effect.sleep("200 millis");
            yield* forceKillOnPort(port);
          }
          yield* Ref.set(clientRef, null);
          yield* Effect.logDebug("OpenCode server stopped");
        }).pipe(Effect.withSpan("opencode.stop"));

      const getClient = Effect.gen(function* () {
        const client = yield* Ref.get(clientRef);
        if (!client) {
          return yield* Effect.fail(new Error("OpenCode server not running"));
        }
        return client;
      });

      const getOrCreateSession = (agentId: string) =>
        Effect.gen(function* () {
          const existingSessionId = yield* Effect.map(
            sessionManager.getSessionId(agentId),
            Option.getOrNull,
          );

          if (existingSessionId) {
            yield* Effect.logDebug(
              `Reusing existing session ${existingSessionId} for agent ${agentId}`,
            );
            return existingSessionId;
          }

          const client = yield* getClient;
          const workingDirectory = ensureWorkingDirectory(agentId);

          yield* Effect.logDebug(`Creating new session for agent ${agentId}`);

          const session = yield* Effect.tryPromise({
            try: async () => {
              const result = await client.session.create({
                body: { title: `Agent: ${agentId}` },
                query: { directory: workingDirectory },
              });
              if (!result.data) {
                throw new Error("Failed to create session");
              }
              return result.data;
            },
            catch: (error) => new Error(`Failed to create OpenCode session: ${error}`),
          });

          yield* sessionManager.createMapping(agentId, session.id, workingDirectory);
          yield* Effect.logDebug(`Created session ${session.id} for agent ${agentId}`);
          return session.id;
        }).pipe(Effect.withSpan("opencode.getOrCreateSession", { attributes: { agentId } }));

      const sendPromptAsync = (agentId: string, text: string) =>
        Effect.gen(function* () {
          yield* getClient;
          const sessionId = yield* getOrCreateSession(agentId);
          const workingDirectory = ensureWorkingDirectory(agentId);

          yield* Effect.logDebug(
            `Sending prompt to session ${sessionId}: "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}"`,
          );

          yield* Effect.tryPromise({
            try: async () => {
              const response = await fetch(
                `${baseUrl}/session/${sessionId}/prompt_async?directory=${encodeURIComponent(workingDirectory)}`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    parts: [{ type: "text", text }],
                  }),
                },
              );
              if (!response.ok) {
                throw new Error(`Failed to send prompt: ${response.status}`);
              }
            },
            catch: (error) => new Error(`Failed to send prompt: ${error}`),
          });

          yield* Effect.logDebug(`Prompt sent successfully to session ${sessionId}`);
        }).pipe(
          Effect.withSpan("opencode.sendPromptAsync", {
            attributes: { agentId, promptLength: text.length },
          }),
        );

      const subscribeToEvents = () =>
        Stream.fromQueue(eventQueue).pipe(Stream.mapError((e) => new Error(String(e))));

      const autoApprovePermission = (sessionId: string, permissionId: string) =>
        Effect.gen(function* () {
          yield* getClient;

          yield* Effect.tryPromise({
            try: async () => {
              // TODO: Future hook point for custom permission handling
              // For now, auto-approve everything via direct HTTP call
              const response = await fetch(
                `${baseUrl}/session/${sessionId}/permissions/${permissionId}`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ response: "allow" }),
                },
              );
              if (!response.ok) {
                throw new Error(`Failed to approve permission: ${response.status}`);
              }
            },
            catch: (error) => new Error(`Failed to approve permission: ${error}`),
          });
        });

      const isRunning = () => Ref.get(clientRef).pipe(Effect.map((client) => client !== null));

      yield* Effect.addFinalizer(() => stop().pipe(Effect.ignore));

      return {
        start,
        stop,
        getOrCreateSession,
        sendPromptAsync,
        subscribeToEvents,
        autoApprovePermission,
        isRunning,
      };
    }),
  );
