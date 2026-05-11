import type { WebSocketHooks } from "nitro/h3";

const confettiColors = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6"];

export interface ConfettiBurstMessage {
  type: "burst";
  id: string;
  sequence: number;
  serverTime: string;
  origin: {
    x: number;
    y: number;
  };
  particles: {
    id: string;
    color: string;
    angle: number;
    speed: number;
    size: number;
    spin: number;
    ttlMs: number;
  }[];
}

interface ConfettiPeer {
  send(value: string): void;
}

let globalSequence = 0;

export function createConfettiWebSocketHooks(): Partial<WebSocketHooks> {
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    open(peer) {
      const confettiPeer = createConfettiPeer(peer);
      sendBurst(confettiPeer, { x: 0.5, y: 0.45 });
      timer = setInterval(() => {
        sendBurst(confettiPeer, randomOrigin());
      }, 2_400);
    },
    message(peer, message) {
      const origin = parseRequestedOrigin(readMessageText(message)) ?? randomOrigin();
      sendBurst(createConfettiPeer(peer), origin);
    },
    close() {
      if (timer) clearInterval(timer);
    },
    error() {
      if (timer) clearInterval(timer);
    },
  };
}

function createConfettiPeer(peer: { send(value: string): void }): ConfettiPeer {
  return {
    send(value: string) {
      peer.send(value);
    },
  };
}

function sendBurst(peer: ConfettiPeer, origin: { x: number; y: number }) {
  const sequence = ++globalSequence;
  const burst: ConfettiBurstMessage = {
    type: "burst",
    id: `burst-${sequence}`,
    sequence,
    serverTime: new Date().toISOString(),
    origin,
    particles: Array.from({ length: 34 }, (_, index) => createParticle(sequence, index)),
  };

  peer.send(JSON.stringify(burst));
}

function createParticle(
  sequence: number,
  index: number,
): ConfettiBurstMessage["particles"][number] {
  const angle = Math.PI + Math.random() * Math.PI;

  return {
    id: `particle-${sequence}-${index}`,
    color: confettiColors[Math.floor(Math.random() * confettiColors.length)]!,
    angle,
    speed: randomBetween(0.18, 0.62),
    size: randomBetween(5, 11),
    spin: randomBetween(-0.018, 0.018),
    ttlMs: randomBetween(1_200, 1_900),
  };
}

function readMessageText(message: { text?: () => string } | string) {
  if (typeof message === "string") return message;
  if (typeof message.text === "function") return message.text();
  return undefined;
}

function parseRequestedOrigin(text: string | undefined) {
  if (!text) return undefined;

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || parsed.type !== "burst" || !isRecord(parsed.origin)) {
      return undefined;
    }

    const x = typeof parsed.origin.x === "number" ? parsed.origin.x : undefined;
    const y = typeof parsed.origin.y === "number" ? parsed.origin.y : undefined;
    if (x === undefined || y === undefined) return undefined;

    return {
      x: clamp(x, 0.05, 0.95),
      y: clamp(y, 0.1, 0.8),
    };
  } catch {
    return undefined;
  }
}

function randomOrigin() {
  return {
    x: randomBetween(0.2, 0.8),
    y: randomBetween(0.25, 0.55),
  };
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
