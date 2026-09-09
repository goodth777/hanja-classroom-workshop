import { describe, expect, it, vi } from "vitest";
import {
  bearerToken,
  createTeacherAuthVerifier,
  DemoTeacherAuthVerifier,
  TeacherAuthError,
} from "./teacher-auth.js";
import {
  FailoverTeacherPreferencesStore,
  MemoryTeacherPreferencesStore,
  SupabaseTeacherPreferencesStore,
  resolveTeacherCharacters,
  type TeacherPreferencesStore,
} from "./teacher-preferences.js";

describe("teacher authentication", () => {
  it("parses bearer tokens and rejects malformed headers", () => {
    expect(bearerToken("Bearer teacher-token")).toBe("teacher-token");
    expect(bearerToken("bearer   spaced-token")).toBe("spaced-token");
    expect(bearerToken("Basic value")).toBeUndefined();
  });

  it("allows the demo token only outside production", async () => {
    const verifier = createTeacherAuthVerifier({
      TEACHER_AUTH_MODE: "demo",
      NODE_ENV: "development",
    });
    expect(verifier).toBeInstanceOf(DemoTeacherAuthVerifier);
    await expect(verifier.verify("demo-teacher-token")).resolves.toMatchObject({
      email: "demo-teacher@local.test",
    });
    await expect(verifier.verify("wrong-token")).rejects.toBeInstanceOf(TeacherAuthError);

    const productionVerifier = createTeacherAuthVerifier({
      TEACHER_AUTH_MODE: "demo",
      NODE_ENV: "production",
    });
    await expect(productionVerifier.verify("demo-teacher-token")).rejects.toBeInstanceOf(
      TeacherAuthError,
    );
  });
});

