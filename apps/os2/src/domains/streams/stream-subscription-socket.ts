import {
  StreamSocketAckFrame,
  StreamSocketAppendErrorFrame,
  StreamSocketAppendFrame,
  StreamSocketAppendResultFrame,
} from "@iterate-com/shared/streams/stream-socket-types";
import type { Event, EventInput, StreamPath } from "@iterate-com/shared/streams/types";

type PendingAppend = {
  reject(error: Error): void;
  resolve(event: Event): void;
};

type ActiveStreamSocket = {
  pendingAppends: Map<string, PendingAppend>;
  socket: WebSocket;
};

const activeSockets = new Map<string, ActiveStreamSocket>();

export function streamSubscriptionSocketKey(input: { projectId: string; streamPath: StreamPath }) {
  return JSON.stringify([input.projectId, input.streamPath]);
}

export function activateStreamSubscriptionSocket(input: {
  key: string;
  socket: WebSocket;
}): () => void {
  const active: ActiveStreamSocket = {
    pendingAppends: new Map(),
    socket: input.socket,
  };
  activeSockets.set(input.key, active);

  return () => {
    if (activeSockets.get(input.key) !== active) return;
    activeSockets.delete(input.key);
    for (const pending of active.pendingAppends.values()) {
      pending.reject(new Error("Stream subscription socket closed before append completed."));
    }
    active.pendingAppends.clear();
  };
}

export async function appendThroughStreamSubscriptionSocket(input: {
  event: EventInput;
  key: string;
}): Promise<Event | null> {
  const active = activeSockets.get(input.key);
  if (active == null || active.socket.readyState !== WebSocket.OPEN) {
    return null;
  }

  const requestId = crypto.randomUUID();
  const response = new Promise<Event>((resolve, reject) => {
    active.pendingAppends.set(requestId, { reject, resolve });
  });

  try {
    active.socket.send(
      JSON.stringify(
        StreamSocketAppendFrame.parse({
          type: "append",
          requestId,
          event: input.event,
        }),
      ),
    );
  } catch (error) {
    active.pendingAppends.delete(requestId);
    throw error;
  }

  return await response;
}

export function handleStreamSubscriptionAppendResponse(input: {
  frame: unknown;
  key: string;
}): boolean {
  const result = StreamSocketAppendResultFrame.safeParse(input.frame);
  if (result.success) {
    const pending = activeSockets.get(input.key)?.pendingAppends.get(result.data.requestId);
    if (pending == null) return true;
    activeSockets.get(input.key)?.pendingAppends.delete(result.data.requestId);
    pending.resolve(result.data.event);
    return true;
  }

  const error = StreamSocketAppendErrorFrame.safeParse(input.frame);
  if (error.success) {
    const pending = activeSockets.get(input.key)?.pendingAppends.get(error.data.requestId);
    if (pending == null) return true;
    activeSockets.get(input.key)?.pendingAppends.delete(error.data.requestId);
    pending.reject(new Error(error.data.message));
    return true;
  }

  return false;
}

export function ackStreamSubscriptionSocket(input: { offset: number; socket: WebSocket }) {
  input.socket.send(
    JSON.stringify(
      StreamSocketAckFrame.parse({
        type: "ack",
        offset: input.offset,
      }),
    ),
  );
}
