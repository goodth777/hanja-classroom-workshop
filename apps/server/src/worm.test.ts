import { describe, expect, it } from "vitest";
import { RoomManager } from "./room-manager.js";
import { MemoryResultStore } from "./result-store.js";

describe("independent Hanja worm", () => {
  it("ends on three collisions and preserves collision state on reconnect", async () => {
    let now = 10000;
    const store = new MemoryResultStore();
    const manager = new RoomManager({ resultStore: store, now: () => now, roomCodeNumber: () => 123456 });
    manager.createRoom("host", ["木"], "teacher-1", undefined, "hanja_worm");
    const a = manager.joinRoom("a", "123456", "가람");
    manager.joinRoom("b", "123456", "나래");
    manager.startGame("host", "123456");
    expect(() => manager.hitWorm("intruder", "123456", 1)).toThrow();
    expect(() => manager.hitWorm("a", "123456", 3)).toThrow();
    expect(manager.hitWorm("a", "123456", 1).snapshot.worm?.hits).toBe(1);
    expect(manager.hitWorm("a", "123456", 1).snapshot.worm?.hits).toBe(1);
    expect(() => manager.hitWorm("a", "123456", 2)).toThrow();
    manager.disconnect("a");
    expect(manager.joinRoom("a2", "123456", "가람", a.reconnectToken).snapshot.worm?.hits).toBe(1);
    now += 1800; manager.hitWorm("a2", "123456", 2);
    now += 1800;
    const end = manager.hitWorm("a2", "123456", 3);
    expect(end.snapshot.worm).toMatchObject({ hits: 3, eliminated: true, finished: true });
    expect(end.snapshot.status).toBe("in_progress");
    expect(manager.hitWorm("a2", "123456", 3).snapshot.worm?.hits).toBe(3);
    expect(() => manager.reachWormTarget("a2", "123456", 0, 0, end.snapshot.character.strokeData[0]!.startPoint)).toThrow();
    for (let n = 0; n < 8; n++) {
      const s = manager.getSnapshotForSocket("123456", "b"), stroke = s.character.strokeData[Math.floor(n / 2)]!;
      manager.reachWormTarget("b", "123456", 0, n, n % 2 ? stroke.endPoint : stroke.startPoint);
    }
    expect(manager.getSnapshot("123456").status).toBe("finished");
    expect(store.results).toHaveLength(1);
    const history = await manager.getHistory("teacher-1", "hanja_worm", 0);
    expect(history.leaderboard.map(p => [p.nickname, p.average])).toEqual([["나래", 40], ["가람", 0]]);
  });
  it("validates targets, preserves reconnects, advances characters and finishes all students once", () => {
    const manager = new RoomManager({ resultStore: new MemoryResultStore(), roomCodeNumber: () => 123456 });
    const room = manager.createRoom("host", ["木", "人"], undefined, undefined, "hanja_worm");
    expect(room.qrUrl).toContain("/join/123456");
    const joined = manager.joinRoom("a", "123456", "가람");
    manager.joinRoom("b", "123456", "나래");
    manager.startGame("host", "123456");
    expect(manager.getSnapshot("123456").selectedPlayerId).toBeNull();
    expect(() => manager.reachWormTarget("a", "123456", 0, 1, { x: 0.5, y: 0.5 })).toThrow();
    expect(() => manager.reachWormTarget("a", "123456", 0, 0, { x: NaN, y: 1 })).toThrow();
    expect(() => manager.reachWormTarget("intruder", "123456", 0, 0, { x: 0.5, y: 0.5 })).toThrow();
    for (const id of ["a", "b"]) {
      for (let n = 0; n < 12; n++) {
        const snapshot = manager.getSnapshotForSocket("123456", id);
        const p = snapshot.worm!;
        const stroke = snapshot.character.strokeData[Math.floor(p.targetIndex / 2)]!;
        const point = p.targetIndex % 2 ? stroke.endPoint : stroke.startPoint;
        const outcome = manager.reachWormTarget(id, "123456", p.characterIndex, p.targetIndex, point);
        const duplicate = manager.reachWormTarget(id, "123456", p.characterIndex, p.targetIndex, point);
        expect(duplicate.snapshot.players).toEqual(outcome.snapshot.players);
        if (n === 0 && id === "a") {
          manager.disconnect("a");
          const reconnect = manager.joinRoom("a", "123456", "가람", joined.reconnectToken);
          expect(reconnect.snapshot.worm?.targetIndex).toBe(1);
        }
        if (n === 11 && id === "a") expect(outcome.snapshot.status).toBe("in_progress");
        if (n === 11 && id === "b") expect(outcome.rankedPlayers).toHaveLength(2);
      }
    }
    expect(manager.getSnapshot("123456").status).toBe("finished");
    expect(manager.getSnapshot("123456").players.map((p) => p.score)).toEqual([60, 60]);
  });
});
