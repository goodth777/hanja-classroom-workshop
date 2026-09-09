import type { AddressInfo } from "node:net";
import type { GameCountdownPayload } from "@hanja/contracts";
import { io as createClient, type Socket } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import type { Ack, ClientToServerEvents, ServerToClientEvents } from "@hanja/contracts";
import { createHanjaServer } from "./app.js";
import { MemoryResultStore } from "./result-store.js";
import { RoomManager } from "./room-manager.js";
import { type TeacherAuthVerifier } from "./teacher-auth.js";
import { MemoryTeacherPreferencesStore } from "./teacher-preferences.js";

type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

describe("synchronized game intro", () => {
  const sockets: ClientSocket[] = [];
  let closeServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    await closeServer?.();
    closeServer = undefined;
  });

  it("shares one absolute intro schedule with current and late-joining clients", async () => {
    const manager = new RoomManager({
      resultStore: new MemoryResultStore(),
      roomCodeNumber: () => 654321,
      randomIndex: () => 0,
    });
    const teacherAuthVerifier: TeacherAuthVerifier = {
      async verify() {
        return { id: "teacher-1", email: "teacher@example.com" };
      },
    };
    const server = createHanjaServer({
      manager,
      teacherAuthVerifier,
      teacherPreferencesStore: new MemoryTeacherPreferencesStore(),
      startCountdownMs: 80,
      gameIntroMs: 120,
    });
    await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = server.httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    closeServer = async () => {
      await new Promise<void>((resolve) => server.io.close(() => resolve()));
      if (server.httpServer.listening) {
        await new Promise<void>((resolve, reject) => server.httpServer.close((error) => error ? reject(error) : resolve()));
      }
    };

    const connect = async (accessToken?: string) => {
      const socket: ClientSocket = createClient(baseUrl, {
        transports: ["websocket"],
        forceNew: true,
        auth: accessToken ? { accessToken } : undefined,
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
      });
      return socket;
    };
    const emitAck = <T>(emit: (ack: (result: Ack<T>) => void) => void) => new Promise<Ack<T>>((resolve) => emit(resolve));
    const nextCountdown = (socket: ClientSocket) => new Promise<GameCountdownPayload>((resolve) => socket.once("game:countdown", resolve));

    const host = await connect("teacher-token");
    const created = await emitAck((ack) => host.emit("host:create-room", { character: "木" }, ack));
    expect(created.ok).toBe(true);
    const firstPlayer = await connect();
    const beforeSync = Date.now();
    const clock = await new Promise<{ serverNow: number }>((resolve) => firstPlayer.emit("clock:sync", resolve));
    expect(clock.serverNow).toBeGreaterThanOrEqual(beforeSync);
    expect(clock.serverNow).toBeLessThanOrEqual(Date.now());
    await emitAck((ack) => firstPlayer.emit("player:join", { roomCode: "654321", nickname: "먼저" }, ack));

    const hostCountdown = nextCountdown(host);
    const firstPlayerCountdown = nextCountdown(firstPlayer);
    const started = new Promise<void>((resolve) => host.once("game:started", () => resolve()));
    await emitAck((ack) => host.emit("host:start-game", { roomCode: "654321" }, ack));
    const [hostSchedule, firstSchedule] = await Promise.all([hostCountdown, firstPlayerCountdown]);

    expect(firstSchedule).toEqual(hostSchedule);
    expect(hostSchedule.introEndsAt - hostSchedule.introStartedAt).toBe(120);
    expect(hostSchedule.startsAt - hostSchedule.introEndsAt).toBe(1_580);

    const latePlayer = await connect();
    const lateCountdown = nextCountdown(latePlayer);
    await emitAck((ack) => latePlayer.emit("player:join", { roomCode: "654321", nickname: "늦게" }, ack));
    await expect(lateCountdown).resolves.toEqual(hostSchedule);
    await expect(started).resolves.toBeUndefined();
    expect(manager.getSnapshot("654321").status).toBe("in_progress");
  });
});
