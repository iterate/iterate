import { z } from "zod";
import {
  DEFAULT_KIT_DEVICE_ID,
  KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
  kitDeviceEventStreamPath,
} from "../userspace/config-worker/provider-event-stream.ts";

const StreamEventEnvelope = z.object({
  createdAt: z.string(),
  offset: z.number().int().nonnegative().safe(),
  path: z.string(),
  payload: z.unknown().optional(),
  type: z.string(),
});

const ProviderEventPayload = z.strictObject({
  providerType: z.string().nullable(),
  raw: z.string(),
  receivedAtMs: z.number().int().nonnegative().safe(),
  sequence: z.number().int().positive().safe(),
  sessionId: z.string().min(1),
});

const CompletedOutputAudioTranscript = z.object({
  transcript: z.string(),
  type: z.literal("response.output_audio_transcript.done"),
});

const CompletedInputAudioTranscript = z.object({
  status: z.literal("completed"),
  transcript: z.string(),
  type: z.literal("conversation.item.input_audio_transcription.completed"),
});

const ProviderFunctionCallDone = z.object({
  arguments: z.string(),
  call_id: z.string().min(1),
  name: z.string().min(1),
  type: z.literal("response.function_call_arguments.done"),
});

const ProviderFunctionCallOutputAdded = z.object({
  item: z.object({
    call_id: z.string().min(1),
    output: z.string(),
    type: z.literal("function_call_output"),
  }),
  type: z.literal("conversation.item.added"),
});

export interface ProductionGrokProviderEvent {
  createdAt: string;
  offset: number;
  providerType: string | null;
  raw: string;
  receivedAtMs: number;
  sequence: number;
  sessionId: string;
}

/**
 * Selects and validates every available frame for one device/session without
 * requiring sequence continuity. Failure capture uses this path because a
 * missing prefix or middle frame is evidence to retain, not a reason to throw
 * the remaining raw provider observations away.
 */
export function parseAvailableProductionGrokProviderEvents(
  value: unknown,
  sessionId: string,
  deviceId = DEFAULT_KIT_DEVICE_ID,
): ProductionGrokProviderEvent[] {
  const envelopes = z.array(StreamEventEnvelope).parse(value);
  const streamPath = kitDeviceEventStreamPath(deviceId);
  return (
    envelopes
      /*
       * Path is the ownership boundary; session id is only a generation key
       * inside that boundary. Filter before parsing payloads so corrupt or
       * schema-incompatible evidence from another board cannot invalidate the
       * selected device's otherwise complete physical run.
       */
      .filter(
        (event) => event.path === streamPath && event.type === KIT_PROVIDER_EVENT_STREAM_EVENT_TYPE,
      )
      .map((event) => ({
        ...ProviderEventPayload.parse(event.payload),
        createdAt: event.createdAt,
        offset: event.offset,
      }))
      .filter((event) => event.sessionId === sessionId)
      .sort((left, right) => left.sequence - right.sequence)
  );
}

/**
 * Validates the normal Iterate stream boundary and selects one exact provider
 * generation. Sequence continuity is part of the evidence: a transcript that
 * silently lost the error frame between two healthy frames would be worse than
 * no transcript because it could falsely exonerate the upstream connection.
 */
export function parseProductionGrokProviderEvents(
  value: unknown,
  sessionId: string,
  deviceId = DEFAULT_KIT_DEVICE_ID,
  expectedFirstSequence = 1,
): ProductionGrokProviderEvent[] {
  if (!Number.isSafeInteger(expectedFirstSequence) || expectedFirstSequence < 1) {
    throw new Error("The expected first Grok provider sequence must be a positive integer.");
  }
  const selected = parseAvailableProductionGrokProviderEvents(value, sessionId, deviceId);

  for (const [index, event] of selected.entries()) {
    /*
     * A warm device `/pcm` generation can host several disposable Grok calls.
     * The provider journal belongs to that long-lived generation, so a proof
     * which deliberately reads only the suffix after its quiescent stream
     * baseline must continue at the baseline's next sequence rather than
     * pretending the second provider connection is a new PCM session. The
     * explicit caller-supplied start keeps a lost prefix detectable; every
     * middle event remains strictly contiguous below.
     */
    const expectedSequence = expectedFirstSequence + index;
    if (event.sequence !== expectedSequence) {
      throw new Error(
        `Grok provider stream sequence was ${event.sequence}; expected ${expectedSequence}.`,
      );
    }
  }
  return selected;
}

