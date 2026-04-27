import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@iterate-com/ui/components/button";
import type { ConfettiBurstMessage } from "~/lib/confetti-websocket.ts";

type ConnectionState = "connecting" | "connected" | "disconnected";

interface RenderedParticle {
  id: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rotation: number;
  spin: number;
  ageMs: number;
  ttlMs: number;
}

export const Route = createFileRoute("/_app/confetti")({
  staticData: {
    breadcrumb: "Confetti",
  },
  component: ConfettiPage,
});

function ConfettiPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const particlesRef = useRef<RenderedParticle[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [lastBurst, setLastBurst] = useState<ConfettiBurstMessage | null>(null);

  const requestBurst = useCallback((origin: { x: number; y: number }) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "burst", origin }));
  }, []);

  const handleCanvasPointerDown = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      requestBurst({
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height,
      });
    },
    [requestBurst],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    let animationFrame = 0;
    let lastFrame = performance.now();

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
      canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    const draw = (now: number) => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const deltaMs = Math.min(32, now - lastFrame);
      lastFrame = now;

      context.clearRect(0, 0, width, height);
      context.fillStyle = "#f8fafc";
      context.fillRect(0, 0, width, height);

      particlesRef.current = particlesRef.current.flatMap((particle) => {
        const ageMs = particle.ageMs + deltaMs;
        if (ageMs >= particle.ttlMs) return [];

        const vy = particle.vy + 0.0009 * deltaMs;
        const x = particle.x + particle.vx * deltaMs;
        const y = particle.y + vy * deltaMs;
        const rotation = particle.rotation + particle.spin * deltaMs;
        const opacity = 1 - ageMs / particle.ttlMs;

        context.save();
        context.globalAlpha = Math.max(0, opacity);
        context.translate(x, y);
        context.rotate(rotation);
        context.fillStyle = particle.color;
        context.fillRect(
          -particle.size / 2,
          -particle.size / 3,
          particle.size,
          particle.size / 1.8,
        );
        context.restore();

        return [{ ...particle, ageMs, x, y, vy, rotation }];
      });

      animationFrame = requestAnimationFrame(draw);
    };

    const socket = new WebSocket(createConfettiWebSocketUrl());
    socketRef.current = socket;
    socket.addEventListener("open", () => setConnectionState("connected"));
    socket.addEventListener("close", () => setConnectionState("disconnected"));
    socket.addEventListener("error", () => setConnectionState("disconnected"));
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;

      const burst = parseConfettiBurst(event.data);
      if (!burst) return;

      setLastBurst(burst);
      particlesRef.current.push(...createRenderedParticles(burst, canvas));
    });

    animationFrame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      socket.close();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">WebSocket Confetti</h2>
          <p className="text-sm text-muted-foreground">
            {connectionState === "connected"
              ? `Connected${lastBurst ? ` · burst ${lastBurst.sequence}` : ""}`
              : connectionState}
          </p>
        </div>
        <Button size="sm" onClick={() => requestBurst({ x: 0.5, y: 0.45 })}>
          Launch burst
        </Button>
      </div>

      <canvas
        ref={canvasRef}
        aria-label="WebSocket confetti canvas"
        className="min-h-[360px] flex-1 rounded-lg border bg-slate-50"
        onPointerDown={handleCanvasPointerDown}
      />
    </div>
  );
}

function createConfettiWebSocketUrl() {
  const url = new URL("/api/confetti", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function createRenderedParticles(
  burst: ConfettiBurstMessage,
  canvas: HTMLCanvasElement,
): RenderedParticle[] {
  const originX = burst.origin.x * canvas.clientWidth;
  const originY = burst.origin.y * canvas.clientHeight;

  return burst.particles.map((particle) => ({
    id: particle.id,
    color: particle.color,
    x: originX,
    y: originY,
    vx: Math.cos(particle.angle) * particle.speed,
    vy: Math.sin(particle.angle) * particle.speed,
    size: particle.size,
    rotation: Math.random() * Math.PI,
    spin: particle.spin,
    ageMs: 0,
    ttlMs: particle.ttlMs,
  }));
}

function parseConfettiBurst(raw: string) {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isConfettiBurstMessage(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isConfettiBurstMessage(value: unknown): value is ConfettiBurstMessage {
  if (!isRecord(value) || value.type !== "burst") return false;
  if (!Array.isArray(value.particles) || !isRecord(value.origin)) return false;
  return typeof value.sequence === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
