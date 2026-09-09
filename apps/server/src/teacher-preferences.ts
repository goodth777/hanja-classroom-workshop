import type {
  CharacterData,
  TeacherCharacterApproval,
  TeacherCharacterFolder,
  TeacherCharacterPreferences,
  TeacherCharacterPreferencesResponse,
  TeacherQuizPool,
} from "@hanja/contracts";
import { CURATED_CHARACTERS } from "@hanja/stroke-engine";
import { loadCatalogCharacter } from "./character-catalog.js";
import { supabaseServiceHeaders } from "./supabase-headers.js";

const DEFAULT_ORDER = CURATED_CHARACTERS.map((character) => character.char);
export const DEFAULT_FOLDER_ID = "default";
const DEFAULT_FOLDER_NAME = "기본 한자";
const LEGACY_FOLDERS_KEY = "__hanja_folders";
const QUIZ_POOLS_KEY = "__hanja_quiz_pools";


export interface TeacherPreferencesStore {
  get(teacherId: string): Promise<TeacherCharacterPreferences>;
  saveOrder(teacherId: string, orderedChars: string[]): Promise<TeacherCharacterPreferences>;
  saveFolders(
    teacherId: string,
    folders: TeacherCharacterFolder[],
    activeFolderId: string,
  ): Promise<TeacherCharacterPreferences>;
  saveQuizPools(teacherId: string, quizPools: TeacherQuizPool[]): Promise<TeacherCharacterPreferences>;
  approve(
    teacherId: string,
    approval: TeacherCharacterApproval,
    folderId?: string,
  ): Promise<TeacherCharacterPreferences>;
}

function clonePreferences(value: TeacherCharacterPreferences): TeacherCharacterPreferences {
  return structuredClone(value);
}

function defaultFolder(orderedChars = DEFAULT_ORDER): TeacherCharacterFolder {
  return { id: DEFAULT_FOLDER_ID, name: DEFAULT_FOLDER_NAME, orderedChars: [...orderedChars] };
}

function defaultPreferences(): TeacherCharacterPreferences {
  const folder = defaultFolder();
  return {
    orderedChars: [...folder.orderedChars],
    folders: [folder],
    activeFolderId: folder.id,
    approvals: [],
    quizPools: [],
  };
}

function normalizeFolders(folders: TeacherCharacterFolder[]): TeacherCharacterFolder[] {
  const safeFolders = folders.length > 0 ? structuredClone(folders) : [];
  const defaultIndex = safeFolders.findIndex((folder) => folder.id === DEFAULT_FOLDER_ID);
  if (defaultIndex < 0) return [defaultFolder(), ...safeFolders];
  const defaultEntry = safeFolders[defaultIndex]!;
  safeFolders[defaultIndex] = {
    ...defaultEntry,
    name: defaultEntry.name.trim() || DEFAULT_FOLDER_NAME,
    orderedChars: defaultEntry.orderedChars.length > 0 ? defaultEntry.orderedChars : [...DEFAULT_ORDER],
  };
  return safeFolders;
}

function preferenceScore(preferences: TeacherCharacterPreferences): number {
  const customFolderScore = preferences.folders.some((folder) => folder.id !== DEFAULT_FOLDER_ID) ? 100_000 : 0;
  const folderScore = preferences.folders.length * 10_000;
  const approvalScore = preferences.approvals.length * 1_000;
  const characterScore = preferences.folders.reduce((total, folder) => total + folder.orderedChars.length, 0);
  const quizPoolScore = preferences.quizPools.reduce((total, pool) => total + 5_000 + pool.items.length * 100, 0);
  return customFolderScore + folderScore + approvalScore + characterScore + quizPoolScore;
}

function richerPreferences(
  first: TeacherCharacterPreferences,
  second: TeacherCharacterPreferences,
): TeacherCharacterPreferences {
  return preferenceScore(first) >= preferenceScore(second) ? first : second;
}

function withActiveOrder(
  folders: TeacherCharacterFolder[],
  activeFolderId: string,
  approvals: TeacherCharacterApproval[],
  quizPools: TeacherQuizPool[] = [],
): TeacherCharacterPreferences {
  const safeFolders = normalizeFolders(folders);
  const activeFolder = safeFolders.find((folder) => folder.id === activeFolderId) ?? safeFolders[0]!;
  return {
    orderedChars: [...activeFolder.orderedChars],
    folders: safeFolders,
    activeFolderId: activeFolder.id,
    approvals: structuredClone(approvals),
    quizPools: structuredClone(quizPools),
  };
}