/**
 * Reads Grok's final spoken words from the retained raw provider frame.
 *
 * The production acoustic proof deliberately does not use the requested
 * prompt as its expectation: a model can paraphrase, invoke a tool first, or
 * fail in a way that changes what it actually emitted. The raw, ordered stream
 * is the only honest source for the sentence that should have crossed the
 * physical speaker/air/microphone path.
 */
export function completedProviderOutputTranscript(
  events: readonly ProductionGrokProviderEvent[],
): string {
  const event = events.findLast(
    (candidate) => candidate.providerType === "response.output_audio_transcript.done",
  );
  if (!event) {
    throw new Error("The Grok stream did not retain a completed output-audio transcript.");
  }
  let value: unknown;
  try {
    value = JSON.parse(event.raw);
  } catch (error) {
    throw new Error("The completed output-audio transcript was not valid JSON.", {
      cause: error,
    });
  }
  const parsed = CompletedOutputAudioTranscript.parse(value);
  const transcript = parsed.transcript.trim();
  if (!transcript) {
    throw new Error("The completed output-audio event contained no non-empty transcript.");
  }
  return transcript;
}

/** Reads the final recognizer result for one retained physical input turn. */
export function completedProviderInputTranscript(
  events: readonly ProductionGrokProviderEvent[],
): string {
  const event = events.findLast((candidate) => {
    if (candidate.providerType !== "conversation.item.input_audio_transcription.completed") {
      return false;
    }
    try {
      return CompletedInputAudioTranscript.safeParse(JSON.parse(candidate.raw)).success;
    } catch {
      return false;
    }
  });
  if (!event) {
    throw new Error("The Grok stream did not retain a terminal input-audio transcript.");
  }
  const parsed = CompletedInputAudioTranscript.parse(JSON.parse(event.raw));
  const transcript = parsed.transcript.trim();
  if (!transcript) {
    throw new Error("The terminal input-audio transcript contained no non-empty text.");
  }
  return transcript;
}

export interface CompletedProviderToolCall {
  arguments: unknown;
  callId: string;
  output: unknown;
}

/** Correlates Grok's requested tool call with its retained device result. */
export function completedProviderToolCall(
  events: readonly ProductionGrokProviderEvent[],
  name: string,
): CompletedProviderToolCall {
  const callEvent = events.findLast((candidate) => {
    if (candidate.providerType !== "response.function_call_arguments.done") return false;
    try {
      return ProviderFunctionCallDone.parse(JSON.parse(candidate.raw)).name === name;
    } catch {
      return false;
    }
  });
  if (!callEvent) throw new Error(`The Grok stream retained no completed ${name} tool call.`);
  const call = ProviderFunctionCallDone.parse(JSON.parse(callEvent.raw));
  const outputEvent = events.find((candidate) => {
    if (candidate.providerType !== "conversation.item.added") return false;
    try {
      const output = ProviderFunctionCallOutputAdded.parse(JSON.parse(candidate.raw));
      return output.item.call_id === call.call_id;
    } catch {
      return false;
    }
  });
  if (!outputEvent) {
    throw new Error(`The Grok stream retained no device result for ${name} call ${call.call_id}.`);
  }
  const output = ProviderFunctionCallOutputAdded.parse(JSON.parse(outputEvent.raw));
  try {
    return {
      arguments: JSON.parse(call.arguments),
      callId: call.call_id,
      output: JSON.parse(output.item.output),
    };
  } catch (error) {
    throw new Error(`The ${name} tool arguments or device result were not valid JSON.`, {
      cause: error,
    });
  }
}
