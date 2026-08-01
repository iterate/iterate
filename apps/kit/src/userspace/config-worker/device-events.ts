export interface DeviceEvent {
  conversationActive?: boolean;
  result: number;
  schemaVersion: number;
  sequence: number;
  snapshot?: boolean;
  source: "physical" | "remote" | "system" | string;
  type:
    | "conversation.ended"
    | "conversation.started"
    | "pushToTalk.started"
    | "pushToTalk.stopped"
    | string;
}

export interface DeviceEventCapability {
  subscribeToEvents(callback: (event: DeviceEvent) => void): Promise<void>;
}

export interface DeviceEventSessionMetrics {
  acceptedEvents: number;
  lastEvent: Pick<DeviceEvent, "sequence" | "source" | "type"> | null;
  physicalConversationEnds: number;
  physicalConversationStarts: number;
  physicalStarts: number;
  physicalStops: number;
  remoteConversationEnds: number;
  remoteConversationStarts: number;
  remoteStarts: number;
  remoteStops: number;
}

export type DeviceEventSubscriptionDiagnostic =
  | {
      actualSequence: number;
      code: "device-event-sequence-gap";
      expectedSequence: number;
    }
  | { code: "device-event-handler-failed"; event: DeviceEvent }
  | { code: "device-event-missing-conversation-state"; event: DeviceEvent }
  | { code: "device-event-missing-snapshot"; event: DeviceEvent }
  | { code: "unknown-device-event"; event: DeviceEvent };

/**
 * Keeps the physical/remote provenance needed by a retained PTT proof without
 * keeping an event history in the long-lived userspace object.
 *
 * Cloudflare logs remain the detailed event record. These bounded counters are
 * the synchronously queryable view used to prove that a test runner did not
 * substitute a remote RPC for either physical button. A fixed snapshot is
 * preferable to an array because a device may stay connected for months.
 */
export class DeviceEventSessionMetricsTracker {
  #acceptedEvents = 0;
  #lastEvent: DeviceEventSessionMetrics["lastEvent"] = null;
  #physicalConversationEnds = 0;
  #physicalConversationStarts = 0;
  #physicalStarts = 0;
  #physicalStops = 0;
  #remoteConversationEnds = 0;
  #remoteConversationStarts = 0;
  #remoteStarts = 0;
  #remoteStops = 0;

  observe(event: DeviceEvent): void {
    this.#acceptedEvents += 1;
    this.#lastEvent = {
      sequence: event.sequence,
      source: event.source,
      type: event.type,
    };
    if (event.source === "physical" && event.type === "pushToTalk.started") {
      this.#physicalStarts += 1;
    } else if (event.source === "physical" && event.type === "pushToTalk.stopped") {
      this.#physicalStops += 1;
    } else if (event.source === "remote" && event.type === "pushToTalk.started") {
      this.#remoteStarts += 1;
    } else if (event.source === "remote" && event.type === "pushToTalk.stopped") {
      this.#remoteStops += 1;
    } else if (event.source === "physical" && event.type === "conversation.started") {
      this.#physicalConversationStarts += 1;
    } else if (event.source === "physical" && event.type === "conversation.ended") {
      this.#physicalConversationEnds += 1;
    } else if (event.source === "remote" && event.type === "conversation.started") {
      this.#remoteConversationStarts += 1;
    } else if (event.source === "remote" && event.type === "conversation.ended") {
      this.#remoteConversationEnds += 1;
    }
  }

  metrics(): DeviceEventSessionMetrics {
    return {
      acceptedEvents: this.#acceptedEvents,
      lastEvent: this.#lastEvent === null ? null : { ...this.#lastEvent },
      physicalConversationEnds: this.#physicalConversationEnds,
      physicalConversationStarts: this.#physicalConversationStarts,
      physicalStarts: this.#physicalStarts,
      physicalStops: this.#physicalStops,
      remoteConversationEnds: this.#remoteConversationEnds,
      remoteConversationStarts: this.#remoteConversationStarts,
      remoteStarts: this.#remoteStarts,
      remoteStops: this.#remoteStops,
    };
  }
}