export class MemoryTeacherPreferencesStore implements TeacherPreferencesStore {
  private readonly values = new Map<string, TeacherCharacterPreferences>();

  remember(teacherId: string, preferences: TeacherCharacterPreferences): void {
    this.values.set(teacherId, clonePreferences(preferences));
  }

  async get(teacherId: string): Promise<TeacherCharacterPreferences> {
    return clonePreferences(this.values.get(teacherId) ?? defaultPreferences());
  }

  async saveOrder(
    teacherId: string,
    orderedChars: string[],
  ): Promise<TeacherCharacterPreferences> {
    const current = await this.get(teacherId);
    const folders = current.folders.map((folder) =>
      folder.id === current.activeFolderId ? { ...folder, orderedChars: [...orderedChars] } : folder,
    );
    return this.saveFolders(teacherId, folders, current.activeFolderId);
  }

  async saveFolders(
    teacherId: string,
    folders: TeacherCharacterFolder[],
    activeFolderId: string,
  ): Promise<TeacherCharacterPreferences> {
    const current = await this.get(teacherId);
    const next = withActiveOrder(folders, activeFolderId, current.approvals, current.quizPools);
    this.values.set(teacherId, clonePreferences(next));
    return next;
  }

  async saveQuizPools(
    teacherId: string,
    quizPools: TeacherQuizPool[],
  ): Promise<TeacherCharacterPreferences> {
    const current = await this.get(teacherId);
    const next = withActiveOrder(current.folders, current.activeFolderId, current.approvals, quizPools);
    this.values.set(teacherId, clonePreferences(next));
    return next;
  }

  async approve(
    teacherId: string,
    approval: TeacherCharacterApproval,
    folderId?: string,
  ): Promise<TeacherCharacterPreferences> {
    const current = await this.get(teacherId);
    const targetFolderId = current.folders.some((folder) => folder.id === folderId)
      ? folderId!
      : current.activeFolderId;
    const approvals = [
      ...current.approvals.filter((item) => item.char !== approval.char),
      approval,
    ];
    const folders = current.folders.map((folder) =>
      folder.id === targetFolderId && !folder.orderedChars.includes(approval.char)
        ? { ...folder, orderedChars: [...folder.orderedChars, approval.char] }
        : folder,
    );
    const next = withActiveOrder(folders, targetFolderId, approvals, current.quizPools);
    this.values.set(teacherId, clonePreferences(next));
    return next;
  }
}

interface PreferenceRow {
  ordered_chars?: unknown;
  approved_characters?: unknown;
  folders?: unknown;
  active_folder_id?: unknown;
}

function parseFolders(raw: unknown, legacyOrder: string[]): TeacherCharacterFolder[] {
  if (!Array.isArray(raw)) return [defaultFolder(legacyOrder)];
  const folders = raw.flatMap((item): TeacherCharacterFolder[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as { id?: unknown; name?: unknown; orderedChars?: unknown };
    if (
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      !Array.isArray(value.orderedChars)
    ) return [];
    return [{
      id: value.id,
      name: value.name,
      orderedChars: value.orderedChars.filter((char): char is string => typeof char === "string"),
    }];
  });
  return folders.length > 0 ? folders : [defaultFolder(legacyOrder)];
}

function parseLegacyFolderSnapshot(approvedObject: Record<string, unknown>): {
  folders?: unknown;
  activeFolderId?: unknown;
} {
  const raw = approvedObject[LEGACY_FOLDERS_KEY];
  return raw && typeof raw === "object" ? raw as { folders?: unknown; activeFolderId?: unknown } : {};
}

function parseQuizPools(raw: unknown): TeacherQuizPool[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): TeacherQuizPool[] => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as { id?: unknown; name?: unknown; items?: unknown };
    if (typeof value.id !== "string" || typeof value.name !== "string" || !Array.isArray(value.items)) return [];
    const items = value.items.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as { char?: unknown; meaning?: unknown; reading?: unknown };
      return typeof candidate.char === "string" && typeof candidate.meaning === "string" && typeof candidate.reading === "string"
        ? [{ char: candidate.char, meaning: candidate.meaning, reading: candidate.reading }]
        : [];
    });
    return [{ id: value.id, name: value.name, items }];
  });
}

