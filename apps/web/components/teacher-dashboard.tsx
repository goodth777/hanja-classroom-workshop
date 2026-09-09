"use client";

import type {
  CharacterCatalogEntry,
  CharacterCatalogSearchResponse,
  CharacterData,
  GameMode,
  GameCountdownPayload,
  TeacherCharacterFolder,
  TeacherCharacterPreferencesResponse,
  TeacherCharacterApproval,
  TeacherQuizPool,
  CommandError,
  RankedPlayer,
  RoomCreatedPayload,
  RoomSnapshot,
  StrokeProgressPayload,
} from "@hanja/contracts";
import { DEFAULT_STROKE_TURN_SECONDS } from "@hanja/contracts";
import { CURATED_CHARACTERS } from "@hanja/stroke-engine";
import QRCode from "qrcode";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HanjaCanvas } from "./hanja-canvas";
import { Scoreboard } from "./scoreboard";
import { StatusPill } from "./status-pill";
import { createSocket, serverNow, SERVER_URL, type HanjaSocket } from "@/lib/socket";
import { judgmentMessage } from "@/lib/feedback";
import { splitHanjaLabel } from "@/lib/hanja-label";
import { resolveQuizQuestionType } from "@/lib/quiz";
import { CharacterStrokePreview } from "./character-stroke-preview";
import { TeacherQuizPoolManager } from "./teacher-quiz-pool-manager";
import { TeacherGameHistory } from "./teacher-game-history";
import { GameDirectionIcon, TeacherGameArt, TeacherGameHub } from "./teacher-game-hub";
import { TeacherMenuIcon } from "./teacher-menu-icon";
import { GameIntroPreloader, GameStartSequence } from "./game-start-sequence";
import experience from "./teacher-experience.module.css";

interface LogLine {
  id: string;
  text: string;
  tone: "good" | "bad" | "neutral";
}

interface TeacherDashboardProps {
  accessToken: string;
  teacherEmail: string;
  onSignOut: () => void;
}

const DEFAULT_FOLDER_ID = "default";
const SHARED_PREFERENCES_CACHE_KEY = "hanja:teacher:preferences:last";
const DEFAULT_FOLDER: TeacherCharacterFolder = {
  id: DEFAULT_FOLDER_ID,
  name: "기본 한자",
  orderedChars: CURATED_CHARACTERS.map((character) => character.char),
};
const CURATED_CHAR_SET = new Set(CURATED_CHARACTERS.map((character) => character.char));
const CATALOG_PAGE_SIZE = 24;
type TeacherSetupSection = "home" | "lesson" | "library" | "quiz-pools" | "stroke-demo" | "history";
const GAME_MODE_OPTIONS: Array<{ mode: GameMode; title: string; description: string }> = [
  { mode: "stroke_battle", title: "획 배틀", description: "한 획씩 이어 그리며 완성" },
  { mode: "meaning_sound_quiz", title: "뜻·음 스피드 퀴즈", description: "뜻/음을 빠르게 맞히기" },
  { mode: "hanja_worm", title: "한자 지렁이", description: "시작점과 끝점을 따라 한자 완성" },
];

function approvedPlayableCharSet(approvals: TeacherCharacterApproval[]): Set<string> {
  return new Set([...CURATED_CHAR_SET, ...approvals.map((approval) => approval.char)]);
}

function isPlayableCharacter(char: string, approvals: TeacherCharacterApproval[]): boolean {
  return CURATED_CHAR_SET.has(char) || approvals.some((approval) => approval.char === char);
}

function isSelectableCatalogEntry(entry: CharacterCatalogEntry): boolean {
  return entry.status !== "unavailable";
}

function catalogDisplayLabel(entry: CharacterCatalogEntry): string {
  return entry.suggestedLabel ?? entry.label ?? entry.char;
}

function catalogLabelParts(entry: CharacterCatalogEntry): { meaning: string; reading: string } {
  const { meaning, reading } = splitHanjaLabel(catalogDisplayLabel(entry));
  return {
    meaning: meaning || "뜻 정보 없음",
    reading: reading && reading !== entry.char ? reading : "음 정보 없음",
  };
}


function sanitizePreferencesPayload(
  payload: TeacherCharacterPreferencesResponse,
): TeacherCharacterPreferencesResponse {
  const playableChars = approvedPlayableCharSet(payload.preferences.approvals);
  const folders = ensureDefaultFolder(payload.preferences.folders).map((folder) => ({
    ...folder,
    orderedChars: folder.orderedChars.filter((char) => playableChars.has(char)),
  }));
  const activeFolderId = folders.some((folder) => folder.id === payload.preferences.activeFolderId)
    ? payload.preferences.activeFolderId
    : folders[0]!.id;
  const activeFolder = folders.find((folder) => folder.id === activeFolderId) ?? folders[0]!;
  const activeFolderChars = new Set(activeFolder.orderedChars);
  const characters = payload.characters.filter((character) =>
    playableChars.has(character.char) && activeFolderChars.has(character.char)
  );
  return {
    preferences: {
      ...payload.preferences,
      folders,
      activeFolderId,
      orderedChars: [...activeFolder.orderedChars],
      quizPools: Array.isArray(payload.preferences.quizPools) ? payload.preferences.quizPools : [],
    },
    characters,
  };
}

function ensureDefaultFolder(folders: TeacherCharacterFolder[]): TeacherCharacterFolder[] {
  const nextFolders = folders.length > 0 ? structuredClone(folders) : [];
  const defaultIndex = nextFolders.findIndex((folder) => folder.id === DEFAULT_FOLDER_ID);
  if (defaultIndex < 0) return [DEFAULT_FOLDER, ...nextFolders];
  const currentDefault = nextFolders[defaultIndex]!;
  nextFolders[defaultIndex] = {
    ...currentDefault,
    name: currentDefault.name.trim() || DEFAULT_FOLDER.name,
    orderedChars: currentDefault.orderedChars.length > 0 ? currentDefault.orderedChars : DEFAULT_FOLDER.orderedChars,
  };
  return nextFolders;
}
function createFolderId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return "folder-" + crypto.randomUUID();
  return "folder-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}


function isTeacherPreferencesResponse(value: unknown): value is TeacherCharacterPreferencesResponse {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<TeacherCharacterPreferencesResponse>;
  return Boolean(
    payload.preferences &&
    Array.isArray(payload.characters) &&
    Array.isArray(payload.preferences.folders) &&
    Array.isArray(payload.preferences.approvals) &&
    typeof payload.preferences.activeFolderId === "string",
  );
}

function shouldRestoreCachedPreferences(
  serverPayload: TeacherCharacterPreferencesResponse,
  cachedPayload: TeacherCharacterPreferencesResponse,
): boolean {
  const serverFolderIds = new Set(serverPayload.preferences.folders.map((folder) => folder.id));
  const hasCachedFolderMissingFromServer = cachedPayload.preferences.folders.some(
    (folder) => !serverFolderIds.has(folder.id),
  );
  const serverApprovals = new Set(serverPayload.preferences.approvals.map((approval) => approval.char));
  const hasCachedApprovalMissingFromServer = cachedPayload.preferences.approvals.some(
    (approval) => !serverApprovals.has(approval.char),
  );
  const serverQuizPoolIds = new Set((serverPayload.preferences.quizPools ?? []).map((pool) => pool.id));
  const hasCachedQuizPoolMissingFromServer = (cachedPayload.preferences.quizPools ?? []).some((pool) => !serverQuizPoolIds.has(pool.id));
  return hasCachedFolderMissingFromServer || hasCachedApprovalMissingFromServer || hasCachedQuizPoolMissingFromServer;
}

function preferenceCacheScore(payload: TeacherCharacterPreferencesResponse): number {
  const folderScore = payload.preferences.folders.length * 10_000;
  const approvalScore = payload.preferences.approvals.length * 1_000;
  const characterScore = payload.preferences.folders.reduce(
    (total, folder) => total + folder.orderedChars.length,
    0,
  );
  const customFolderScore = payload.preferences.folders.some((folder) => folder.id !== DEFAULT_FOLDER_ID)
    ? 100_000
    : 0;
  const quizPoolScore = (payload.preferences.quizPools ?? []).reduce((total, pool) => total + 5_000 + pool.items.length * 100, 0);
  return customFolderScore + folderScore + approvalScore + characterScore + quizPoolScore;
}

function richerPreferences(
  first: TeacherCharacterPreferencesResponse | null,
  second: TeacherCharacterPreferencesResponse | null,
): TeacherCharacterPreferencesResponse | null {
  if (!first) return second;
  if (!second) return first;
  return preferenceCacheScore(first) >= preferenceCacheScore(second) ? first : second;
}

