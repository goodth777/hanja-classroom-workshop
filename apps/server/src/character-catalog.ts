import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type {
  CharacterCatalogEntry,
  CharacterCatalogSearchResponse,
  CharacterData,
} from "@hanja/contracts";
import {
  createHanziWriterCharacter,
  CURATED_CHARACTERS,
  type HanziWriterCharacterSource,
} from "@hanja/stroke-engine";

const require = createRequire(import.meta.url);
const dataDirectory = dirname(require.resolve("hanzi-writer-data/package.json"));
const availableCharacters = new Set(
  readdirSync(dataDirectory)
    .filter((filename) => filename.endsWith(".json"))
    .map((filename) => filename.slice(0, -5)),
);
const verifiedCharacters = new Map(
  CURATED_CHARACTERS.map((character) => [character.char, character]),
);
const HAN_CHARACTER = /^\p{Script=Han}$/u;
const MAX_QUERY_CHARACTERS = 20;
const MAX_SOUND_QUERY_RESULTS = 80;
const HANGUL_SOUND_QUERY = /^[\uAC00-\uD7A3]{1,12}$/u;
const koreanLabelByCharacter = (() => {
  const candidates = [
    new URL("./data/hanja-korean.json", import.meta.url),
    new URL("../src/data/hanja-korean.json", import.meta.url),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) return {};
  return JSON.parse(readFileSync(source, "utf8")) as Record<string, string>;
})();

export function koreanLabelFor(char: string): string | undefined {
  const label = koreanLabelByCharacter[char]?.trim();
  return label || undefined;
}

function catalogAvailabilityRank(char: string): number {
  if (verifiedCharacters.has(char)) return 0;
  if (availableCharacters.has(char)) return 1;
  return 2;
}

function firstCodePoint(char: string): number {
  return char.codePointAt(0) ?? 0;
}

function koreanSoundMatchRank(label: string, sound: string): number | undefined {
  let bestRank: number | undefined;
  for (const segment of label.split(",")) {
    const pieces = segment.trim().split(/\s+/u).filter(Boolean);
    const rawReading = pieces.at(-1) ?? "";
    const readings: string[] = rawReading.match(/[\uAC00-\uD7A3]+/gu) ?? [];
    let rank: number | undefined;
    if (readings[0] === sound) rank = 0;
    else if (readings.includes(sound)) rank = 1;
    else if (readings[0]?.startsWith(sound)) rank = 2;
    else if (readings.some((reading) => reading.startsWith(sound))) rank = 3;
    if (rank !== undefined && (bestRank === undefined || rank < bestRank)) bestRank = rank;
  }
  return bestRank;
}

function sortKoreanSoundMatches(chars: string[]): string[] {
  return [...chars].sort((left, right) => {
    const availability = catalogAvailabilityRank(left) - catalogAvailabilityRank(right);
    if (availability !== 0) return availability;
    return firstCodePoint(left) - firstCodePoint(right);
  });
}

function searchCharactersByKoreanSound(sound: string): string[] {
  const buckets: string[][] = [[], [], [], []];
  for (const [char, label] of Object.entries(koreanLabelByCharacter)) {
    const rank = koreanSoundMatchRank(label, sound);
    if (rank !== undefined) buckets[rank]!.push(char);
  }
  return buckets.flatMap(sortKoreanSoundMatches).slice(0, MAX_SOUND_QUERY_RESULTS);
}

function strokeCountFor(char: string): number | undefined {
  if (!availableCharacters.has(char)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(join(dataDirectory, `${char}.json`), "utf8")) as {
      strokes?: unknown[];
    };
    return Array.isArray(raw.strokes) ? raw.strokes.length : undefined;
  } catch {
    return undefined;
  }
}

function readCharacterSource(char: string): HanziWriterCharacterSource | undefined {
  if (!availableCharacters.has(char)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(join(dataDirectory, `${char}.json`), "utf8")) as {
      strokes?: string[];
      medians?: number[][][];
    };
    if (!Array.isArray(raw.strokes) || !Array.isArray(raw.medians)) return undefined;
    return { strokes: raw.strokes, medians: raw.medians };
  } catch {
    return undefined;
  }
}

export function searchableHanziCount(): number {
  return availableCharacters.size;
}

export function isSystemVerifiedCharacter(char: string): boolean {
  return verifiedCharacters.has(char);
}

export function loadCatalogCharacter(char: string, label?: string): CharacterData | undefined {
  const verified = verifiedCharacters.get(char);
  if (verified) return { ...structuredClone(verified), label: label?.trim() || verified.label };
  const source = readCharacterSource(char);
  if (!source) return undefined;
  const strokeCount = source.strokes.length;
  return createHanziWriterCharacter(
    char,
    label?.trim() || `${char} · 교사 확인 필요 · ${strokeCount}획`,
    source,
  );
}

export function searchCharacterCatalog(rawQuery: unknown): CharacterCatalogSearchResponse {
  const query = typeof rawQuery === "string" ? rawQuery.normalize("NFC").trim() : "";
  const hanChars = [...new Set(Array.from(query).filter((char) => HAN_CHARACTER.test(char)))];
  const chars = hanChars.length > 0
    ? hanChars.slice(0, MAX_QUERY_CHARACTERS)
    : HANGUL_SOUND_QUERY.test(query)
      ? searchCharactersByKoreanSound(query)
      : [];
  const entries: CharacterCatalogEntry[] = chars.map((char) => {
    const suggestedLabel = koreanLabelFor(char);
    const verified = verifiedCharacters.get(char);
    if (verified) {
      return {
        char,
        status: "verified",
        label: verified.label,
        suggestedLabel,
        strokeCount: verified.strokeData.length,
      };
    }
    if (availableCharacters.has(char)) {
      return {
        char,
        status: "available_unverified",
        suggestedLabel,
        strokeCount: strokeCountFor(char),
      };
    }
    return { char, status: "unavailable", suggestedLabel };
  });
  return { query, availableDataCount: searchableHanziCount(), entries };
}