function approvalsFromObject(approvedObject: Record<string, unknown>): TeacherCharacterApproval[] {
  return Object.entries(approvedObject).flatMap(([char, raw]) => {
    if (char.startsWith("__hanja_") || !raw || typeof raw !== "object") return [];
    const value = raw as { label?: unknown; approvedAt?: unknown };
    if (typeof value.label !== "string" || typeof value.approvedAt !== "string") return [];
    return [{ char, label: value.label, approvedAt: value.approvedAt }];
  });
}


export class SupabaseTeacherPreferencesStore implements TeacherPreferencesStore {
  private folderColumnsAvailable: boolean | null = null;

  constructor(
    private readonly url: string,
    private readonly serviceRoleKey: string,
  ) {}

  private headers(prefer?: string): Record<string, string> {
    return {
      ...supabaseServiceHeaders(this.serviceRoleKey),
      ...(prefer ? { prefer } : {}),
    };
  }

  private endpoint(path: string): string {
    return this.url.replace(/\/$/, "") + path;
  }

  private async isMissingFolderColumn(response: Response): Promise<boolean> {
    if (response.status !== 400 && response.status !== 404) return false;
    const text = await response.text().catch(() => "");
    return /folders|active_folder_id|schema cache|PGRST204|column/i.test(text);
  }

  private async readRows(
    teacherId: string,
    includeFolders: boolean,
  ): Promise<PreferenceRow[]> {
    const query = new URLSearchParams({
      teacher_id: "eq." + teacherId,
      select: includeFolders
        ? "ordered_chars,approved_characters,folders,active_folder_id"
        : "ordered_chars,approved_characters",
      limit: "1",
    });
    const response = await fetch(
      this.endpoint("/rest/v1/teacher_character_preferences?") + query,
      { headers: this.headers() },
    );
    if (!response.ok) {
      if (includeFolders && await this.isMissingFolderColumn(response)) {
        this.folderColumnsAvailable = false;
        return this.readRows(teacherId, false);
      }
      throw new Error("Supabase preferences read failed with " + response.status);
    }
    if (includeFolders) this.folderColumnsAvailable = true;
    return (await response.json()) as PreferenceRow[];
  }

  async get(teacherId: string): Promise<TeacherCharacterPreferences> {
    const rows = await this.readRows(teacherId, this.folderColumnsAvailable !== false);
    const row = rows[0];
    if (!row) return defaultPreferences();
    const legacyOrder = Array.isArray(row.ordered_chars)
      ? row.ordered_chars.filter((char): char is string => typeof char === "string")
      : [...DEFAULT_ORDER];
    const approvedObject =
      row.approved_characters && typeof row.approved_characters === "object"
        ? (row.approved_characters as Record<string, unknown>)
        : {};
    const approvals = approvalsFromObject(approvedObject);
    const legacySnapshot = parseLegacyFolderSnapshot(approvedObject);
    const quizPools = parseQuizPools(approvedObject[QUIZ_POOLS_KEY]);
    const folders = parseFolders(row.folders ?? legacySnapshot.folders, legacyOrder);
    const activeFolderId =
      typeof row.active_folder_id === "string"
        ? row.active_folder_id
        : typeof legacySnapshot.activeFolderId === "string"
          ? legacySnapshot.activeFolderId
          : folders[0]!.id;
    return withActiveOrder(folders, activeFolderId, approvals, quizPools);
  }

  private approvalObject(
    preferences: TeacherCharacterPreferences,
    includeFolderSnapshot = false,
  ): Record<string, unknown> {
    const approvedCharacters = Object.fromEntries(
      preferences.approvals.map(({ char, label, approvedAt }) => [
        char,
        { label, approvedAt },
      ]),
    );
    if (!includeFolderSnapshot) return approvedCharacters;
    return {
      ...approvedCharacters,
      [LEGACY_FOLDERS_KEY]: {
        folders: preferences.folders,
        activeFolderId: preferences.activeFolderId,
      },
      [QUIZ_POOLS_KEY]: preferences.quizPools,
    };
  }

