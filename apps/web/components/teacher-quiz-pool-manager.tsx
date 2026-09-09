"use client";

import type { CharacterData, TeacherCharacterFolder, TeacherQuizPool, TeacherQuizPoolItem } from "@hanja/contracts";
import { useState } from "react";
import { splitHanjaLabel } from "@/lib/hanja-label";

interface Props {
  pools: TeacherQuizPool[];
  selectedPoolId: string;
  setPools: (pools: TeacherQuizPool[]) => void;
  setSelectedPoolId: (id: string) => void;
  savePools: (pools: TeacherQuizPool[]) => Promise<boolean>;
  folders: TeacherCharacterFolder[];
  activeFolderId: string;
  selectFolder: (id: string) => Promise<void>;
  characters: CharacterData[];
}

const MAX_POOL_CHARACTERS = 20;

function newPoolId(): string {
  return "quiz-" + (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : Date.now().toString(36));
}

export function TeacherQuizPoolManager(props: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("수업 폴더에서 문제로 사용할 한자를 고르세요.");
  const pool = props.pools.find((item) => item.id === props.selectedPoolId) ?? props.pools[0];

  function updatePool(change: (pool: TeacherQuizPool) => TeacherQuizPool) {
    if (!pool) return;
    props.setPools(props.pools.map((candidate) => candidate.id === pool.id ? change(candidate) : candidate));
  }

  async function createPool() {
    const nextPool: TeacherQuizPool = { id: newPoolId(), name: `퀴즈 문제풀 ${props.pools.length + 1}`, items: [] };
    const next = [...props.pools, nextPool];
    props.setPools(next);
    props.setSelectedPoolId(nextPool.id);
    if (await props.savePools(next)) setMessage("새 문제풀을 만들었습니다. 한자를 가져와 뜻을 자연스럽게 다듬어 주세요.");
  }

  async function deletePool() {
    if (!pool || !window.confirm(`${pool.name} 문제풀을 삭제할까요?`)) return;
    const next = props.pools.filter((candidate) => candidate.id !== pool.id);
    props.setPools(next);
    props.setSelectedPoolId(next[0]?.id ?? "");
    if (await props.savePools(next)) setMessage("문제풀을 삭제했습니다.");
  }

  async function saveCurrentPool() {
    if (!pool) return;
    setBusy(true);
    const saved = await props.savePools(props.pools);
    setBusy(false);
    setMessage(saved ? `“${pool.name}”을 저장했습니다.` : "문제풀을 저장하지 못했습니다. 연결 상태를 확인해 주세요.");
  }

  async function importSelectedFolderCharacters() {
    if (!pool || selected.length === 0) return;
    const currentChars = new Set(pool.items.map((item) => item.char));
    const additions = props.characters.flatMap((character): TeacherQuizPoolItem[] => {
      if (!selected.includes(character.char) || currentChars.has(character.char)) return [];
      const { meaning, reading } = splitHanjaLabel(character.label);
      return meaning && reading ? [{ char: character.char, meaning, reading }] : [];
    }).slice(0, Math.max(0, MAX_POOL_CHARACTERS - pool.items.length));
    const nextPools = props.pools.map((candidate) => candidate.id === pool.id ? { ...candidate, items: [...candidate.items, ...additions] } : candidate);
    props.setPools(nextPools);
    setSelected([]);
    setMessage(additions.length > 0 ? `${additions.length}자를 문제풀에 넣었습니다. 뜻과 음을 확인한 뒤 저장하세요.` : pool.items.length >= MAX_POOL_CHARACTERS ? "문제풀에는 한자를 최대 20자까지 넣을 수 있습니다." : "선택한 한자가 이미 문제풀에 있습니다.");
  }

  return (
    <section className="teacherSection quizPoolSection" aria-label="퀴즈 문제풀 관리">
      <div className="teacherSectionHeader">
        <div><p className="kicker">스피드 퀴즈</p><h2>퀴즈 문제풀을 정리하세요</h2></div>
        <button className="primaryButton" onClick={() => void createPool()} type="button">새 문제풀</button>
      </div>

      {props.pools.length === 0 || !pool ? (
        <div className="emptyQuizPool"><strong>아직 문제풀이 없습니다.</strong><span>새 문제풀을 만든 뒤 수업 폴더의 한자를 골라 넣으세요.</span></div>
      ) : (
        <>
          <div className="quizPoolToolbar">
            <select aria-label="퀴즈 문제풀 선택" onChange={(event) => props.setSelectedPoolId(event.target.value)} value={pool.id}>
              {props.pools.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} ({candidate.items.length}자)</option>)}
            </select>
            <input aria-label="문제풀 이름" maxLength={40} onChange={(event) => updatePool((current) => ({ ...current, name: event.target.value }))} value={pool.name} />
            <button className="dangerTextButton" onClick={() => void deletePool()} type="button">삭제</button>
          </div>

          <div className="quizPoolImportCard folderOnlyQuizImport">
              <div className="quizPoolFolderSourceHeader"><div><strong>수업 폴더에서 고르기</strong><span>폴더에 저장된 한자만 문제풀에 넣을 수 있습니다.</span></div>
              <select aria-label="가져올 수업 폴더" onChange={(event) => { setSelected([]); void props.selectFolder(event.target.value); }} value={props.activeFolderId}>
                {props.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              </select>
              <button className="primaryButton" disabled={selected.length === 0 || pool.items.length >= MAX_POOL_CHARACTERS} onClick={() => void importSelectedFolderCharacters()} type="button">선택 {selected.length}자 넣기</button></div>
              <div className="quizPoolFolderActions">
                <button className="secondaryButton" disabled={props.characters.length === 0} onClick={() => setSelected(props.characters.filter((character) => !pool.items.some((item) => item.char === character.char)).slice(0, Math.max(0, MAX_POOL_CHARACTERS - pool.items.length)).map((character) => character.char))} type="button">폴더 전체 선택</button>
                <button className="secondaryButton" disabled={selected.length === 0} onClick={() => setSelected([])} type="button">선택 비우기</button>
              </div>
              <div className="quizPoolMiniGrid" aria-label="수업 폴더 한자 선택">
                {props.characters.map((character) => {
                  const { meaning, reading } = splitHanjaLabel(character.label);
                  const checked = selected.includes(character.char);
                  const inPool = pool.items.some((item) => item.char === character.char);
                  const selectionFull = pool.items.length + selected.length >= MAX_POOL_CHARACTERS;
                  return <label className={checked ? "selected" : ""} key={character.char}><input checked={checked} disabled={inPool || (!checked && selectionFull)} onChange={() => setSelected((current) => current.includes(character.char) ? current.filter((char) => char !== character.char) : [...current, character.char])} type="checkbox" /><b>{character.char}</b><span>{meaning}</span><small>{inPool ? "추가됨" : reading}</small></label>;
                })}
                {props.characters.length === 0 && <p>이 수업 폴더에는 한자가 없습니다.</p>}
              </div>
          </div>

          <div className="quizPoolEditorHeader"><div><strong>{pool.items.length}자 · 기본 {pool.items.length}문제</strong><span>게임에 표시할 자연스러운 뜻과 정확한 음을 수정하세요.</span></div><button className="primaryButton" disabled={busy || !pool.name.trim()} onClick={() => void saveCurrentPool()} type="button">{busy ? "저장 중" : "문제풀 저장"}</button></div>
          <div className="quizPoolEditor" aria-label="문제풀 한자 편집">
            {pool.items.map((item) => (
              <div className="quizPoolRow" key={item.char}>
                <b>{item.char}</b>
                <label><span>뜻</span><input aria-label={`${item.char} 뜻`} maxLength={30} onChange={(event) => updatePool((current) => ({ ...current, items: current.items.map((candidate) => candidate.char === item.char ? { ...candidate, meaning: event.target.value } : candidate) }))} value={item.meaning} /></label>
                <label><span>음</span><input aria-label={`${item.char} 음`} maxLength={10} onChange={(event) => updatePool((current) => ({ ...current, items: current.items.map((candidate) => candidate.char === item.char ? { ...candidate, reading: event.target.value } : candidate) }))} value={item.reading} /></label>
                <button aria-label={`${item.char} 문제풀에서 삭제`} onClick={() => updatePool((current) => ({ ...current, items: current.items.filter((candidate) => candidate.char !== item.char) }))} type="button">×</button>
              </div>
            ))}
            {pool.items.length === 0 && <p>가져온 한자가 없습니다.</p>}
          </div>
        </>
      )}
      <p className="notice" role="status">{message}</p>
    </section>
  );
}
