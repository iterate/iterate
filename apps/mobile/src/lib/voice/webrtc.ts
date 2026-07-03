// The realtime leg over WebRTC (react-native-webrtc). OpenAI Realtime speaks
// WebRTC natively: POST the SDP offer with the ephemeral client secret, get
// an answer, then audio rides the peer connection (mic upstream, assistant
// downstream — echo cancellation and playback handled natively) and the same
// JSON server events the WS client sees arrive on the `oai-events` data
// channel. The session core stays transport-agnostic; this file is the only
// place that touches native WebRTC APIs.

import { MediaStream, mediaDevices, RTCPeerConnection } from "react-native-webrtc";
import InCallManager from "react-native-incall-manager";
import type { VoiceRealtimeConnection } from "../../../../os/src/types.ts";
import type { ConnectRealtime } from "./session-core.ts";

export function webrtcRealtimeConnector(input: {
  mint: () => Promise<VoiceRealtimeConnection>;
  withMic: boolean;
}): ConnectRealtime {
  return async ({ onEvent, onClose }) => {
    const connection = await input.mint();
    const peer = new RTCPeerConnection({});
    // Keep remote streams referenced — playback is automatic but the tracks
    // must stay alive.
    const remoteStreams: MediaStream[] = [];
    peer.addEventListener("track", (event) => {
      remoteStreams.push(...event.streams);
    });

    let micTrack: { enabled: boolean; stop(): void } | null = null;
    let micWarning: string | undefined;
    if (input.withMic) {
      try {
        // Mobile audio units do echo cancellation / noise suppression at the
        // OS level; plain `audio: true` is the whole ask.
        const stream = await mediaDevices.getUserMedia({ audio: true });
        const track = stream.getAudioTracks()[0];
        if (!track) throw new Error("no audio track");
        micTrack = track;
        peer.addTrack(track, stream);
      } catch (error) {
        micWarning = `microphone unavailable (${error instanceof Error ? error.message : String(error)}) — text input still works`;
      }
    }
    if (!micTrack) {
      // Assistant audio still flows on a receive-only transceiver.
      peer.addTransceiver("audio", { direction: "recvonly" });
    }

    const channel = peer.createDataChannel("oai-events");
    channel.addEventListener("message", (event) => {
      onEvent(JSON.parse(String(event.data)) as Record<string, unknown>);
    });

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      micTrack?.stop();
      peer.close();
      InCallManager.stop();
    };
    const reportClosed = () => {
      const wasClosed = closed;
      close();
      if (!wasClosed) onClose({});
    };
    channel.addEventListener("close", reportClosed);
    peer.addEventListener("connectionstatechange", () => {
      if (["failed", "closed", "disconnected"].includes(peer.connectionState)) reportClosed();
    });

    try {
      const offer = await peer.createOffer({});
      await peer.setLocalDescription(offer);
      const response = await fetch(
        `https://api.openai.com/v1/realtime/calls?model=${encodeURIComponent(connection.model)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${connection.clientSecret}`,
            "Content-Type": "application/sdp",
          },
          body: peer.localDescription?.sdp || String(offer.sdp),
        },
      );
      if (!response.ok) {
        throw new Error(
          `realtime SDP exchange failed (${response.status}): ${await response.text()}`,
        );
      }
      await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
      await waitForChannelOpen(channel);
    } catch (error) {
      close();
      throw error;
    }

    // Route to the loudspeaker (default is the earpiece, like a phone call).
    InCallManager.start({ media: "audio" });
    InCallManager.setForceSpeakerphoneOn(true);

    return {
      send: (event: Record<string, unknown>) => {
        if (channel.readyState === "open") channel.send(JSON.stringify(event));
      },
      close,
      setMicEnabled: (enabled: boolean) => {
        if (micTrack) micTrack.enabled = enabled;
      },
      micLive: micTrack !== null,
      label: `${connection.provider} ${connection.model}`,
      warning: micWarning,
    };
  };
}

type OpenableChannel = {
  readyState: string;
  addEventListener(type: "open" | "error", listener: (event: unknown) => void): void;
};

function waitForChannelOpen(channel: OpenableChannel): Promise<void> {
  if (channel.readyState === "open") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("realtime data channel never opened")),
      15_000,
    );
    channel.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    channel.addEventListener("error", (event) => {
      clearTimeout(timeout);
      reject(new Error(`realtime data channel error: ${String(event)}`));
    });
  });
}
