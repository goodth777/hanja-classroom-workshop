import type { CharacterData } from "@hanja/contracts";
import woodData from "hanzi-writer-data/木.json" with { type: "json" };
import waterData from "hanzi-writer-data/水.json" with { type: "json" };
import personData from "hanzi-writer-data/人.json" with { type: "json" };
import tenData from "hanzi-writer-data/十.json" with { type: "json" };
import oneData from "hanzi-writer-data/一.json" with { type: "json" };
import twoData from "hanzi-writer-data/二.json" with { type: "json" };
import threeData from "hanzi-writer-data/三.json" with { type: "json" };
import fourData from "hanzi-writer-data/四.json" with { type: "json" };
import fiveData from "hanzi-writer-data/五.json" with { type: "json" };
import sixData from "hanzi-writer-data/六.json" with { type: "json" };
import sevenData from "hanzi-writer-data/七.json" with { type: "json" };
import eightData from "hanzi-writer-data/八.json" with { type: "json" };
import nineData from "hanzi-writer-data/九.json" with { type: "json" };
import sunData from "hanzi-writer-data/日.json" with { type: "json" };
import moonData from "hanzi-writer-data/月.json" with { type: "json" };
import mountainData from "hanzi-writer-data/山.json" with { type: "json" };
import fireData from "hanzi-writer-data/火.json" with { type: "json" };
import mouthData from "hanzi-writer-data/口.json" with { type: "json" };
import bigData from "hanzi-writer-data/大.json" with { type: "json" };
import smallData from "hanzi-writer-data/小.json" with { type: "json" };
import { createHanziWriterCharacter } from "./hanzi-writer.js";

export const CURATED_CHARACTERS: CharacterData[] = [
  createHanziWriterCharacter("木", "목(나무 목) · 4획", woodData),
  createHanziWriterCharacter("水", "수(물 수) · 4획", waterData),
  createHanziWriterCharacter("人", "인(사람 인) · 2획", personData),
  createHanziWriterCharacter("十", "십(열 십) · 2획", tenData),
  createHanziWriterCharacter("一", "일(한 일) · 1획", oneData),
  createHanziWriterCharacter("二", "이(두 이) · 2획", twoData),
  createHanziWriterCharacter("三", "삼(석 삼) · 3획", threeData),
  createHanziWriterCharacter("四", "사(넉 사) · 5획", fourData),
  createHanziWriterCharacter("五", "오(다섯 오) · 4획", fiveData),
  createHanziWriterCharacter("六", "육(여섯 육) · 4획", sixData),
  createHanziWriterCharacter("七", "칠(일곱 칠) · 2획", sevenData),
  createHanziWriterCharacter("八", "팔(여덟 팔) · 2획", eightData),
  createHanziWriterCharacter("九", "구(아홉 구) · 2획", nineData),
  createHanziWriterCharacter("日", "일(날 일) · 4획", sunData),
  createHanziWriterCharacter("月", "월(달 월) · 4획", moonData),
  createHanziWriterCharacter("山", "산(메 산) · 3획", mountainData),
  createHanziWriterCharacter("火", "화(불 화) · 4획", fireData),
  createHanziWriterCharacter("口", "구(입 구) · 3획", mouthData),
  createHanziWriterCharacter("大", "대(큰 대) · 3획", bigData),
  createHanziWriterCharacter("小", "소(작을 소) · 3획", smallData),
];

export function getCuratedCharacter(char: string): CharacterData | undefined {
  return CURATED_CHARACTERS.find((candidate) => candidate.char === char);
}