describe("teacher character preferences", () => {
  it("keeps approvals and ordering isolated by teacher", async () => {
    const store = new MemoryTeacherPreferencesStore();
    const approval = {
      char: "龍",
      label: "용(용 용) · 16획",
      approvedAt: "2026-06-29T00:00:00.000Z",
    };

    const first = await store.approve("teacher-a", approval);
    expect(first.orderedChars).toContain("龍");
    expect((await store.get("teacher-b")).orderedChars).not.toContain("龍");

    await store.saveOrder("teacher-a", ["龍", "木"]);
    const resolved = resolveTeacherCharacters(await store.get("teacher-a"));
    expect(resolved.characters.map(({ char }) => char)).toEqual(["龍", "木"]);
    expect(resolved.characters[0]?.label).toBe(approval.label);

    const folder = {
      id: "grade-3",
      name: "3학년",
      orderedChars: ["木"],
    };
    await store.saveFolders("teacher-a", [folder, {
      id: "unit-2",
      name: "2단원",
      orderedChars: ["龍"],
    }], "unit-2");
    const folderResolved = resolveTeacherCharacters(await store.get("teacher-a"));
    expect(folderResolved.preferences.activeFolderId).toBe("unit-2");
    expect(folderResolved.characters.map(({ char }) => char)).toEqual(["龍"]);
    expect((await store.get("teacher-b")).folders).toHaveLength(1);

    const quizPools = [{
      id: "lesson-one",
      name: "1단원",
      items: [{ char: "不", meaning: "아니다", reading: "부" }],
    }];
    await store.saveQuizPools("teacher-a", quizPools);
    expect((await store.get("teacher-a")).quizPools).toEqual(quizPools);
    expect((await store.get("teacher-b")).quizPools).toEqual([]);
  });
  it("uses 기본 한자 as the default folder and preserves folders on legacy Supabase schemas", async () => {
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push(body);
        return new Response(null, { status: 201 });
      }
      if (url.includes("folders")) {
        return new Response(JSON.stringify({ message: "column folders does not exist" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json([{ ordered_chars: ["木"], approved_characters: {} }]);
    });

    try {
      const store = new SupabaseTeacherPreferencesStore("https://supabase.local", "service-key");
      const current = await store.get("teacher-a");
      expect(current.folders).toEqual([{ id: "default", name: "기본 한자", orderedChars: ["木"] }]);

      await store.saveFolders("teacher-a", [
        { id: "default", name: "기본 한자", orderedChars: ["木"] },
        { id: "unit-1", name: "1단원", orderedChars: ["木"] },
      ], "unit-1");

      expect(writes).toHaveLength(1);
      expect(writes[0]).not.toHaveProperty("folders");
      expect(writes[0]).not.toHaveProperty("active_folder_id");
      expect(writes[0]?.approved_characters).toMatchObject({
        __hanja_folders: {
          activeFolderId: "unit-1",
          folders: expect.arrayContaining([
            expect.objectContaining({ id: "unit-1", name: "1단원" }),
          ]),
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("falls back to legacy folder snapshots when Supabase folder-column writes fail", async () => {
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push(body);
        return writes.length === 1
          ? new Response(JSON.stringify({ message: "transient write failure" }), {
              status: 500,
              headers: { "content-type": "application/json" },
            })
          : new Response(null, { status: 201 });
      }
      return Response.json([{ ordered_chars: ["\u6728"], approved_characters: {}, folders: null, active_folder_id: null }]);
    });

    try {
      const store = new SupabaseTeacherPreferencesStore("https://supabase.local", "service-key");
      await store.saveFolders("teacher-a", [
        { id: "default", name: "\uAE30\uBCF8 \uD55C\uC790", orderedChars: ["\u6728"] },
        { id: "grade-2", name: "2\uD559\uB144 1\uBC18", orderedChars: [] },
      ], "grade-2");

      expect(writes).toHaveLength(2);
      expect(writes[0]).toHaveProperty("folders");
      expect(writes[0]?.approved_characters).toMatchObject({
        __hanja_folders: { activeFolderId: "grade-2" },
      });
      expect(writes[1]).not.toHaveProperty("folders");
      expect(writes[1]?.approved_characters).toMatchObject({
        __hanja_folders: {
          activeFolderId: "grade-2",
          folders: expect.arrayContaining([
            expect.objectContaining({ id: "grade-2", orderedChars: [] }),
          ]),
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("saves folder snapshots when Supabase reads fail before folder save", async () => {
    const writes: Array<Record<string, unknown>> = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push(body);
        return new Response(null, { status: 201 });
      }
      return new Response(JSON.stringify({ message: "read failed" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const store = new SupabaseTeacherPreferencesStore("https://supabase.local", "service-key");
      await store.saveFolders("teacher-a", [
        { id: "default", name: "\uAE30\uBCF8 \uD55C\uC790", orderedChars: ["\u6728"] },
        { id: "grade-2", name: "2\uD559\uB144 1\uBC18", orderedChars: [] },
      ], "grade-2");

      expect(writes).toHaveLength(1);
      expect(writes[0]?.approved_characters).toMatchObject({
        __hanja_folders: {
          activeFolderId: "grade-2",
          folders: expect.arrayContaining([
            expect.objectContaining({ id: "grade-2", orderedChars: [] }),
          ]),
        },
      });
    } finally {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
  });

  it("keeps folder changes available when the primary preferences store is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const primary: TeacherPreferencesStore = {
      get: vi.fn(async () => { throw new Error("primary down"); }),
      saveOrder: vi.fn(async () => { throw new Error("primary down"); }),
      saveFolders: vi.fn(async () => { throw new Error("primary down"); }),
      saveQuizPools: vi.fn(async () => { throw new Error("primary down"); }),
      approve: vi.fn(async () => { throw new Error("primary down"); }),
    };

    try {
      const store = new FailoverTeacherPreferencesStore(primary);
      const saved = await store.saveFolders("teacher-a", [
        { id: "default", name: "\uAE30\uBCF8 \uD55C\uC790", orderedChars: ["\u6728"] },
        { id: "grade-2", name: "2\uD559\uB144 1\uBC18", orderedChars: [] },
      ], "grade-2");

      expect(saved.activeFolderId).toBe("grade-2");
      expect(saved.folders).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "grade-2", orderedChars: [] }),
      ]));
      await expect(store.get("teacher-a")).resolves.toMatchObject({
        activeFolderId: "grade-2",
        folders: expect.arrayContaining([
          expect.objectContaining({ id: "grade-2", orderedChars: [] }),
        ]),
      });
      expect(primary.saveFolders).toHaveBeenCalledTimes(1);
      expect(primary.get).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps approvals and folders when quiz-pool persistence falls back to memory", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const primarySnapshot = {
      orderedChars: ["木", "營"],
      folders: [{ id: "class-a", name: "우리 반", orderedChars: ["木", "營"] }],
      activeFolderId: "class-a",
      approvals: [{ char: "營", label: "경영할 영", approvedAt: "2026-09-05T00:00:00.000Z" }],
      quizPools: [],
    };
    const primary: TeacherPreferencesStore = {
      get: vi.fn(async () => structuredClone(primarySnapshot)),
      saveOrder: vi.fn(async () => { throw new Error("primary down"); }),
      saveFolders: vi.fn(async () => { throw new Error("primary down"); }),
      saveQuizPools: vi.fn(async () => { throw new Error("primary down"); }),
      approve: vi.fn(async () => { throw new Error("primary down"); }),
    };

    try {
      const store = new FailoverTeacherPreferencesStore(primary);
      const saved = await store.saveQuizPools("teacher-a", [{
        id: "quiz-a",
        name: "첫 문제풀",
        items: [{ char: "營", meaning: "경영하다", reading: "영" }],
      }]);

      expect(saved.folders).toEqual(expect.arrayContaining(primarySnapshot.folders));
      expect(saved.approvals).toEqual(primarySnapshot.approvals);
      expect(saved.quizPools).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

});