  private async upsertLegacy(
    teacherId: string,
    preferences: TeacherCharacterPreferences,
  ): Promise<void> {
    const response = await fetch(
      this.endpoint("/rest/v1/teacher_character_preferences?on_conflict=teacher_id"),
      {
        method: "POST",
        headers: this.headers("resolution=merge-duplicates,return=minimal"),
        body: JSON.stringify({
          teacher_id: teacherId,
          ordered_chars: preferences.orderedChars,
          approved_characters: this.approvalObject(preferences, true),
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!response.ok) throw new Error("Supabase legacy preferences write failed with " + response.status);
  }

  private async upsert(
    teacherId: string,
    preferences: TeacherCharacterPreferences,
  ): Promise<void> {
    if (this.folderColumnsAvailable === false) {
      await this.upsertLegacy(teacherId, preferences);
      return;
    }
    const response = await fetch(
      this.endpoint("/rest/v1/teacher_character_preferences?on_conflict=teacher_id"),
      {
        method: "POST",
        headers: this.headers("resolution=merge-duplicates,return=minimal"),
        body: JSON.stringify({
          teacher_id: teacherId,
          ordered_chars: preferences.orderedChars,
          approved_characters: this.approvalObject(preferences, true),
          folders: preferences.folders,
          active_folder_id: preferences.activeFolderId,
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!response.ok) {
      const missingFolderColumn = await this.isMissingFolderColumn(response);
      this.folderColumnsAvailable = false;
      try {
        await this.upsertLegacy(teacherId, preferences);
        return;
      } catch (fallbackError) {
        if (missingFolderColumn) throw fallbackError;
        throw new Error("Supabase preferences write failed with " + response.status);
      }
    }
    this.folderColumnsAvailable = true;
  }

  async saveOrder(
    teacherId: string,
    orderedChars: string[],
  ): Promise<TeacherCharacterPreferences> {
    const current = await this.get(teacherId);
    const folders = current.folders.map((folder) =>
      folder.id === current.activeFolderId ? { ...folder, orderedChars: [...orderedChars] } : folder,
    );
    return this.saveFolders(teacherId, folders, current.activeFolderId);
  }

  async saveFolders(
    teacherId: string,
    folders: TeacherCharacterFolder[],
    activeFolderId: string,
  ): Promise<TeacherCharacterPreferences> {
    let approvals: TeacherCharacterApproval[] = [];
    let quizPools: TeacherQuizPool[] = [];
    try {
      const current = await this.get(teacherId);
      approvals = current.approvals;
      quizPools = current.quizPools;
    } catch (error) {
      console.warn("Supabase preferences read failed before folder save; continuing with empty approvals.", error);
    }
    const next = withActiveOrder(folders, activeFolderId, approvals, quizPools);
    await this.upsert(teacherId, next);
    return next;
  }

  async saveQuizPools(
    teacherId: string,
    quizPools: TeacherQuizPool[],
  ): Promise<TeacherCharacterPreferences> {
    const current = await this.get(teacherId);
    const next = withActiveOrder(current.folders, current.activeFolderId, current.approvals, quizPools);
    await this.upsert(teacherId, next);
    return next;
  }

  async approve(
    teacherId: string,
    approval: TeacherCharacterApproval,
    folderId?: string,
  ): Promise<TeacherCharacterPreferences> {
    const current = await this.get(teacherId);
    const targetFolderId = current.folders.some((folder) => folder.id === folderId)
      ? folderId!
      : current.activeFolderId;
    const next = withActiveOrder(
      current.folders.map((folder) =>
        folder.id === targetFolderId && !folder.orderedChars.includes(approval.char)
          ? { ...folder, orderedChars: [...folder.orderedChars, approval.char] }
          : folder,
      ),
      targetFolderId,
      [
        ...current.approvals.filter((item) => item.char !== approval.char),
        approval,
      ],
      current.quizPools,
    );
    await this.upsert(teacherId, next);
    return next;
  }
}
export class FailoverTeacherPreferencesStore implements TeacherPreferencesStore {
  private readonly fallback = new MemoryTeacherPreferencesStore();

  constructor(private readonly primary: TeacherPreferencesStore) {}

  private warn(operation: string, error: unknown) {
    console.warn(
      `Primary teacher preferences ${operation} failed; using in-memory failover.`,
      error,
    );
  }

  private async fallbackSnapshot(teacherId: string): Promise<TeacherCharacterPreferences> {
    return this.fallback.get(teacherId);
  }

  private async rememberFallback(
    teacherId: string,
    preferences: TeacherCharacterPreferences,
  ): Promise<TeacherCharacterPreferences> {
    this.fallback.remember(teacherId, preferences);
    return this.fallback.get(teacherId);
  }

  async saveQuizPools(
    teacherId: string,
    quizPools: TeacherQuizPool[],
  ): Promise<TeacherCharacterPreferences> {
    const current = await this.get(teacherId);
    this.fallback.remember(teacherId, current);
    const fallback = await this.fallback.saveQuizPools(teacherId, quizPools);
    try {
      const primary = await this.primary.saveQuizPools(teacherId, quizPools);
      return richerPreferences(primary, fallback);
    } catch (error) {
      this.warn("quiz pool write", error);
      return fallback;
    }
  }

  async get(teacherId: string): Promise<TeacherCharacterPreferences> {
    let fallback = await this.fallbackSnapshot(teacherId);
    try {
      const primary = await this.primary.get(teacherId);
      const richer = richerPreferences(primary, fallback);
      if (richer === primary) fallback = await this.rememberFallback(teacherId, primary);
      return richerPreferences(richer, fallback);
    } catch (error) {
      this.warn("read", error);
      return fallback;
    }
  }

  async saveOrder(
    teacherId: string,
    orderedChars: string[],
  ): Promise<TeacherCharacterPreferences> {
    const current = await this.get(teacherId);
    const folders = current.folders.map((folder) =>
      folder.id === current.activeFolderId ? { ...folder, orderedChars: [...orderedChars] } : folder,
    );
    return this.saveFolders(teacherId, folders, current.activeFolderId);
  }

  async saveFolders(
    teacherId: string,
    folders: TeacherCharacterFolder[],
    activeFolderId: string,
  ): Promise<TeacherCharacterPreferences> {
    const current = await this.get(teacherId);
    this.fallback.remember(teacherId, current);
    const fallback = await this.fallback.saveFolders(teacherId, folders, activeFolderId);
    try {
      const primary = await this.primary.saveFolders(teacherId, fallback.folders, fallback.activeFolderId);
      return richerPreferences(primary, fallback);
    } catch (error) {
      this.warn("folder write", error);
      return fallback;
    }
  }

  async approve(
    teacherId: string,
    approval: TeacherCharacterApproval,
    folderId?: string,
  ): Promise<TeacherCharacterPreferences> {
    const current = await this.get(teacherId);
    this.fallback.remember(teacherId, current);
    const fallback = await this.fallback.approve(teacherId, approval, folderId);
    try {
      await this.primary.approve(teacherId, approval, folderId);
      await this.primary.saveFolders(teacherId, fallback.folders, fallback.activeFolderId);
    } catch (error) {
      this.warn("approval write", error);
    }
    return fallback;
  }
}

export function createTeacherPreferencesStore(
  environment: NodeJS.ProcessEnv = process.env,
): TeacherPreferencesStore {
  const url = environment.SUPABASE_URL;
  const key = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    return new FailoverTeacherPreferencesStore(new SupabaseTeacherPreferencesStore(url, key));
  }
  if (environment.NODE_ENV === "production") {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production");
  }
  return new MemoryTeacherPreferencesStore();
}

export function resolveTeacherCharacters(
  preferences: TeacherCharacterPreferences,
): TeacherCharacterPreferencesResponse {
  const approvals = new Map(preferences.approvals.map((approval) => [approval.char, approval]));
  const activeFolder =
    preferences.folders.find((folder) => folder.id === preferences.activeFolderId) ??
    preferences.folders[0];
  const orderedChars = activeFolder?.orderedChars ?? preferences.orderedChars;
  const characters = orderedChars.flatMap((char): CharacterData[] => {
    const approval = approvals.get(char);
    const character = loadCatalogCharacter(char, approval?.label);
    if (!character) return [];
    if (!CURATED_CHARACTERS.some((item) => item.char === char) && !approval) return [];
    return [character];
  });
  const safeFolders = preferences.folders.map((folder) =>
    folder.id === preferences.activeFolderId
      ? { ...folder, orderedChars: characters.map((character) => character.char) }
      : folder,
  );
  const safePreferences = withActiveOrder(
    safeFolders,
    preferences.activeFolderId,
    preferences.approvals,
    preferences.quizPools,
  );
  return { preferences: safePreferences, characters };
}
