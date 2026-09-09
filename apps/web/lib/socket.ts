import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@hanja/contracts";
import { createServerClock } from "./server-clock";

export type HanjaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
const clocks = new WeakMap<HanjaSocket, ReturnType<typeof createServerClock>>();

export function serverNow(socket: HanjaSocket | null): number {
  return (socket && clocks.get(socket)?.now()) || Date.now();
}

const DEFAULT_SERVER_URL =
  process.env.NODE_ENV === "production"
    ? "https://server-not-configured.invalid"
    : "http://localhost:4000";

export const SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL ?? DEFAULT_SERVER_URL;

export function createSocket(accessToken?: string): HanjaSocket {
  const socket: HanjaSocket = io(SERVER_URL, {
    autoConnect: false,
    // Establish through school/proxy-friendly HTTP first, then upgrade without delaying admission.
    transports: ["polling", "websocket"],
    upgrade: true,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3_000,
    randomizationFactor: 0.5,
    timeout: 15_000,
    auth: accessToken ? { accessToken } : undefined,
  });
  const clock = createServerClock();
  clocks.set(socket, clock);
  let generation = 0;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  const synchronize = (resetSamples = false, samples = 3) => {
    const currentGeneration = ++generation;
    if (resetSamples) clock.resetSamples();
    const ping = (remaining: number) => {
      if (!socket.connected || currentGeneration !== generation) return;
      const sentAt = performance.now();
      socket.timeout(3000).emit("clock:sync", (error, response) => {
        if (!socket.connected || currentGeneration !== generation) return;
        if (!error && response) clock.sample(response.serverNow, sentAt, performance.now());
        if (remaining > 1) window.setTimeout(() => ping(remaining - 1), 250);
      });
    };
    // Three tiny ACKs at entry/start, not a per-frame or per-student broadcast.
    ping(samples);
  };
  const onVisible = () => { if (!document.hidden && socket.connected) synchronize(true); };
  socket.on("connect", () => {
    synchronize(true);
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!document.hidden) synchronize(true, 1); }, 30_000);
    document.addEventListener("visibilitychange", onVisible);
  });
  socket.on("game:countdown", () => synchronize());
  socket.on("disconnect", () => { generation += 1; clearInterval(refreshTimer); document.removeEventListener("visibilitychange", onVisible); });
  return socket;
}