interface PushToTalkBridge {
  inputStarted(): boolean;
  inputStopped(): boolean;
  setConversationActive(active: boolean): boolean;
}

/**
 * Subscribes the server-side PCM generation to the device's one ordered event
 * source. The initial snapshot establishes both independent state machines:
 * call lifetime and held/released PTT. A released snapshot never commits a
 * turn: doing so would ask Grok to answer an empty input every time either
 * WebSocket reconnects.
 *
 * A sequence gap is rejected rather than guessed through. Losing either edge
 * can invert the meaning of every later microphone frame, so continuing would
 * be worse than forcing the surrounding session manager to resubscribe and
 * obtain another snapshot.
 */
export async function subscribePcmBridgeToDeviceEvents(
  device: DeviceEventCapability,
  bridge: PushToTalkBridge,
  onDiagnostic: (diagnostic: DeviceEventSubscriptionDiagnostic) => void = () => undefined,
  onAcceptedEvent: (event: DeviceEvent) => void = () => undefined,
): Promise<void> {
  let lastSequence: number | undefined;
  let pressed = false;
  let synchronized = false;

  await device.subscribeToEvents((event) => {
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence < 0 ||
      !Number.isSafeInteger(event.schemaVersion) ||
      event.schemaVersion !== 1
    ) {
      onDiagnostic({ code: "unknown-device-event", event });
      return;
    }

    if (!synchronized) {
      if (event.snapshot !== true) {
        onDiagnostic({ code: "device-event-missing-snapshot", event });
        return;
      }
      if (typeof event.conversationActive !== "boolean") {
        onDiagnostic({ code: "device-event-missing-conversation-state", event });
        return;
      }
      synchronized = true;
      lastSequence = event.sequence;
    } else {
      const expectedSequence = lastSequence! + 1;
      if (event.sequence !== expectedSequence) {
        synchronized = false;
        onDiagnostic({
          actualSequence: event.sequence,
          code: "device-event-sequence-gap",
          expectedSequence,
        });
        return;
      }
      lastSequence = event.sequence;
    }

    if (event.result !== 0) {
      onDiagnostic({ code: "device-event-handler-failed", event });
      return;
    }
    if (event.snapshot === true) {
      /*
       * `/pcm` is already warm when userspace subscribes. Restoring call state
       * here lets a replacement Durable Object recreate only the disposable
       * provider and avoids another device TLS handshake. This transition is
       * intentionally separate from the PTT snapshot below: a call may be
       * active while the microphone is released.
       */
      bridge.setConversationActive(event.conversationActive!);
    }
    if (event.type === "conversation.started" || event.type === "conversation.ended") {
      const conversationActive = event.type === "conversation.started";
      if (event.conversationActive !== conversationActive) {
        onDiagnostic({ code: "device-event-missing-conversation-state", event });
        return;
      }
      /*
       * The top button owns one disposable provider conversation over the
       * already-open PCM lane. It must never impersonate a front-button speech
       * edge: switching call lifetime cannot capture or commit microphone
       * audio. Idempotence also absorbs a snapshot followed by a repeated
       * state observation without greeting twice.
       */
      bridge.setConversationActive(conversationActive);
      onAcceptedEvent(event);
      return;
    }
    if (event.type === "pushToTalk.started") {
      onAcceptedEvent(event);
      if (!pressed) bridge.inputStarted();
      pressed = true;
      return;
    }
    if (event.type === "pushToTalk.stopped") {
      onAcceptedEvent(event);
      /*
       * This condition includes the initial released snapshot and repeated
       * release observations. Neither contains a turn to commit.
       */
      if (pressed && event.snapshot !== true) bridge.inputStopped();
      pressed = false;
      return;
    }
    onDiagnostic({ code: "unknown-device-event", event });
  });
}