function readPreferenceCache(key: string): TeacherCharacterPreferencesResponse | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isTeacherPreferencesResponse(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function TeacherDashboard({
  accessToken,
  teacherEmail,
  onSignOut,
}: TeacherDashboardProps) {
  const socketRef = useRef<HanjaSocket | null>(null);
  const activeRoomCodeRef = useRef<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [characters, setCharacters] = useState<CharacterData[]>(CURATED_CHARACTERS);
  const [selectedCharacter, setSelectedCharacter] = useState(CURATED_CHARACTERS[0]!.char);
  const [room, setRoom] = useState<RoomCreatedPayload | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [remoteProgress, setRemoteProgress] = useState<StrokeProgressPayload | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [notice, setNotice] = useState("한자를 고르고 교실을 열어 주세요.");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [rankedPlayers, setRankedPlayers] = useState<RankedPlayer[]>([]);
  const [catalogQuery, setCatalogQuery] = useState("");
  const [catalogResults, setCatalogResults] = useState<CharacterCatalogEntry[]>([]);
  const [catalogSelectedChars, setCatalogSelectedChars] = useState<string[]>([]);
  const [catalogPage, setCatalogPage] = useState(0);
  const [catalogDataCount, setCatalogDataCount] = useState<number | null>(null);
  const [catalogMessage, setCatalogMessage] = useState(
    "찾고 싶은 한자 글자를 직접 입력해 주세요.",
  );
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [approvals, setApprovals] = useState<TeacherCharacterApproval[]>([]);
  const [folders, setFolders] = useState<TeacherCharacterFolder[]>([DEFAULT_FOLDER]);
  const [quizPools, setQuizPools] = useState<TeacherQuizPool[]>([]);
  const [selectedQuizPoolId, setSelectedQuizPoolId] = useState("");
  const [demoCharacter, setDemoCharacter] = useState<CharacterData>(CURATED_CHARACTERS[0]!);
  const [folderDisplayCounts, setFolderDisplayCounts] = useState<Record<string, number>>({
    [DEFAULT_FOLDER_ID]: CURATED_CHARACTERS.length,
  });
  const [activeFolderId, setActiveFolderId] = useState(DEFAULT_FOLDER_ID);
  const [newFolderName, setNewFolderName] = useState("");
  const [approvalFolderId, setApprovalFolderId] = useState(DEFAULT_FOLDER_ID);
  const [preferencesBusy, setPreferencesBusy] = useState(true);
  const [gameCharacterChars, setGameCharacterChars] = useState<string[]>([]);
  const [selectedGameMode, setSelectedGameMode] = useState<GameMode>("stroke_battle");
  const [setupSection, setSetupSection] = useState<TeacherSetupSection>("home");
  const preparationContentRef = useRef<HTMLDivElement>(null);
  const preparationMenuRef = useRef<HTMLDetailsElement>(null);
  const [quizQuestionCount, setQuizQuestionCount] = useState(0);
  const [strokeTurnDurationSeconds, setStrokeTurnDurationSeconds] = useState(DEFAULT_STROKE_TURN_SECONDS);
  const [openingRoom, setOpeningRoom] = useState(false);
  const [knownCharacters, setKnownCharacters] = useState<CharacterData[]>(CURATED_CHARACTERS);
  const [nowMs, setNowMs] = useState(0);
  const [countdownSchedule, setCountdownSchedule] = useState<GameCountdownPayload | null>(null);
  const preferencesCacheKey = useMemo(
    () => "hanja:teacher:" + teacherEmail + ":preferences",
    [teacherEmail],
  );
  const knownCharactersRef = useRef<Map<string, CharacterData>>(
    new Map(CURATED_CHARACTERS.map((character) => [character.char, character])),
  );
  const selectedGameModeRef = useRef<GameMode>("stroke_battle");
  const preferencesSaveSeqRef = useRef(0);

  const appendLog = useCallback((text: string, tone: LogLine["tone"] = "neutral") => {
    setLogs((current) => [{ id: crypto.randomUUID(), text, tone }, ...current].slice(0, 6));
  }, []);

  function chooseGameMode(mode: GameMode) {
    selectedGameModeRef.current = mode;
    setSelectedGameMode(mode);
  }

  function navigatePreparation(section: TeacherSetupSection, mode = selectedGameMode) {
    if (section === "lesson") chooseGameMode(mode);
    setSetupSection(section);
    if (preparationMenuRef.current) preparationMenuRef.current.open = false;
    const hash = section === "home" ? "#games" : section === "lesson" ? `#games/${mode}` : `#${section}`;
    if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "instant" });
      const heading = preparationContentRef.current?.querySelector<HTMLElement>("h1, h2");
      heading?.setAttribute("tabindex", "-1");
      heading?.focus({ preventScroll: true });
    });
  }

  // Local preparation routes retain selections while supporting browser Back/Forward.
  // Active room state stays authoritative: a URL fragment cannot abandon a live room.
  useEffect(() => {
    if (snapshot) return;
    const readPreparationRoute = () => {
      const route = window.location.hash.slice(1);
      const mode = route.startsWith("games/") ? route.slice(6) : "";
      if (GAME_MODE_OPTIONS.some((option) => option.mode === mode)) {
        selectedGameModeRef.current = mode as GameMode;
        setSelectedGameMode(mode as GameMode);
        setSetupSection("lesson");
      } else if (route === "library" || route === "quiz-pools" || route === "stroke-demo" || route === "history") {
        setSetupSection(route);
      } else {
        setSetupSection("home");
      }
      if (preparationMenuRef.current) preparationMenuRef.current.open = false;
    };
    const closePreparationMenuOutside = (event: PointerEvent) => {
      const menu = preparationMenuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    readPreparationRoute();
    window.addEventListener("popstate", readPreparationRoute);
    window.addEventListener("hashchange", readPreparationRoute);
    document.addEventListener("pointerdown", closePreparationMenuOutside, true);
    return () => {
      window.removeEventListener("popstate", readPreparationRoute);
      window.removeEventListener("hashchange", readPreparationRoute);
      document.removeEventListener("pointerdown", closePreparationMenuOutside, true);
    };
  }, [snapshot]);

  useEffect(() => {
    if (!countdownSchedule && snapshot?.status !== "in_progress") return;
    const timer = window.setInterval(() => setNowMs(serverNow(socketRef.current)), countdownSchedule ? 100 : 200);
    return () => window.clearInterval(timer);
  }, [countdownSchedule, snapshot?.gameMode, snapshot?.quiz?.questionIndex, snapshot?.status]);

  const readCachedPreferences = useCallback((): TeacherCharacterPreferencesResponse | null => {
    return richerPreferences(
      readPreferenceCache(preferencesCacheKey),
      readPreferenceCache(SHARED_PREFERENCES_CACHE_KEY),
    );
  }, [preferencesCacheKey]);

  const cachePreferences = useCallback((
    payload: TeacherCharacterPreferencesResponse,
    authoritative = false,
  ) => {
    try {
      const cached = readCachedPreferences();
      const next = sanitizePreferencesPayload(!authoritative && cached && shouldRestoreCachedPreferences(payload, cached)
        ? cached
        : payload);
      const serialized = JSON.stringify(next);
      localStorage.setItem(preferencesCacheKey, serialized);
      localStorage.setItem(SHARED_PREFERENCES_CACHE_KEY, serialized);
    } catch {
      // Browser storage can be unavailable in private or restricted contexts.
    }
  }, [preferencesCacheKey, readCachedPreferences]);

  const applyPreferences = useCallback((
    payload: TeacherCharacterPreferencesResponse,
    authoritative = false,
  ) => {
    const safePayload = sanitizePreferencesPayload(payload);
    cachePreferences(safePayload, authoritative);
    for (const character of safePayload.characters) knownCharactersRef.current.set(character.char, character);
    setKnownCharacters((current) => {
      const characterByChar = new Map<string, CharacterData>();
      for (const character of CURATED_CHARACTERS) characterByChar.set(character.char, character);
      for (const character of current) characterByChar.set(character.char, character);
      for (const character of safePayload.characters) characterByChar.set(character.char, character);
      return [...characterByChar.values()];
    });
    const playableChars = approvedPlayableCharSet(safePayload.preferences.approvals);
    const knownCharacterByChar = new Map<string, CharacterData>();
    for (const character of CURATED_CHARACTERS) knownCharacterByChar.set(character.char, character);
    for (const character of knownCharactersRef.current.values()) knownCharacterByChar.set(character.char, character);
    for (const character of safePayload.characters) knownCharacterByChar.set(character.char, character);
    setGameCharacterChars((current) => current.filter((char) => playableChars.has(char) && knownCharacterByChar.has(char)));
    setCharacters(safePayload.characters);
    const nextFolders = ensureDefaultFolder(safePayload.preferences.folders);
    const nextActiveFolderId = nextFolders.some((folder) => folder.id === safePayload.preferences.activeFolderId)
      ? safePayload.preferences.activeFolderId
      : nextFolders[0]!.id;
    setFolderDisplayCounts((current) => {
      const playableChars = approvedPlayableCharSet(safePayload.preferences.approvals);
      const next = { ...current };
      for (const folder of nextFolders) {
        if (folder.id === nextActiveFolderId) next[folder.id] = safePayload.characters.length;
        else if (folder.id === DEFAULT_FOLDER_ID) {
          next[folder.id] = folder.orderedChars.filter((char) => playableChars.has(char)).length;
        } else if (next[folder.id] === undefined) {
          next[folder.id] = folder.orderedChars.filter((char) => playableChars.has(char)).length || folder.orderedChars.length;
        }
      }
      return next;
    });
    setFolders(nextFolders);
    setActiveFolderId(nextActiveFolderId);
    setApprovalFolderId(nextActiveFolderId);
    setApprovals(safePayload.preferences.approvals);
    const nextQuizPools = safePayload.preferences.quizPools ?? [];
    setQuizPools(nextQuizPools);
    setSelectedQuizPoolId((current) => nextQuizPools.some((pool) => pool.id === current) ? current : nextQuizPools[0]?.id ?? "");
    setSelectedCharacter((current) => {
      if (safePayload.characters.length === 0) return "";
      return safePayload.characters.some((character) => character.char === current)
        ? current
        : safePayload.characters[0]!.char;
    });
  }, [cachePreferences]);

  useEffect(() => {
    let active = true;
    void fetch(`${SERVER_URL}/api/teacher/preferences`, {
      headers: { authorization: `Bearer ${accessToken}` },
    }).then(async (response) => {
      if (!active) return;
      if (!response.ok) throw new Error(`preferences ${response.status}`);
      const payload = (await response.json()) as TeacherCharacterPreferencesResponse;
      const cached = readCachedPreferences();
      if (cached && shouldRestoreCachedPreferences(payload, cached)) {
        applyPreferences(cached, true);
        try {
          let restored: TeacherCharacterPreferencesResponse | null = null;
          for (const approval of cached.preferences.approvals) {
            const approvalResponse = await fetch(SERVER_URL + "/api/teacher/character-approvals", {
              method: "POST",
              headers: {
                authorization: "Bearer " + accessToken,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                char: approval.char,
                label: approval.label,
              }),
            });
            if (!approvalResponse.ok) throw new Error("approval restore failed");
            restored = (await approvalResponse.json()) as TeacherCharacterPreferencesResponse;
          }
          const restoreResponse = await fetch(SERVER_URL + "/api/teacher/preferences", {
            method: "PUT",
            headers: {
              authorization: "Bearer " + accessToken,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              folders: cached.preferences.folders,
              activeFolderId: cached.preferences.activeFolderId,
            }),
          });
          if (!restoreResponse.ok) throw new Error("folder restore failed");
          restored = (await restoreResponse.json()) as TeacherCharacterPreferencesResponse;
          if ((cached.preferences.quizPools ?? []).length > 0) {
            const quizPoolRestoreResponse = await fetch(SERVER_URL + "/api/teacher/preferences", {
              method: "PUT",
              headers: {
                authorization: "Bearer " + accessToken,
                "content-type": "application/json",
              },
              body: JSON.stringify({ quizPools: cached.preferences.quizPools }),
            });
            if (!quizPoolRestoreResponse.ok) throw new Error("quiz pool restore failed");
            restored = await quizPoolRestoreResponse.json() as TeacherCharacterPreferencesResponse;
          }
          if (active && restored) applyPreferences(restored, true);
        } catch {
          if (active) {
            const safeCached = sanitizePreferencesPayload(cached);
            applyPreferences(safeCached, true);
            setNotice("\uC800\uC7A5\uB41C \uC2B9\uC778 \uC815\uBCF4\uB97C \uC11C\uBC84\uC5D0 \uBCF5\uAD6C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. \uD55C\uC790 \uCD94\uAC00\uC5D0\uC11C \uB2E4\uC2DC \uC2B9\uC778\uD574 \uC8FC\uC138\uC694.");
          }
        }
        return;
      }
      applyPreferences(payload);
    }).catch(() => {
      const cached = readCachedPreferences();
      if (active && cached) {
        applyPreferences(cached, true);
        return;
      }
      if (active) setCatalogMessage("\uAD50\uC0AC \uD55C\uC790 \uBAA9\uB85D\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
    }).finally(() => {
      if (active) setPreferencesBusy(false);
    });
    return () => {
      active = false;
    };
  }, [accessToken, applyPreferences, readCachedPreferences]);

  useEffect(() => {
    const socket = createSocket(accessToken);
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnected(true);
      const roomCode = localStorage.getItem("hanja:host:room");
      const hostToken = localStorage.getItem("hanja:host:token");
      if (roomCode && hostToken) {
        activeRoomCodeRef.current = roomCode;
        socket.emit("host:resume-room", { roomCode, hostToken }, (response) => {
          if (activeRoomCodeRef.current !== roomCode || localStorage.getItem("hanja:host:room") !== roomCode) return;
          if (response.ok) {
            if (response.data.snapshot.status === "finished") {
              activeRoomCodeRef.current = null;
              localStorage.removeItem("hanja:host:room");
              localStorage.removeItem("hanja:host:token");
              return;
            }
            setSnapshot(response.data.snapshot);
            setRoom({
              roomCode,
              hostToken,
              qrUrl: `${window.location.origin}/join/${roomCode}`,
              snapshot: response.data.snapshot,
            });
            setNotice("교사 화면을 다시 연결했습니다.");
          } else {
            activeRoomCodeRef.current = null;
            localStorage.removeItem("hanja:host:room");
            localStorage.removeItem("hanja:host:token");
          }
        });
      }
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (error) => {
      setConnected(false);
      setNotice(error.message === "AUTH_REQUIRED" ? "교사 로그인이 만료되었습니다. 다시 로그인해 주세요." : "실시간 서버에 연결하지 못했습니다.");
    });
    socket.on("room:snapshot", (next) => {
      if (next.roomCode === activeRoomCodeRef.current) setSnapshot(next);
    });
    socket.on("player:joined", ({ players }) => {
      setSnapshot((current) => current ? { ...current, players } : current);
    });
    socket.on("game:countdown", (schedule) => {
      if (schedule.roomCode !== activeRoomCodeRef.current) return;
      setCountdownSchedule(schedule);
      setNowMs(serverNow(socket));
      setNotice("도깨비 시작 영상과 카운트다운 후 모든 화면에서 동시에 시작합니다.");
    });
    socket.on("game:started", ({ snapshot: next }) => {
      if (next.roomCode !== activeRoomCodeRef.current) return;
      setCountdownSchedule(null);
      setSnapshot(next);
      appendLog("게임을 시작했습니다.");
    });
    socket.on("stroke:turn", ({ selectedPlayerId, selectedPlayerNickname, strokeIndex, durationSeconds, turnStartedAt, turnEndsAt }) => {
      setNowMs(serverNow(socket));
      setRemoteProgress(null);
      setSnapshot((current) => current ? {
        ...current,
        selectedPlayerId,
        currentStrokeIndex: strokeIndex,
        strokeTurnDurationSeconds: durationSeconds,
        strokeTurnStartedAt: turnStartedAt,
        strokeTurnEndsAt: turnEndsAt,
      } : current);
      appendLog(`${strokeIndex + 1}획 · ${selectedPlayerNickname} 학생 차례`);
    });
    socket.on("stroke:progress", setRemoteProgress);
    socket.on("stroke:result", (result) => {
      setRemoteProgress(null);
      appendLog(
        `${result.nickname} · ${judgmentMessage[result.reason]}`,
        result.correct ? "good" : "bad",
      );
    });
    socket.on("game:finished", ({ rankedPlayers: ranking, snapshot: next }) => {
      if (next.roomCode !== activeRoomCodeRef.current) return;
      setCountdownSchedule(null);
      setRankedPlayers(ranking);
      setSnapshot(next);
      appendLog(next.gameMode === "meaning_sound_quiz" ? "모든 학생이 퀴즈를 마쳤습니다!" : "모든 획을 완성했습니다!", "good");
    });
    socket.connect();
    return () => {
      socket.disconnect();
      socket.removeAllListeners();
      socketRef.current = null;
    };
  }, [accessToken, appendLog]);

  useEffect(() => {
    if (!room?.qrUrl) return;
    void QRCode.toDataURL(room.qrUrl, {
      width: 280,
      margin: 1,
      color: { dark: "#17231f", light: "#ffffff" },
      errorCorrectionLevel: "M",
    }).then(setQrDataUrl);
  }, [room?.qrUrl]);

  const currentCharacter = useMemo<CharacterData | null>(
    () => characters.find((character) => character.char === selectedCharacter) ?? characters[0] ?? null,
    [characters, selectedCharacter],
  );
  const gameCharacters = useMemo<CharacterData[]>(() => {
    const characterByChar = new Map<string, CharacterData>();
    for (const character of knownCharacters) characterByChar.set(character.char, character);
    for (const character of characters) characterByChar.set(character.char, character);
    return gameCharacterChars
      .map((char) => characterByChar.get(char))
      .filter((character): character is CharacterData => Boolean(character));
  }, [characters, gameCharacterChars, knownCharacters]);

  async function syncSelectedApprovalsToServer(characterChars: string[]): Promise<boolean> {
    const approvalsByChar = new Map(approvals.map((approval) => [approval.char, approval]));
    let syncedPayload: TeacherCharacterPreferencesResponse | null = null;
    for (const char of characterChars) {
      if (CURATED_CHAR_SET.has(char)) continue;
      const approval = approvalsByChar.get(char);
      if (!approval) {
        setNotice(char + "\uC790\uB294 \uD55C\uC790 \uCD94\uAC00\uC5D0\uC11C \uBA3C\uC800 \uC2B9\uC778\uD574\uC57C \uAC8C\uC784\uC5D0 \uB123\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
        return false;
      }
      const response = await fetch(SERVER_URL + "/api/teacher/character-approvals", {
        method: "POST",
        headers: {
          authorization: "Bearer " + accessToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          char,
          label: approval.label,
        }),
      });
      const payload = (await response.json()) as TeacherCharacterPreferencesResponse & {
        error?: { message?: string };
      };
      if (!response.ok) {
        setNotice(payload.error?.message ?? "\uD55C\uC790 \uC2B9\uC778 \uC815\uBCF4\uB97C \uC11C\uBC84\uC5D0 \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
        return false;
      }
      syncedPayload = payload;
    }
    if (syncedPayload) {
      const restoreResponse = await fetch(SERVER_URL + "/api/teacher/preferences", {
        method: "PUT",
        headers: {
          authorization: "Bearer " + accessToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          folders,
          activeFolderId,
        }),
      });
      const restored = (await restoreResponse.json()) as TeacherCharacterPreferencesResponse & {
        error?: { message?: string };
      };
      if (!restoreResponse.ok) {
        setNotice(restored.error?.message ?? "\uD55C\uC790 \uD3F4\uB354\uB97C \uC11C\uBC84\uC5D0 \uD655\uC778\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
        return false;
      }
      applyPreferences(restored, true);
    }
    return true;
  }

  function createRoomRequest(
    socket: HanjaSocket,
    characterChars: string[],
    gameMode: GameMode,
    quizPoolId?: string,
    requestedQuizQuestionCount?: number,
    requestedStrokeTurnDurationSeconds?: number,
  ): Promise<RoomCreatedPayload> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error("\uC11C\uBC84 \uC751\uB2F5\uC744 \uAE30\uB2E4\uB9AC\uACE0 \uC788\uC2B5\uB2C8\uB2E4. Render \uC11C\uBC84\uAC00 \uAE68\uC5B4\uB098\uB294 \uC911\uC774\uBA74 \uC7A0\uC2DC \uD6C4 \uB2E4\uC2DC \uB20C\uB7EC\uC8FC\uC138\uC694."));
      }, 15_000);
      socket.emit("host:create-room", {
        character: characterChars[0]!,
        characters: characterChars,
        gameMode,
        quizPoolId,
        quizQuestionCount: requestedQuizQuestionCount,
        strokeTurnDurationSeconds: requestedStrokeTurnDurationSeconds,
      }, (response) => {
        window.clearTimeout(timeout);
        if (response.ok) {
          resolve(response.data);
          return;
        }
        reject(response.error);
      });
    });
  }

  function openCreatedRoom(created: RoomCreatedPayload) {
    activeRoomCodeRef.current = created.roomCode;
    setRoom(created);
    setSnapshot(created.snapshot);
    localStorage.setItem("hanja:host:room", created.roomCode);
    localStorage.setItem("hanja:host:token", created.hostToken);
    setNotice("QR \uAD50\uC2E4\uC744 \uC5F4\uC5C8\uC2B5\uB2C8\uB2E4. \uD559\uC0DD \uC785\uC7A5\uC744 \uAE30\uB2E4\uB824 \uC8FC\uC138\uC694.");
  }

  function isCommandError(error: unknown): error is CommandError {
    return Boolean(error && typeof error === "object" && "code" in error && "message" in error);
  }

  async function createRoom() {
    const socket = socketRef.current;
    if (openingRoom) return;
    if (!socket || !connected) {
      setNotice("\uC2E4\uC2DC\uAC04 \uC11C\uBC84\uC640 \uC5F0\uACB0\uC744 \uBCF5\uAD6C\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uC5F0\uACB0\uB428 \uD45C\uC2DC\uAC00 \uB728\uBA74 \uB2E4\uC2DC \uB20C\uB7EC\uC8FC\uC138\uC694.");
      return;
    }
    const requestedGameMode = selectedGameModeRef.current;
    const selectedQuizPool = quizPools.find((pool) => pool.id === selectedQuizPoolId);
    if (requestedGameMode === "meaning_sound_quiz" && (!selectedQuizPool || selectedQuizPool.items.length < 2)) {
      setNotice("스피드 퀴즈 문제풀을 선택하고 한자를 2자 이상 넣어 주세요.");
      return;
    }
    if (requestedGameMode === "stroke_battle" && gameCharacters.length === 0) {
      setNotice("\uC774\uBC88 \uAC8C\uC784\uC5D0 \uB123\uC744 \uD55C\uC790\uB97C \uBA3C\uC800 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
      return;
    }
    const characterChars = requestedGameMode === "meaning_sound_quiz"
      ? selectedQuizPool!.items.map((item) => item.char)
      : gameCharacters.map((character) => character.char);
    const unplayableChars = requestedGameMode === "stroke_battle"
      ? characterChars.filter((char) => !isPlayableCharacter(char, approvals))
      : [];
    if (unplayableChars.length > 0) {
      setGameCharacterChars((current) => current.filter((char) => !unplayableChars.includes(char)));
      setNotice(unplayableChars.join(", ") + "\uC790\uB294 \uD55C\uC790 \uCD94\uAC00\uC5D0\uC11C \uBA3C\uC800 \uC2B9\uC778\uD574\uC57C \uAC8C\uC784\uC5D0 \uB123\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
      return;
    }
    setOpeningRoom(true);
    try {
      setNotice("\uC120\uD0DD\uD55C " + characterChars.length + "\uC790\uB85C \uAC8C\uC784 \uAD50\uC2E4\uC744 \uC5F4\uACE0 \uC788\uC2B5\uB2C8\uB2E4.");
      const created = await createRoomRequest(socket, characterChars, requestedGameMode, selectedQuizPool?.id, requestedGameMode === "meaning_sound_quiz" ? effectiveQuizQuestionCount : undefined, requestedGameMode === "stroke_battle" ? strokeTurnDurationSeconds : undefined);
      if (created.snapshot.gameMode !== requestedGameMode) {
        setNotice("선택한 게임 방식이 서버에 반영되지 않았습니다. 배포 서버가 최신 버전인지 확인해 주세요.");
        return;
      }
      openCreatedRoom(created);
    } catch (error) {
      if (isCommandError(error) && error.code === "UNKNOWN_CHARACTER") {
        setNotice("\uC2B9\uC778 \uC815\uBCF4\uB97C \uC11C\uBC84\uC5D0 \uB2E4\uC2DC \uB3D9\uAE30\uD654\uD55C \uB4A4 \uAD50\uC2E4\uC744 \uB2E4\uC2DC \uC5F4\uACE0 \uC788\uC2B5\uB2C8\uB2E4.");
        const synced = await syncSelectedApprovalsToServer(characterChars);
        if (!synced) return;
        try {
          const requestedGameMode = selectedGameModeRef.current;
          const created = await createRoomRequest(socket, characterChars, requestedGameMode, selectedQuizPool?.id, requestedGameMode === "meaning_sound_quiz" ? effectiveQuizQuestionCount : undefined, requestedGameMode === "stroke_battle" ? strokeTurnDurationSeconds : undefined);
          if (created.snapshot.gameMode !== requestedGameMode) {
            setNotice("선택한 게임 방식이 서버에 반영되지 않았습니다. 배포 서버가 최신 버전인지 확인해 주세요.");
            return;
          }
          openCreatedRoom(created);
          return;
        } catch (retryError) {
          setNotice(isCommandError(retryError) ? retryError.message : retryError instanceof Error ? retryError.message : "\uAC8C\uC784 \uAD50\uC2E4\uC744 \uC5F4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
          return;
        }
      }
      setNotice(isCommandError(error) ? error.message : error instanceof Error ? error.message : "\uAC8C\uC784 \uAD50\uC2E4\uC744 \uC5F4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
    } finally {
      setOpeningRoom(false);
    }
  }

  function clearRoomState(nextNotice = "교실을 닫고 폴더 선택으로 돌아왔습니다.") {
    activeRoomCodeRef.current = null;
    localStorage.removeItem("hanja:host:room");
    localStorage.removeItem("hanja:host:token");
    setCountdownSchedule(null);
    setRoom(null);
    setSnapshot(null);
    setQrDataUrl("");
    setRankedPlayers([]);
    setLogs([]);
    setNotice(nextNotice);
  }

  function toggleGameCharacter(char: string) {
    if (!isPlayableCharacter(char, approvals)) {
      setSelectedCharacter(char);
      setNotice(char + "\uC790\uB294 \uD55C\uC790 \uCD94\uAC00\uC5D0\uC11C \uBA3C\uC800 \uC2B9\uC778\uD574\uC57C \uAC8C\uC784\uC5D0 \uB123\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4.");
      return;
    }
    const isSelected = gameCharacterChars.includes(char);
    setSelectedCharacter(char);
    setGameCharacterChars((current) => isSelected
      ? current.filter((item) => item !== char)
      : [...current, char]);
    setNotice(isSelected
      ? `${char}\uC790\uB97C \uC774\uBC88 \uAC8C\uC784\uC5D0\uC11C \uBE7C\uB0C8\uC2B5\uB2C8\uB2E4.`
      : `${char}\uC790\uB97C \uC774\uBC88 \uAC8C\uC784\uC5D0 \uB123\uC5C8\uC2B5\uB2C8\uB2E4.`);
  }

  function selectAllGameCharacters() {
    const playableCharacters = characters.filter((character) => isPlayableCharacter(character.char, approvals));
    if (playableCharacters.length === 0) return;
    const charsToAdd = playableCharacters.map((character) => character.char);
    setGameCharacterChars((current) => [
      ...current,
      ...charsToAdd.filter((char) => !current.includes(char)),
    ]);
    setSelectedCharacter(playableCharacters[0]?.char ?? "");
    setNotice(`${activeFolderName} \uD3F4\uB354\uC758 ${playableCharacters.length}\uC790\uB97C \uC774\uBC88 \uAC8C\uC784\uC5D0 \uCD94\uAC00\uD588\uC2B5\uB2C8\uB2E4. \uAE30\uC874 \uC120\uD0DD\uC740 \uC720\uC9C0\uB429\uB2C8\uB2E4.`);
  }

  function clearGameSelection() {
    setGameCharacterChars([]);
    setNotice("\uC774\uBC88 \uAC8C\uC784 \uD55C\uC790 \uC120\uD0DD\uC744 \uBE44\uC6E0\uC2B5\uB2C8\uB2E4.");
  }

  function closeCurrentRoom(confirmBeforeClose = false) {
    if (confirmBeforeClose && !window.confirm("진행 중인 게임을 중단하고 게임 준비 화면으로 돌아갈까요? 학생 화면에도 중단 안내가 표시됩니다.")) return;
    const socket = socketRef.current;
    if (!socket || !snapshot) {
      clearRoomState();
      return;
    }
    socket.emit("host:close-room", { roomCode: snapshot.roomCode }, (response) => {
      if (!response.ok) {
        setNotice(response.error.message);
        return;
      }
      clearRoomState(confirmBeforeClose ? "게임을 중단하고 새 게임 준비 화면으로 돌아왔습니다." : "교실을 닫고 폴더 선택으로 돌아왔습니다.");
    });
  }

  function closeWaitingRoom() {
    closeCurrentRoom(false);
  }

  function startGame() {
    const socket = socketRef.current;
    if (!socket || !snapshot) return;
    socket.emit("host:start-game", { roomCode: snapshot.roomCode }, (response) => {
      setNotice(response.ok ? "첫 번째 차례를 정했습니다." : response.error.message);
    });
  }

  async function searchCatalog() {
    if (!catalogQuery.trim()) {
      setCatalogResults([]);
      setCatalogSelectedChars([]);
      setCatalogPage(0);
      setCatalogMessage("검색할 한자 글자를 입력해 주세요.");
      return;
    }
    setCatalogBusy(true);
    setCatalogMessage("한자 데이터를 확인하고 있습니다…");
    try {
      const response = await fetch(
        `${SERVER_URL}/api/character-catalog?q=${encodeURIComponent(catalogQuery)}`,
      );
      if (!response.ok) throw new Error(`catalog ${response.status}`);
      const result = (await response.json()) as CharacterCatalogSearchResponse;
      setCatalogResults(result.entries);
      setCatalogSelectedChars([]);
      setCatalogPage(0);
      setCatalogDataCount(result.availableDataCount);
      const selectableCount = result.entries.filter(isSelectableCatalogEntry).length;
      setCatalogMessage(
        result.entries.length > 0
          ? result.entries.length + "\uC790 \uC911 " + selectableCount + "\uC790\uB97C \uC120\uD0DD\uD574 \uCD94\uAC00\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4."
          : "\uAC80\uC0C9\uB41C \uD55C\uC790\uAC00 \uC5C6\uC2B5\uB2C8\uB2E4. \uD55C\uC790 \uB610\uB294 \uC74C\uC744 \uB2E4\uC2DC \uC785\uB825\uD574 \uC8FC\uC138\uC694.",
      );
    } catch {
      setCatalogMessage("한자 검색 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setCatalogBusy(false);
    }
  }

  async function saveFolderPreferences(
    nextFolders: TeacherCharacterFolder[],
    nextActiveFolderId = activeFolderId,
  ) {
    const requestSeq = preferencesSaveSeqRef.current + 1;
    preferencesSaveSeqRef.current = requestSeq;
    setPreferencesBusy(true);
    try {
      const response = await fetch(SERVER_URL + "/api/teacher/preferences", {
        method: "PUT",
        headers: {
          authorization: "Bearer " + accessToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          folders: nextFolders,
          activeFolderId: nextActiveFolderId,
        }),
      });
      const payload = (await response.json()) as TeacherCharacterPreferencesResponse & {
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(payload.error?.message ?? "\uD3F4\uB354 \uC800\uC7A5 \uC2E4\uD328");
      if (requestSeq === preferencesSaveSeqRef.current) applyPreferences(payload, true);
      return true;
    } catch (error) {
      if (requestSeq === preferencesSaveSeqRef.current) {
        const message = error instanceof Error ? error.message : "\uD55C\uC790 \uD3F4\uB354\uB97C \uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
        setCatalogMessage(message);
        setNotice(message);
      }
      return false;
    } finally {
      if (requestSeq === preferencesSaveSeqRef.current) setPreferencesBusy(false);
    }
  }



  function applyOptimisticFolders(
    nextFoldersInput: TeacherCharacterFolder[],
    nextActiveFolderId: string,
    extraCharacters: CharacterData[] = [],
    nextApprovals = approvals,
  ) {
    const nextFolders = ensureDefaultFolder(nextFoldersInput);
    const activeFolder = nextFolders.find((folder) => folder.id === nextActiveFolderId) ?? nextFolders[0]!;
    const characterByChar = new Map<string, CharacterData>();
    for (const character of CURATED_CHARACTERS) characterByChar.set(character.char, character);
    for (const character of knownCharactersRef.current.values()) characterByChar.set(character.char, character);
    for (const character of characters) characterByChar.set(character.char, character);
    for (const character of extraCharacters) {
      characterByChar.set(character.char, character);
      knownCharactersRef.current.set(character.char, character);
    }
    setKnownCharacters((current) => {
      const next = new Map(current.map((character) => [character.char, character]));
      for (const character of characterByChar.values()) next.set(character.char, character);
      return [...next.values()];
    });
    const playableChars = approvedPlayableCharSet(nextApprovals);
    const nextCharacters = activeFolder.orderedChars
      .map((char) => characterByChar.get(char))
      .filter((character): character is CharacterData => Boolean(character))
      .filter((character) => playableChars.has(character.char));

    setFolderDisplayCounts((current) => {
      const playableChars = approvedPlayableCharSet(nextApprovals);
      const next = { ...current };
      for (const folder of nextFolders) {
        if (folder.id === activeFolder.id) next[folder.id] = nextCharacters.length;
        else if (folder.id === DEFAULT_FOLDER_ID) {
          next[folder.id] = folder.orderedChars.filter((char) => playableChars.has(char)).length;
        } else if (next[folder.id] === undefined) {
          next[folder.id] = folder.orderedChars.filter((char) => playableChars.has(char)).length || folder.orderedChars.length;
        }
      }
      return next;
    });
    setFolders(nextFolders);
    setActiveFolderId(activeFolder.id);
    setApprovalFolderId(activeFolder.id);
    setCharacters(nextCharacters);
    setApprovals(nextApprovals);
    setSelectedCharacter(nextCharacters[0]?.char ?? "");
    setGameCharacterChars((current) => current.filter((char) => playableChars.has(char) && characterByChar.has(char)));
    cachePreferences({
      preferences: {
        orderedChars: [...activeFolder.orderedChars],
        folders: nextFolders,
        activeFolderId: activeFolder.id,
        approvals: nextApprovals,
        quizPools,
      },
      characters: nextCharacters,
    }, true);
  }

  async function selectFolder(folderId: string) {
    if (folderId === activeFolderId) return;
    const target = folders.find((folder) => folder.id === folderId);
    if (!target) return;
    applyOptimisticFolders(folders, folderId);
    setCatalogMessage(`${target.name}\uD3F4\uB354\uB85C \uC774\uB3D9\uD588\uC2B5\uB2C8\uB2E4.`);
    setNotice(`${target.name} \uD3F4\uB354\uB97C \uBCF4\uACE0 \uC788\uC2B5\uB2C8\uB2E4.`);
    if (await saveFolderPreferences(folders, folderId)) {
      setCatalogMessage(`${target.name} \uD3F4\uB354\uC758 \uD55C\uC790\uB97C \uBD88\uB7EC\uC654\uC2B5\uB2C8\uB2E4.`);
    }
  }

  async function createFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    setNotice(`${name} \uD3F4\uB354\uB97C \uC800\uC7A5\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.`);
    const folder: TeacherCharacterFolder = {
      id: createFolderId(),
      name,
      orderedChars: [],
    };
    const nextFolders = [...folders, folder];
    applyOptimisticFolders(nextFolders, folder.id);
    setNewFolderName("");
    setCatalogMessage(`${name} \uD3F4\uB354\uB97C \uCD94\uAC00\uD588\uC2B5\uB2C8\uB2E4.`);
    setNotice(`${name} \uD3F4\uB354\uAC00 \uC120\uD0DD\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`);
    if (await saveFolderPreferences(nextFolders, folder.id)) {
      setCatalogMessage(`${name} \uD3F4\uB354\uB97C \uB9CC\uB4E4\uC5C8\uC2B5\uB2C8\uB2E4.`);
    }
  }

  async function renameActiveFolder() {
    const current = folders.find((folder) => folder.id === activeFolderId);
    if (!current) return;
    const name = window.prompt("새 폴더 이름을 입력해 주세요.", current.name)?.trim();
    if (!name || name === current.name) return;
    await saveFolderPreferences(
      folders.map((folder) => folder.id === activeFolderId ? { ...folder, name } : folder),
    );
  }

  async function deleteActiveFolder() {
    if (folders.length <= 1) {
      setCatalogMessage("\uAE30\uBCF8 \uD3F4\uB354\uB294 \uC0AD\uC81C\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      return;
    }
    const current = folders.find((folder) => folder.id === activeFolderId);
    if (!current || !window.confirm(current.name + " 폴더를 삭제할까요? 폴더 안 한자는 목록에서만 빠집니다.")) {
      return;
    }
    const nextFolders = folders.filter((folder) => folder.id !== activeFolderId);
    await saveFolderPreferences(nextFolders, nextFolders[0]!.id);
  }

  async function removeCharacterFromActiveFolder(char: string) {
    const current = folders.find((folder) => folder.id === activeFolderId);
    if (!current || !current.orderedChars.includes(char)) return;
    const nextFolders = folders.map((folder) => folder.id === activeFolderId
      ? { ...folder, orderedChars: folder.orderedChars.filter((candidate) => candidate !== char) }
      : folder);
    applyOptimisticFolders(nextFolders, activeFolderId);
    setGameCharacterChars((currentSelection) => currentSelection.filter((candidate) => candidate !== char));
    setCatalogMessage(`${char}\uC790\uB97C ${current.name} \uD3F4\uB354\uC5D0\uC11C \uBE7C\uB0C8\uC2B5\uB2C8\uB2E4.`);
    setNotice(`${char}\uC790\uB97C ${current.name} \uD3F4\uB354\uC5D0\uC11C \uC0AD\uC81C\uD588\uC2B5\uB2C8\uB2E4.`);
    await saveFolderPreferences(nextFolders, activeFolderId);
  }

  function toggleCatalogSelection(char: string) {
    const entry = catalogResults.find((candidate) => candidate.char === char);
    if (!entry || !isSelectableCatalogEntry(entry)) return;
    setCatalogSelectedChars((current) => current.includes(char)
      ? current.filter((candidate) => candidate !== char)
      : [...current, char]);
  }

  async function addSelectedCatalogCharacters() {
    const targetFolder = approvalTargetFolder ?? activeFolder;
    const selectedEntries = catalogResults.filter((entry) =>
      catalogSelectedChars.includes(entry.char) && isSelectableCatalogEntry(entry),
    );
    if (!targetFolder) {
      setCatalogMessage("\uCD94\uAC00\uD560 \uD3F4\uB354\uB97C \uBA3C\uC800 \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
      return;
    }
    if (selectedEntries.length === 0) {
      setCatalogMessage("\uAC80\uC0C9 \uACB0\uACFC\uC5D0\uC11C \uCD94\uAC00\uD560 \uD55C\uC790\uB97C \uC120\uD0DD\uD574 \uC8FC\uC138\uC694.");
      return;
    }
    setCatalogBusy(true);
    setPreferencesBusy(true);
    setCatalogMessage(selectedEntries.length + "\uC790\uB97C " + targetFolder.name + " \uD3F4\uB354\uC5D0 \uCD94\uAC00\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.");
    setNotice(targetFolder.name + " \uD3F4\uB354\uC5D0 " + selectedEntries.length + "\uC790\uB97C \uC800\uC7A5\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4.");
    try {
      let latestPayload: TeacherCharacterPreferencesResponse | null = null;
      for (const entry of selectedEntries) {
        const response = await fetch(SERVER_URL + "/api/teacher/character-approvals", {
          method: "POST",
          headers: {
            authorization: "Bearer " + accessToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            char: entry.char,
            label: catalogDisplayLabel(entry),
            folderId: targetFolder.id,
          }),
        });
        const payload = (await response.json()) as TeacherCharacterPreferencesResponse & {
          error?: { message?: string };
        };
        if (!response.ok) throw new Error(payload.error?.message ?? entry.char + " \uC800\uC7A5 \uC2E4\uD328");
        latestPayload = payload;
      }
      if (latestPayload) applyPreferences(latestPayload, true);
      const selectedChars = selectedEntries.map((entry) => entry.char);
      setSelectedCharacter(selectedChars[0] ?? "");
      setCatalogSelectedChars([]);
      setCatalogMessage(selectedEntries.length + "\uC790\uB97C " + targetFolder.name + " \uD3F4\uB354\uC5D0 \uCD94\uAC00\uD588\uC2B5\uB2C8\uB2E4. \uCD9C\uC81C\uD558\uB824\uBA74 \uC704 \uD3F4\uB354 \uD55C\uC790\uC5D0\uC11C \uB530\uB85C \uC120\uD0DD\uD558\uC138\uC694.");
      setNotice(targetFolder.name + " \uD3F4\uB354\uC5D0 " + selectedEntries.length + "\uC790\uAC00 \uC800\uC7A5\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
    } catch (error) {
      setCatalogMessage(error instanceof Error ? error.message : "\uC120\uD0DD\uD55C \uD55C\uC790\uB97C \uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
    } finally {
      setCatalogBusy(false);
      setPreferencesBusy(false);
    }
  }

  async function saveQuizPools(nextQuizPools: TeacherQuizPool[]): Promise<boolean> {
    setPreferencesBusy(true);
    try {
      const response = await fetch(SERVER_URL + "/api/teacher/preferences", {
        method: "PUT",
        headers: {
          authorization: "Bearer " + accessToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ quizPools: nextQuizPools }),
      });
      const payload = await response.json() as TeacherCharacterPreferencesResponse & { error?: { message?: string } };
      if (!response.ok) throw new Error(payload.error?.message ?? "퀴즈 문제풀을 저장하지 못했습니다.");
      applyPreferences(payload, true);
      setNotice("퀴즈 문제풀을 저장했습니다.");
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "퀴즈 문제풀을 저장하지 못했습니다.");
      return false;
    } finally {
      setPreferencesBusy(false);
    }
  }

  function resetForNewGame() {
    clearRoomState();
    setNotice("다시 게임할 한자를 선택해 주세요.");
  }

  const activeCharacter = snapshot?.character ?? currentCharacter ?? CURATED_CHARACTERS[0]!;
  const completedCount = snapshot
    ? snapshot.status === "finished"
      ? activeCharacter.strokeData.length
      : snapshot.currentStrokeIndex
    : 0;
  const activeFolder = folders.find((folder) => folder.id === activeFolderId);
  const activeFolderName = activeFolder?.name ?? "\uB0B4 \uC218\uC5C5";
  const folderDisplayCount = (folder: TeacherCharacterFolder) => (
    folderDisplayCounts[folder.id] ?? (
      folder.id === activeFolderId ? characters.length : folder.orderedChars.length
    )
  );
  const targetFolderId = approvalFolderId || activeFolderId;
  const approvalTargetFolder = folders.find((folder) => folder.id === targetFolderId);
  const approvalTargetFolderName = approvalTargetFolder?.name ?? activeFolderName;
  const selectableCatalogResults = catalogResults.filter(isSelectableCatalogEntry);
  const catalogPageCount = Math.max(1, Math.ceil(selectableCatalogResults.length / CATALOG_PAGE_SIZE));
  const boundedCatalogPage = Math.min(catalogPage, catalogPageCount - 1);
  const catalogPageStart = boundedCatalogPage * CATALOG_PAGE_SIZE;
  const catalogPageResults = selectableCatalogResults.slice(catalogPageStart, catalogPageStart + CATALOG_PAGE_SIZE);
  const selectedCatalogEntries = catalogResults.filter((entry) => catalogSelectedChars.includes(entry.char) && isSelectableCatalogEntry(entry));
  const currentPageSelectableChars = catalogPageResults
    .filter(isSelectableCatalogEntry)
    .map((entry) => entry.char);
  const allCurrentPageSelected = currentPageSelectableChars.length > 0 && currentPageSelectableChars.every((char) => catalogSelectedChars.includes(char));
  const selectedQuizPool = quizPools.find((pool) => pool.id === selectedQuizPoolId) ?? quizPools[0];
  const selectedQuizPoolSize = selectedQuizPool?.items.length ?? 0;
  const effectiveQuizQuestionCount = selectedQuizPoolSize === 0
    ? 0
    : Math.max(selectedQuizPoolSize, Math.min(selectedQuizPoolSize * 2, quizQuestionCount || selectedQuizPoolSize));
  const demoCharacterInFolder = characters.find((character) => character.char === demoCharacter.char) ?? characters[0] ?? null;
  const lessonSelectedCount = selectedGameMode === "meaning_sound_quiz" ? selectedQuizPool?.items.length ?? 0 : gameCharacters.length;
  const finalScorePlayers = snapshot?.status === "finished" && rankedPlayers.length ? rankedPlayers : snapshot?.players ?? [];
  const activeCharacterInfo = splitHanjaLabel(activeCharacter.label);
  const quizAnswerByPlayer = new Map(snapshot?.quiz?.answers.map((answer) => [answer.playerId, answer]) ?? []);
  const quizFinalCount = snapshot?.players.filter((player) => {
    const answer = quizAnswerByPlayer.get(player.id);
    return Boolean(answer && (answer.correct || answer.attemptNumber == null || answer.attemptNumber >= 2));
  }).length ?? 0;
  const quizCorrectCount = [...quizAnswerByPlayer.values()].filter((answer) => answer.correct).length;
  const effectiveNowMs = nowMs || snapshot?.quiz?.questionStartedAt || 0;
  const quizRemainingMs = snapshot?.quiz ? Math.max(0, snapshot.quiz.questionEndsAt - effectiveNowMs) : 0;
  const quizDurationMs = snapshot?.quiz ? Math.max(1, snapshot.quiz.questionEndsAt - snapshot.quiz.questionStartedAt) : 1;
  const quizRemainingSeconds = Math.ceil(quizRemainingMs / 1000);
  const quizProgressPercent = Math.max(0, Math.min(100, (quizRemainingMs / quizDurationMs) * 100));
  const quizQuestionType = resolveQuizQuestionType(snapshot?.quiz);
  const quizQuestionTitle = quizQuestionType === "legacy_choice" ? "뜻·음을 고르는 문제" : quizQuestionType === "hanja_choice" ? "뜻·음으로 한자 고르기" : quizQuestionType.startsWith("reading") ? "음을 묻는 문제" : "뜻을 묻는 문제";
  const quizQuestionKind = quizQuestionType.endsWith("_input") ? "주관식" : "객관식";

  return (
    <main className={`teacherPage ${experience.page}`}>
      <GameStartSequence schedule={countdownSchedule} nowMs={nowMs} />
      {snapshot?.status === "waiting" && <GameIntroPreloader />}
      <header className={`topBar ${experience.topBar}`}>
        <Link className="brand" href="/" aria-label="획 한자 배틀 홈" onClick={(event) => { if (!snapshot) { event.preventDefault(); navigatePreparation("home"); } }}>
          <span className="brandStamp">획!</span>
          <span>한자 배틀</span>
        </Link>
        {!snapshot && <nav className={experience.navigation} aria-label="교사 준비 메뉴">
          <button type="button" aria-label="게임 시작" aria-current={setupSection === "home" || setupSection === "lesson" ? "page" : undefined} className={setupSection === "home" || setupSection === "lesson" ? experience.activeNav : ""} onClick={() => navigatePreparation("home")}><TeacherMenuIcon name="game" /><span>게임</span></button>
          <button type="button" aria-label="획순 보기" aria-current={setupSection === "stroke-demo" ? "page" : undefined} className={setupSection === "stroke-demo" ? experience.activeNav : ""} onClick={() => navigatePreparation("stroke-demo")}><TeacherMenuIcon name="strokes" /><span>획순 보기</span></button>
          <button type="button" aria-label="기록 랭킹" aria-current={setupSection === "history" ? "page" : undefined} className={setupSection === "history" ? experience.activeNav : ""} onClick={() => navigatePreparation("history")}><TeacherMenuIcon name="ranking" /><span>기록·랭킹</span></button>
          <details ref={preparationMenuRef} className={experience.toolsMenu} onKeyDown={(event) => { if (event.key === "Escape") { event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}>
            <summary className={setupSection === "library" || setupSection === "quiz-pools" ? experience.activeNav : ""}><TeacherMenuIcon name="folders" /><span>수업 자료</span><i className={experience.menuChevron} aria-hidden="true" /></summary>
            <div className={experience.toolsPopover}><button type="button" aria-label="한자 폴더 관리" aria-current={setupSection === "library" ? "page" : undefined} onClick={() => navigatePreparation("library")}><TeacherMenuIcon name="folders" />한자 폴더 관리</button><button type="button" aria-label="퀴즈 문제풀" aria-current={setupSection === "quiz-pools" ? "page" : undefined} onClick={() => navigatePreparation("quiz-pools")}><TeacherMenuIcon name="quiz" />퀴즈 문제풀</button></div>
          </details>
        </nav>}
        <div className="teacherAccount">
          <div><strong>{teacherEmail}</strong><span>교사 계정</span></div>
          <button className="secondaryButton" onClick={onSignOut} type="button">로그아웃</button>
          <StatusPill connected={connected} />
        </div>
      </header>

      {!connected && (
        <div className="connectionBanner" role="status">
          <strong>서버 연결을 복구하고 있습니다</strong>
          <span>Render 무료 인스턴스가 깨어나는 동안 시간이 걸릴 수 있습니다. 폴더와 점수 데이터는 복구 후 다시 불러옵니다.</span>
        </div>
      )}

      {!snapshot && (
        <section className={experience.workspace} aria-label="교사 수업 준비">
          <div ref={preparationContentRef} className={experience.pageContent} key={`${setupSection}:${setupSection === "lesson" ? selectedGameMode : ""}`}>
          {setupSection === "home" ? <TeacherGameHub onChoose={(mode) => navigatePreparation("lesson", mode)} onLibrary={() => navigatePreparation("library")} /> : <>
          <button className={experience.backButton} type="button" onClick={() => navigatePreparation("home")}><GameDirectionIcon back />게임 선택으로</button>
          {setupSection === "lesson" && <div className={experience.setupHeading}><div><p className={experience.eyebrow}>PREPARE YOUR CLASS</p><h1 tabIndex={-1}>{GAME_MODE_OPTIONS.find((option) => option.mode === selectedGameMode)?.title}</h1><p>{selectedGameMode === "meaning_sound_quiz" ? "문제풀을 고르고, 오늘의 퀴즈를 시작하세요." : "함께 배울 한자를 골라, 우리 반의 도전을 준비하세요."}</p></div><div className={experience.setupArt}><TeacherGameArt mode={selectedGameMode} /></div></div>}
          <div className={experience.contentPanel}>
            {setupSection === "history" && <TeacherGameHistory accessToken={accessToken} />}
            {setupSection === "lesson" && (
              <section className={experience.lessonPanel} aria-label="수업 시작" data-testid="game-setup" data-game-mode={selectedGameMode}>
                <div className={experience.lessonSource}>
                {selectedGameMode === "meaning_sound_quiz" ? (
                  <div className="lessonQuizPoolPicker">
                    {quizPools.length > 0 ? (
                      <>
                        <label><span>문제풀</span><select aria-label="게임에 사용할 퀴즈 문제풀" onChange={(event) => { const nextId = event.target.value; setSelectedQuizPoolId(nextId); setQuizQuestionCount(quizPools.find((pool) => pool.id === nextId)?.items.length ?? 0); }} value={selectedQuizPool?.id ?? ""}>{quizPools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name} ({pool.items.length}자 · 기본 {pool.items.length}문제)</option>)}</select></label>
                        <div className="quizPoolLessonItems">{selectedQuizPool?.items.map((item) => <span key={item.char}><b>{item.char}</b>{item.meaning} · {item.reading}</span>)}</div>
                      </>
                    ) : <div className="emptyQuizPool"><strong>먼저 퀴즈 문제풀을 만들어 주세요.</strong><span>한자·뜻·음을 수업에 맞게 다듬은 뒤 반복해서 사용할 수 있습니다.</span></div>}
                    <button className="secondaryButton" onClick={() => navigatePreparation("quiz-pools")} type="button">퀴즈 문제풀 관리</button>
                  </div>
                ) : (
                  <>
                    <div className="lessonToolbar"><label><span>수업 폴더</span><select aria-label="한자 폴더 선택" onChange={(event) => void selectFolder(event.target.value)} value={activeFolderId}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name} ({folderDisplayCount(folder)}자)</option>)}</select></label><button className="secondaryButton" onClick={() => navigatePreparation("library")} type="button">한자·폴더 관리</button></div>
                    <div className={experience.sourceHeading}><strong>이번 게임에 넣을 한자</strong><div className={experience.selectionTools}><button disabled={characters.length === 0} onClick={selectAllGameCharacters} type="button">폴더 전체 선택</button><button disabled={gameCharacters.length === 0} onClick={clearGameSelection} type="button">선택 비우기</button></div></div>
                    <div className="characterPicker lessonCharacterGrid">
                      {characters.length > 0 ? characters.map((character) => {
                        const inGame = gameCharacterChars.includes(character.char);
                        const focused = character.char === selectedCharacter;
                        return <button aria-label={character.char + (inGame ? " 게임에서 빼기" : " 게임에 넣기")} aria-pressed={inGame} className={[focused ? "focused" : "", inGame ? "inGame" : ""].filter(Boolean).join(" ")} key={character.char} onClick={() => toggleGameCharacter(character.char)} type="button"><strong>{character.char}</strong><span>{character.strokeData.length}획</span></button>;
                      }) : <p className="emptyFolderMessage">이 폴더에는 아직 한자가 없습니다. 한자·폴더 관리에서 검색해 추가하세요.</p>}
                    </div>
                  </>
                )}
                </div>
                <div className={experience.launchSummary} aria-label="게임 설정 요약">
                  {selectedGameMode === "meaning_sound_quiz" ? <>
                    <div className={experience.quizSummaryTitle}><strong>이번 퀴즈</strong><span>{selectedQuizPoolSize}자 문제풀</span></div>
                    <label className="quizQuestionCountField"><span>출제 문항 수</span><select aria-label="스피드 퀴즈 문항 수" disabled={selectedQuizPoolSize === 0} onChange={(event) => setQuizQuestionCount(Number(event.target.value))} value={effectiveQuizQuestionCount}>{selectedQuizPoolSize === 0 ? <option value={0}>문제풀을 먼저 선택</option> : Array.from({ length: selectedQuizPoolSize + 1 }, (_, index) => selectedQuizPoolSize + index).map((count) => <option key={count} value={count}>{count}문제{count === selectedQuizPoolSize ? " (기본)" : ""}</option>)}</select><small>모든 한자를 한 번씩 포함합니다. 추가 문항은 다른 유형으로 출제해요.</small></label>
                  </> : <div className="selectedSummary" aria-label="이번 게임 한자"><div className="selectedSummaryTitle"><strong>이번 게임 한자</strong><span>{gameCharacters.length}자 선택</span></div>{gameCharacters.length > 0 ? <div className="selectedTextChips">{gameCharacters.map((character) => <button aria-label={character.char + " 게임에서 빼기"} key={character.char} onClick={() => toggleGameCharacter(character.char)} type="button"><span>{character.char}</span></button>)}</div> : <p>왼쪽에서 한자를 골라주세요.</p>}</div>}
                  {selectedGameMode === "stroke_battle" && <label className="strokeTurnSetting">
                      <span><strong>한 획 제한 시간</strong><small>시간이 끝나면 다음 학생에게 차례가 넘어갑니다.</small></span>
                      <select aria-label="획배틀 한 획 제한 시간" onChange={(event) => setStrokeTurnDurationSeconds(Number(event.target.value))} value={strokeTurnDurationSeconds}>
                        {[5, 8, 10, 15, 20].map((seconds) => <option key={seconds} value={seconds}>{seconds}초{seconds === DEFAULT_STROKE_TURN_SECONDS ? " (기본)" : ""}</option>)}
                      </select>
                    </label>}
                  {selectedGameMode === "hanja_worm" && <div className={experience.gameRule}><strong>벌레에 3번 닿으면 도전 종료</strong><span>각자의 화면에서 시작점과 끝점을 찾아 획을 연결합니다.</span></div>}
                  <button
                    className="primaryButton simpleOpenRoomButton"
                    disabled={!connected || lessonSelectedCount < (selectedGameMode === "meaning_sound_quiz" ? 2 : 1) || openingRoom}
                    onClick={() => void createRoom()}
                    type="button"
                  >
                    <span>{openingRoom ? "게임 교실을 여는 중" : lessonSelectedCount > 0 ? selectedGameMode === "hanja_worm" ? `${lessonSelectedCount}자로 한자 지렁이 열기` : selectedGameMode === "meaning_sound_quiz" ? `${effectiveQuizQuestionCount}문제로 퀴즈 열기` : `${lessonSelectedCount}자 · ${strokeTurnDurationSeconds}초로 게임 열기` : selectedGameMode === "meaning_sound_quiz" ? "퀴즈 문제풀을 먼저 선택" : "게임 한자를 먼저 선택"}</span><span aria-hidden="true">→</span>
                  </button>
                  <p className={experience.summaryFoot}>QR로 학생들이 입장하면 시작할 수 있어요.</p>
                  <p className="notice" role="status">{notice}</p>
                </div>
              </section>
            )}

            {setupSection === "quiz-pools" && (
              <TeacherQuizPoolManager
                activeFolderId={activeFolderId}
                characters={characters}
                folders={folders}
                pools={quizPools}
                savePools={saveQuizPools}
                selectFolder={selectFolder}
                selectedPoolId={selectedQuizPoolId}
                setPools={setQuizPools}
                setSelectedPoolId={setSelectedQuizPoolId}
              />
            )}

            {setupSection === "stroke-demo" && (
              <section className="teacherSection strokeDemoSection" aria-label="교사용 획순 보기">
                <div className="teacherSectionHeader"><div><p className="kicker">수업 · 획순 보기</p><h2>수업 폴더의 한자를 크게 보여주세요</h2></div><span className="curatedTag">게임방 없이 사용</span></div>
                <div className="strokeDemoPicker">
                  <label><span>수업 폴더</span><select aria-label="획순 보기 폴더" onChange={(event) => void selectFolder(event.target.value)} value={activeFolderId}>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
                </div>
                <div className="strokeDemoCharacters" aria-label="획순을 볼 한자 선택">
                  {characters.map((character) => <button aria-pressed={demoCharacterInFolder?.char === character.char} className={demoCharacterInFolder?.char === character.char ? "selected" : ""} key={character.char} onClick={() => setDemoCharacter(character)} type="button"><strong>{character.char}</strong><span>{character.strokeData.length}획</span></button>)}
                  {characters.length === 0 && <p className="emptyFolderMessage">이 수업 폴더에는 획순을 볼 한자가 없습니다.</p>}
                </div>
                {demoCharacterInFolder && <CharacterStrokePreview character={demoCharacterInFolder} />}
              </section>
            )}

            {setupSection === "library" && (
              <section className="teacherSection" aria-label="폴더 관리">
                <div className="teacherSectionHeader">
                  <div>
                    <p className="kicker">02 · 폴더 관리</p>
                    <h2>수업 폴더를 만들고 정리하세요</h2>
                  </div>
                  <span className="curatedTag">{folders.length}개</span>
                </div>

                <div className="folderManagementGrid">
                  <div className="newFolderForm managerNewFolderForm">
                    <input
                      aria-label="새 폴더 이름"
                      maxLength={40}
                      onChange={(event) => setNewFolderName(event.target.value)}
                      placeholder="예: 3학년 1단원"
                      value={newFolderName}
                    />
                    <button disabled={!newFolderName.trim() || preferencesBusy} onClick={() => void createFolder()} type="button">
                      폴더 추가
                    </button>
                  </div>
                  <div className="folderChips sidebarFolderChips" aria-label="내 한자 폴더 목록">
                    {folders.map((folder) => (
                      <button
                        className={folder.id === activeFolderId ? "selected" : ""}
                        key={folder.id}
                        onClick={() => void selectFolder(folder.id)}
                        type="button"
                      >
                        <strong>{folder.name}</strong><span>{folderDisplayCount(folder)}자</span>
                      </button>
                    ))}
                  </div>
                  <div className="folderActions mutedFolderActions">
                    <button disabled={preferencesBusy} onClick={() => void renameActiveFolder()} type="button">선택 폴더 이름 변경</button>
                    <button disabled={folders.length <= 1 || preferencesBusy} onClick={() => void deleteActiveFolder()} type="button">선택 폴더 삭제</button>
                  </div>
                </div>
                <p className="notice" role="status">{notice}</p>
              </section>
            )}

            {setupSection === "library" && (
              <section className="teacherSection libraryCharacterSection" aria-label="폴더 한자 삭제">
                <div className="teacherSectionHeader compactLibraryHeader">
                  <div>
                    <p className="kicker">폴더 속 한자</p>
                    <h2>{activeFolderName} 폴더 한자 관리</h2>
                  </div>
                  <span className="curatedTag">{characters.length}자</span>
                </div>
                <div className="selectedTextChips libraryCharacterChips">
                  {characters.length > 0 ? characters.map((character) => (
                    <button
                      aria-label={character.char + " 폴더에서 삭제"}
                      key={character.char}
                      onClick={() => void removeCharacterFromActiveFolder(character.char)}
                      type="button"
                    >
                      <span>{character.char}</span>
                      <small>삭제</small>
                    </button>
                  )) : (
                    <p className="emptyFolderMessage">이 폴더에는 아직 한자가 없습니다. 아래에서 검색해 추가하세요.</p>
                  )}
                </div>
              </section>
            )}

            {setupSection === "library" && (
              <section className="teacherSection" aria-label="한자 추가">
                <div className="teacherSectionHeader">
                  <div>
                    <p className="kicker">한자 검색</p>
                    <h2>찾은 한자를 선택해 폴더에 넣으세요</h2>
                  </div>
                  {catalogDataCount !== null && <span className="curatedTag">{catalogDataCount.toLocaleString()}자 데이터</span>}
                </div>

                <div className="catalogTargetBar teacherCatalogTargetBar">
                  <label htmlFor="catalog-target-folder">추가할 폴더</label>
                  <select
                    id="catalog-target-folder"
                    onChange={(event) => setApprovalFolderId(event.target.value)}
                    value={targetFolderId}
                  >
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.id}>{folder.name} ({folderDisplayCount(folder)}자)</option>
                    ))}
                  </select>
                  <p><strong>{approvalTargetFolderName}</strong> 폴더에만 저장됩니다. 출제 한자는 수업 시작에서 따로 고릅니다.</p>
                </div>

                <form
                  className="catalogSearch"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void searchCatalog();
                  }}
                >
                  <input
                    aria-label="한자 데이터 검색"
                    maxLength={20}
                    onChange={(event) => setCatalogQuery(event.target.value)}
                    placeholder="예: 인, 비, 木"
                    value={catalogQuery}
                  />
                  <button className="secondaryButton" disabled={catalogBusy} type="submit">
                    {catalogBusy ? "검색 중" : "검색"}
                  </button>
                </form>
                <p className="catalogMessage" role="status">{catalogMessage}</p>

                {catalogResults.length > 0 && (
                  <section className="catalogResultPanel" aria-label="검색 결과">
                    <div className="catalogResultToolbar">
                      <strong>추가 가능한 한자 {selectableCatalogResults.length}자</strong>
                      <span>{selectedCatalogEntries.length}자 선택</span>
                    </div>
                    <div className="catalogBulkActions">
                      <button
                        className="secondaryButton"
                        disabled={currentPageSelectableChars.length === 0}
                        onClick={() => {
                          setCatalogSelectedChars((current) => allCurrentPageSelected
                            ? current.filter((char) => !currentPageSelectableChars.includes(char))
                            : [...current, ...currentPageSelectableChars.filter((char) => !current.includes(char))]);
                        }}
                        type="button"
                      >
                        {allCurrentPageSelected ? "현재 페이지 해제" : "현재 페이지 선택"}
                      </button>
                      <button className="secondaryButton" disabled={catalogSelectedChars.length === 0} onClick={() => setCatalogSelectedChars([])} type="button">
                        선택 비우기
                      </button>
                      <button className="primaryButton catalogAddSelectedButton" disabled={catalogBusy || selectedCatalogEntries.length === 0} onClick={() => void addSelectedCatalogCharacters()} type="button">
                        <span>{selectedCatalogEntries.length > 0 ? selectedCatalogEntries.length + "자 폴더에 추가" : "선택한 한자 폴더에 추가"}</span><span>→</span>
                      </button>
                    </div>
                    {selectableCatalogResults.length > 0 ? (
                      <div className="catalogCardGrid">
                        {catalogPageResults.map((entry) => {
                          const checked = catalogSelectedChars.includes(entry.char);
                          const label = catalogLabelParts(entry);
                          return (
                            <label className={`catalogSelectCard${checked ? " selected" : ""}`} key={entry.char}>
                              <input
                                aria-label={entry.char + " 선택"}
                                checked={checked}
                                onChange={() => toggleCatalogSelection(entry.char)}
                                type="checkbox"
                              />
                              <span className="catalogCardGlyph" aria-hidden="true">{entry.char}</span>
                              <span className="catalogCardText">
                                <strong title={label.meaning}>{label.meaning}</strong>
                                <small>{label.reading}</small>
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="emptyFolderMessage">바로 추가할 수 있는 한자가 없습니다.</p>
                    )}
                    <div className="catalogPager">
                      <button className="secondaryButton" disabled={boundedCatalogPage === 0} onClick={() => setCatalogPage((page) => Math.max(0, page - 1))} type="button">이전</button>
                      <span>{boundedCatalogPage + 1} / {catalogPageCount}</span>
                      <button className="secondaryButton" disabled={boundedCatalogPage >= catalogPageCount - 1} onClick={() => setCatalogPage((page) => Math.min(catalogPageCount - 1, page + 1))} type="button">다음</button>
                    </div>
                  </section>
                )}
                <p className="notice" role="status">{notice}</p>
              </section>
            )}
          </div>
          </>}
          </div>
        </section>
      )}

      {snapshot?.status === "waiting" && (
        <section className="lobbyLayout">
          <div className="lobbyInvite surface">
            <p className="kicker">교실 입장</p>
            <h1>휴대폰으로 QR을<br />스캔해 주세요</h1>
            <div className="qrFrame">
              {qrDataUrl ? (
                <Image
                  src={qrDataUrl}
                  alt={`방 코드 ${snapshot.roomCode} 입장 QR`}
                  width={280}
                  height={280}
                  unoptimized
                />
              ) : <div className="qrLoading">QR</div>}
            </div>
            <p className="roomCodeLabel">방 코드</p>
            <strong className="roomCode">{snapshot.roomCode}</strong>
            <p className="joinLink">{room?.qrUrl ?? `/join/${snapshot.roomCode}`}</p>
          </div>
          <div className="lobbyRoster surface">
            <div className="sectionHeading">
              <div><p className="kicker">참여 현황</p><h2>{snapshot.players.length}<small> / 30명</small></h2></div>
              <div className="characterBadge">{snapshot.character.char}</div>
            </div>
            <Scoreboard players={snapshot.players} />
            <button className="secondaryButton" onClick={closeWaitingRoom} type="button">폴더 선택으로 돌아가기</button>
            <button className="primaryButton" onClick={startGame} disabled={snapshot.players.length === 0} type="button">
              <span>{snapshot.players.length === 0 ? "학생을 기다리는 중" : snapshot.gameMode === "hanja_worm" ? "한자 지렁이 시작" : snapshot.gameMode === "meaning_sound_quiz" ? "스피드 퀴즈 시작" : "획 배틀 시작"}</span><span>→</span>
            </button>
            <p className="notice" role="status">{notice}</p>
          </div>
        </section>
      )}

      {snapshot?.status === "finished" && (
        <section className="teacherResultLayout surface" aria-live="polite">
          <div className="teacherResultHero">
            <div className="resultGlyph">{snapshot.character.char}</div>
            <p className="kicker">BATTLE COMPLETE</p>
            <h1>{"\uBAA8\uB450 \uD568\uAED8"}<br />{snapshot.gameMode === "hanja_worm" ? "도전을 마쳤어요" : "\uC644\uC131\uD588\uC5B4\uC694"}</h1>
            <p className="teacherResultSummary">
              {snapshot.characters.map((character) => character.char).join(" ")}{" \u00B7 "}{snapshot.players.length}{"\uBA85 \uCC38\uC5EC"}
            </p>
          </div>
          <div className="teacherResultBoard">
            <div className="sectionHeading compactHeading">
              <div>
                <p className="kicker">{"\uCD5C\uC885 \uC2A4\uCF54\uC5B4\uBCF4\uB4DC"}</p>
                <h2>{"\uD568\uAED8 \uC810\uC218\uB97C \uD655\uC778\uD558\uC138\uC694"}</h2>
              </div>
              <span className="curatedTag">{finalScorePlayers.length}{"\uBA85"}</span>
            </div>
            <Scoreboard players={finalScorePlayers} showRanks />
            <button className="secondaryButton" onClick={resetForNewGame} type="button">{"\uC0C8 \uAC8C\uC784 \uC900\uBE44"}</button>
          </div>
        </section>
      )}

      {snapshot?.status === "in_progress" && (
        <section className="battleLayout">
          <div className="battleMain surface">
            {snapshot.gameMode === "hanja_worm" ? <div className="battleHeader"><div><p className="kicker">각자의 속도로 한자 탐험</p><h1>한자 지렁이</h1></div><span>{snapshot.wormProgress?.filter((p) => p.finished).length ?? 0}/{snapshot.players.length}명 도전 종료</span></div> : snapshot.gameMode === "meaning_sound_quiz" && snapshot.quizProgress ? (
              <div className="battleHeader quizBattleHeader"><div><p className="kicker">각자의 속도로 도전</p><h1>스피드 퀴즈</h1></div><span>{snapshot.characters.length}문제</span></div>
            ) : <div className="battleHeader">
              <div><p className="kicker">{"\uC9C4\uD589 \uD55C\uC790 \u00B7 "}{snapshot.characterIndex + 1}/{snapshot.characters.length}</p><h1>{snapshot.character.char}</h1><div className="teacherCharacterReading"><b>{activeCharacterInfo.reading || "\uC74C"}</b><span>{activeCharacterInfo.meaning || activeCharacterInfo.baseLabel || "\uB73B"}</span></div></div>
              <div className="strokeCounter">
                <span>{snapshot.gameMode === "meaning_sound_quiz" ? "퀴즈" : "\uC9C4\uD589 \uD68D"}</span>
                <strong>
                  {snapshot.gameMode === "meaning_sound_quiz" && snapshot.quiz
                    ? snapshot.quiz.questionIndex + 1
                    : Math.min(snapshot.currentStrokeIndex + 1, snapshot.character.strokeData.length)}
                  <small>
                    {" / "}
                    {snapshot.gameMode === "meaning_sound_quiz" && snapshot.quiz
                      ? snapshot.quiz.totalQuestions
                      : snapshot.character.strokeData.length}
                  </small>
                </strong>
              </div>
            </div>}
            {snapshot.gameMode === "hanja_worm" ? <div className="teacherAnswerGrid" aria-label="학생별 한자 지렁이 진행">
              {snapshot.wormProgress?.map((progress) => {
                const player = snapshot.players.find((p) => p.id === progress.playerId);
                const total = snapshot.characters.reduce((sum, c) => sum + c.strokeCount, 0);
return <div key={progress.playerId} className={progress.finished ? "correct" : "pending"}><strong>{player?.nickname} <b>{player?.score}점</b></strong><span>{progress.eliminated ? "충돌 3회 · 도전 종료" : progress.finished ? "모두 완성!" : `${snapshot.characters[progress.characterIndex]?.char} · ${Math.floor(progress.targetIndex / 2) + 1}획 도전`}</span><progress max={total} value={progress.completedStrokes} /><small>{progress.completedStrokes}/{total}획 완성{player?.connected ? "" : " · 재연결 대기"}</small></div>;
              })}
            </div> : snapshot.gameMode === "meaning_sound_quiz" && snapshot.quiz ? (
              snapshot.quizProgress ? (
                <div className="teacherMiniGamePanel independentQuizPanel">
                  <div className="teacherQuizCounts">
                    <span>완료 {snapshot.quizProgress.filter((progress) => progress.phase === "finished").length}/{snapshot.players.length}명</span>
                    <span>진행 중 {snapshot.quizProgress.filter((progress) => progress.phase !== "finished").length}명</span>
                    <span>정답 후 바로 다음 문제</span>
                  </div>
                  <div className="teacherAnswerGrid" aria-label="학생별 퀴즈 응답 현황">
                    {snapshot.quizProgress.map((progress) => {
                      const player = snapshot.players.find((candidate) => candidate.id === progress.playerId);
                      const completed = progress.phase === "finished" ? progress.totalQuestions : progress.questionIndex;
                      const remaining = Math.max(0, Math.ceil((progress.questionEndsAt - nowMs) / 1000));
                      return (
                        <div className={progress.lastAnswer ? progress.lastAnswer.correct ? "correct" : "incorrect" : "pending"} key={progress.playerId}>
                          <strong>{player?.nickname} <b>{player?.score ?? 0}점</b></strong>
                          <span>{progress.phase === "finished" ? "모두 완료" : `${progress.questionIndex + 1}/${progress.totalQuestions}번 · ${progress.questionType === "hanja_choice" ? progress.promptHint : progress.promptChar} · ${progress.phase === "revealed" ? "다음 문제로" : `${remaining}초`}`}</span>
                          <progress aria-label={`${player?.nickname} 완료 문제`} max={progress.totalQuestions} value={completed} />
                          <small>{progress.lastAnswer ? `${progress.lastAnswer.questionIndex + 1}번 ${progress.lastAnswer.correct ? "정답 ✓" : "오답 / 시간 종료"} · ` : ""}정답 {progress.correctCount}개{player?.connected ? "" : " · 연결 끊김"}</small>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
              <div className="teacherMiniGamePanel">
                <div className="teacherQuizStatusBar">
                  <div className="quizTimer teacherQuizTimer" aria-label={`남은 시간 ${quizRemainingSeconds}초`}>
                    <div><strong>{quizRemainingSeconds}</strong><span>초</span></div>
                    <i style={{ width: quizProgressPercent + "%" }} />
                  </div>
                  <div className="teacherQuizCounts">
                    <span>완료 {quizFinalCount}/{snapshot.players.length}</span>
                    <span>정답 {quizCorrectCount}</span>
                    <span>대기 {Math.max(0, snapshot.players.length - quizFinalCount)}</span>
                  </div>
                </div>
                <div className="quizPromptCard">
                  <span>{quizQuestionType === "hanja_choice" ? snapshot.quiz.promptHint : snapshot.quiz.promptChar}</span>
                  <strong>{snapshot.quiz.phase === "revealed" ? "정답 공개" : `${quizQuestionTitle} · ${quizQuestionKind}`}</strong>
                  <p>{snapshot.quiz.phase === "revealed" ? snapshot.quiz.correctAnswer ?? snapshot.quiz.promptLabel : snapshot.quiz.promptHint ?? "학생들이 빠르게 풀고 있습니다."}</p>
                </div>
                {quizQuestionType.endsWith("_choice") ? (
                  <div className="quizChoiceGrid">
                    {snapshot.quiz.choices.map((choice, choiceIndex) => (
                      <div className={choice.id === snapshot.quiz?.correctChoiceId ? "correct" : ""} key={`${choice.id}-${choiceIndex}`}>
                        <strong>{choice.label}</strong>
                        <span>{choice.id === snapshot.quiz?.correctChoiceId ? "정답" : ""}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="quizPromptCard compactAnswerCard">
                    <strong>{snapshot.quiz.phase === "revealed" ? `정답: ${snapshot.quiz.correctAnswer}` : "주관식 입력 중"}</strong>
                  </div>
                )}
                <div className="teacherAnswerGrid" aria-label="학생별 퀴즈 응답 현황">
                  {snapshot.players.map((player, playerIndex) => {
                    const answer = quizAnswerByPlayer.get(player.id);
                    const choice = answer ? snapshot.quiz?.choices.find((candidate) => candidate.id === answer.choiceId) : undefined;
                    return (
                      <div className={answer ? answer.correct ? "correct" : "incorrect" : "pending"} key={`${player.id}-${playerIndex}`}>
                        <strong>{player.nickname}</strong>
                        <span>{answer ? answer.correct ? "정답" : answer.attemptNumber < 2 ? "재도전" : "오답" : "풀이 중"}</span>
                        <small>{answer?.answerText ?? choice?.label ?? "아직 답 없음"} · {answer?.attemptNumber ?? 0}/2회 · {player.score}점</small>
                      </div>
                    );
                  })}
                  {snapshot.players.length === 0 && <p className="emptyText">아직 입장한 학생이 없습니다.</p>}
                </div>
              </div>)
            ) : (
              <><div className="teacherTurnNotice" key={`${snapshot.selectedPlayerId}:${snapshot.strokeTurnStartedAt}`} role="status">
                <small>지금 쓰는 학생</small>
                <strong>{snapshot.players.find((player) => player.id === snapshot.selectedPlayerId)?.nickname ?? "다음 차례 준비 중"}</strong>
                <span className="teacherTurnClock" aria-label="현재 차례 남은 시간">{Math.ceil(Math.max(0, (snapshot.strokeTurnEndsAt ?? 0) - (nowMs || snapshot.strokeTurnStartedAt || 0)) / 1000)}초</span>
              </div><HanjaCanvas
                strokes={activeCharacter.strokeData}
                activeStrokeIndex={snapshot.currentStrokeIndex}
                completedCount={completedCount}
                canDraw={false}
                remoteProgress={remoteProgress}
                pathCoordinateSystem={activeCharacter.pathCoordinateSystem}
                label={activeCharacter.char + " \uC9C4\uD589 \uD604\uD669"}
                resetKey={snapshot.character.char + ":" + snapshot.characterIndex}
              /></>
            )}
          </div>
          <aside className="battleSide">
            <div className="surface sideCard">
              <p className="kicker">교사 제어</p>
              <h2>게임 중단</h2>
              <p className="sideHelpText">수업 상황상 멈춰야 할 때 학생 화면에 안내를 보내고 새 게임 준비로 돌아갑니다.</p>
              <button className="dangerButton" onClick={() => closeCurrentRoom(true)} type="button">게임 중단하고 준비로 돌아가기</button>
            </div>
            <div className="surface sideCard">
              <p className="kicker">{"\uC2E4\uC2DC\uAC04 \uC21C\uC704"}</p>
              <h2>{"\uC810\uC218 \uD604\uD669"}</h2>
              <Scoreboard
                players={snapshot.players}
                selectedPlayerId={snapshot.selectedPlayerId}
                showRanks
                animateChanges
              />
            </div>
            <div className="surface sideCard battleLog">
              <p className="kicker">{"\uBC30\uD2C0 \uB85C\uADF8"}</p>
              {logs.map((log) => <p className={log.tone} key={log.id}><span />{log.text}</p>)}
              {logs.length === 0 && <p className="neutral"><span />{"\uCCAB \uD68D\uC744 \uAE30\uB2E4\uB9AC\uACE0 \uC788\uC2B5\uB2C8\uB2E4."}</p>}
            </div>
          </aside>
        </section>
      )}
    </main>
  );
}
