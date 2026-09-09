"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Point, RoomSnapshot } from "@hanja/contracts";
import { splitHanjaLabel } from "@/lib/hanja-label";

interface Props {
  snapshot: RoomSnapshot;
  connected: boolean;
  score: number;
  rank: ReactNode;
  reachTarget: (point: Point) => Promise<boolean>;
  reportHit: (hitNumber: number) => Promise<boolean>;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (n: number) => Math.max(0.025, Math.min(0.975, n));

export function HanjaWorm({ snapshot, connected, score, rank, reachTarget, reportHit }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const direction = useRef<Point>({ x: 0, y: 0 });
  const latest = useRef({ snapshot, connected, reachTarget, reportHit });
  const [hint, setHint] = useState("아래 조이스틱으로 반짝이는 점까지!");
  const [stick, setStick] = useState<Point>({ x: 0, y: 0 });
  useEffect(() => { latest.current = { snapshot, connected, reachTarget, reportHit }; }, [snapshot, connected, reachTarget, reportHit]);
  // Parent keys this scene by character, so progress ACKs do not reset movement.
  const [character] = useState(snapshot.character);
  const progress = snapshot.worm!;
  const reading = splitHanjaLabel(character.label);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const paths = character.strokeData.map((s) => s.svgPath ? new Path2D(s.svgPath) : null);
    const head = { x: 0.5, y: 0.91 };
    const body = Array.from({ length: 10 }, (_, i) => ({ x: head.x, y: head.y + i * 0.003 }));
    let bugs: Point[] = [];
    let frame = 0, last = 0, immuneUntil = 0, burstAt = -5000, pending = false, retryAt = 0;
    let alive = true, transitioning = false, oldTarget = latest.current.snapshot.worm?.targetIndex ?? 0;
    let completedPreview: number | null = null;
    let localHits = latest.current.snapshot.worm?.hits ?? 0, hitPending = false, hitRetryAt = 0;
    let particles: Array<Point & { vx: number; vy: number; color: string }> = [];
    let poppedBugs: Point[] = [];
    let heading = -Math.PI / 2;
    let oldConnected = true;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const circle = (x: number, y: number, r: number, fill: string) => {
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
    };
    const clearDirection = () => { direction.current = { x: 0, y: 0 }; setStick({ x: 0, y: 0 }); };
    const keys = new Set<string>();
    const key = (event: KeyboardEvent) => {
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      if (event.type === "keydown") keys.add(event.key); else keys.delete(event.key);
      direction.current = { x: Number(keys.has("ArrowRight")) - Number(keys.has("ArrowLeft")), y: Number(keys.has("ArrowDown")) - Number(keys.has("ArrowUp")) };
    };
    const blur = () => { keys.clear(); clearDirection(); };
    window.addEventListener("keydown", key); window.addEventListener("keyup", key);
    window.addEventListener("blur", blur); document.addEventListener("visibilitychange", blur);
    const draw = (now: number) => {
      if (!alive) return;
      const dt = Math.min(0.035, (now - (last || now)) / 1000); last = now;
      const current = latest.current;
      const state = current.snapshot.worm!;
      const index = state.targetIndex;
      if (oldConnected !== current.connected) { clearDirection(); oldConnected = current.connected; }
      if (index !== oldTarget) {
        completedPreview = null;
        if (index % 2 === 0) { immuneUntil = now + 900; setHint("나이스! 한 획 완성 ✨"); }
        else setHint("좋아! 이제 반짝이는 끝점으로");
        oldTarget = index;
      }
      const strokeIndex = Math.min(Math.floor(index / 2), character.strokeData.length - 1);
      const stroke = character.strokeData[strokeIndex]!;
      const target = index % 2 === 0 ? stroke.startPoint : stroke.endPoint;
      localHits = Math.max(localHits, state.hits ?? 0);
      const active = current.connected && !state.finished && !document.hidden && localHits < 3;
      const len = Math.hypot(direction.current.x, direction.current.y);
      if (active && len > 0.12) {
        heading = Math.atan2(direction.current.y, direction.current.x);
        const speed = 0.35;
        head.x = clamp(head.x + direction.current.x / Math.max(1, len) * dt * speed);
        head.y = clamp(head.y + direction.current.y / Math.max(1, len) * dt * speed);
        for (let i = 0; i < body.length; i++) {
          const previous = i ? body[i - 1]! : head;
          const segment = body[i]!;
          const d = distance(previous, segment);
          if (d > 0.014) { segment.x += (previous.x - segment.x) * (d - 0.014) / d; segment.y += (previous.y - segment.y) * (d - 0.014) / d; }
        }
      }
      if (active && !pending && !transitioning && now > retryAt && distance(head, target) < 0.052) {
        pending = true;
        const captured = { ...head };
        void current.reachTarget(captured).then((ok) => {
          if (!alive) return;
          pending = false; retryAt = performance.now() + (ok ? 120 : 1500);
          if (ok && index % 2 === 1) {
            transitioning = index + 1 === character.strokeData.length * 2;
            completedPreview = index + 1; burstAt = performance.now(); poppedBugs = bugs.map(b => ({...b}));
            particles = bugs.flatMap(b => Array.from({length: 12}, (_, n) => ({...b, vx: Math.cos(n * Math.PI / 6) * 0.3, vy: Math.sin(n * Math.PI / 6) * 0.3, color: ["#eebc38", "#a882cb", "#59b898"][n % 3]!})));
            bugs = []; setHint(poppedBugs.length ? `팡! 벌레 ${poppedBugs.length}마리 격파 ✨` : "나이스! 한 획 완성 ✨");
          }
          if (!ok) setHint("연결을 확인 중이에요. 잠시 기다려 주세요.");
        }).catch(() => { pending = false; retryAt = performance.now() + 1500; });
      }
      const ratio = strokeIndex / Math.max(1, character.strokeData.length - 1);
      const desiredBugs = strokeIndex === 0 ? 0 : Math.min(3, 1 + Math.floor(ratio * 2));
      if (active && now > burstAt + 1600 && bugs.length < desiredBugs) bugs.push({ x: bugs.length % 2 ? 0.95 : 0.05, y: 0.08 + bugs.length * 0.3 });
      if (active) bugs.forEach((bug) => {
        const d = distance(bug, head);
        if (d > 0.001) { const step = dt * (0.07 + ratio * 0.065); bug.x += (head.x - bug.x) / d * step; bug.y += (head.y - bug.y) / d * step; }
        if (d < 0.045 && now > immuneUntil && !hitPending && localHits === (state.hits ?? 0)) {
          immuneUntil = now + 1800; bug.x = bug.x < 0.5 ? 0.02 : 0.98;
          localHits++;
          try { navigator.vibrate?.([110, 45, 110]); } catch { /* Unsupported devices retain visual feedback. */ }
          setHint(localHits === 3 ? "세 번 닿았어요. 이번 도전은 여기까지!" : `앗! ${localHits}/3번 닿았어요`);
        }
      });
      if (current.connected && !hitPending && localHits > (state.hits ?? 0) && now > hitRetryAt) {
        hitPending = true;
        void current.reportHit(localHits).finally(() => { hitPending = false; hitRetryAt = performance.now() + 1500; });
      }
      const size = canvas.clientWidth;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(size * dpr)) { canvas.width = canvas.height = Math.round(size * dpr); }
      ctx.setTransform(canvas.width, 0, 0, canvas.height, 0, 0);
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#f9fcf5"; ctx.fillRect(0, 0, 1, 1);
      ctx.strokeStyle = "#e3ecdd"; ctx.lineWidth = 0.002; ctx.setLineDash([0.008, 0.012]);
      ctx.beginPath(); ctx.moveTo(0.5, 0.06); ctx.lineTo(0.5, 0.94); ctx.moveTo(0.06, 0.5); ctx.lineTo(0.94, 0.5); ctx.stroke(); ctx.setLineDash([]);
      // One coordinate space for hit targets, median trails and SVG outlines.
      ctx.translate(0.06, 0.06); ctx.scale(0.88, 0.88);
      const visualIndex = completedPreview ?? index;
      character.strokeData.forEach((s, i) => {
        const path = paths[i]; if (!path) return;
        ctx.save();
        const transform = ctx.getTransform();
        const cs = character.pathCoordinateSystem;
        if (cs) { ctx.translate(0, cs.originY / cs.height); ctx.scale(1 / cs.width, (cs.flipY ? -1 : 1) / cs.height); }
        else ctx.scale(0.01, 0.01);
        ctx.fillStyle = i < Math.floor(visualIndex / 2) ? "#268169" : "#e0e9dc";
        const filling = i === Math.floor(visualIndex / 2) - 1 && now - burstAt < 600;
        if (!filling) ctx.fill(path);
        else {
          ctx.clip(path); ctx.setTransform(transform);
          const median = s.median ?? [s.startPoint, ...(s.checkpoints ?? []), s.endPoint];
          const portion = Math.max(0, Math.min(1, (now - burstAt) / 450)) * (median.length - 1);
          ctx.beginPath(); ctx.moveTo(median[0]!.x, median[0]!.y);
          for (let m = 1; m <= Math.floor(portion); m++) ctx.lineTo(median[m]!.x, median[m]!.y);
          const a = median[Math.floor(portion)]!, b = median[Math.min(median.length - 1, Math.floor(portion) + 1)]!;
          ctx.lineTo(a.x + (b.x - a.x) * (portion % 1), a.y + (b.y - a.y) * (portion % 1));
          ctx.strokeStyle = "#268169"; ctx.lineWidth = 0.25; ctx.lineCap = "round"; ctx.stroke();
        }
        ctx.restore();
      });
      if (index % 2 === 1) { circle(stroke.startPoint.x, stroke.startPoint.y, 0.028, "#4389de"); }
      const pulse = reduced ? 0 : Math.sin(now / 160) * 0.006;
      circle(target.x, target.y, 0.057 + pulse, "#f8d45b55");
      circle(target.x, target.y, 0.039, "#f6c645");
      // Measure in real pixels: sub-pixel font sizes can be clamped by mobile browsers.
      ctx.save(); ctx.translate(target.x, target.y); ctx.scale(1 / 1000, 1 / 1000);
      ctx.fillStyle = "#443712"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.font = "700 42px sans-serif";
      const syllable = splitHanjaLabel(character.label).reading.slice(0, 2);
      const metrics = ctx.measureText(syllable);
      ctx.fillText(syllable, 0, (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2);
      ctx.restore();
      if (now - burstAt < 800) {
        ctx.strokeStyle = `rgba(237,181,43,${1 - (now - burstAt) / 800})`; ctx.lineWidth = 0.009;
        ctx.beginPath(); ctx.arc(head.x, head.y, Math.max(0, now - burstAt) / 850, 0, Math.PI * 2); ctx.stroke();
      }
      const burstAge = Math.max(0, (now - burstAt) / 1000);
      if (burstAge < 0.85) {
        ctx.save(); ctx.globalAlpha = 1 - burstAge / 0.85;
        poppedBugs.forEach((b, i) => {
          ctx.save(); ctx.translate(b.x + (i % 2 ? 1 : -1) * burstAge * 0.18, b.y - Math.sin(burstAge * 3) * 0.15); ctx.rotate(burstAge * 8);
          circle(0, 0, 0.025 * (1 - burstAge * 0.6), "#ac85cc");
          ctx.strokeStyle = "white"; ctx.lineWidth = 0.004; ctx.beginPath(); ctx.moveTo(-0.012,-0.007); ctx.lineTo(-0.003,0.002); ctx.moveTo(-0.003,-0.007); ctx.lineTo(-0.012,0.002); ctx.stroke(); ctx.restore();
        });
        if (!reduced) particles.forEach(p => circle(p.x + p.vx * burstAge, p.y + p.vy * burstAge + 0.16 * burstAge ** 2, 0.005, p.color));
        ctx.restore();
      }
      bugs.forEach((bug, i) => {
        ctx.strokeStyle = "#79609b"; ctx.lineWidth = 0.005;
        for (let leg = -1; leg <= 1; leg++) { ctx.beginPath(); ctx.moveTo(bug.x - 0.028, bug.y + leg * 0.016 + Math.sin(now / 90 + i) * 0.003); ctx.lineTo(bug.x + 0.028, bug.y - leg * 0.016); ctx.stroke(); }
        circle(bug.x, bug.y, 0.024, "#aa83c7"); circle(bug.x - 0.008, bug.y - 0.009, 0.007, "white"); circle(bug.x + 0.008, bug.y - 0.009, 0.007, "white");
        circle(bug.x - 0.008, bug.y - 0.008, 0.003, "#453357"); circle(bug.x + 0.008, bug.y - 0.008, 0.003, "#453357");
      });
      for (let i = body.length - 1; i >= 0; i--) circle(body[i]!.x, body[i]!.y, 0.012 + (body.length - i) * 0.0012, i % 2 ? "#55b39c" : "#79ceb2");
      ctx.save(); ctx.translate(head.x, head.y); ctx.rotate(heading);
      circle(0, 0, 0.03, now < immuneUntil ? "#93d7d2" : "#2c927c");
      circle(0.012, -0.015, 0.011, "#fff"); circle(0.012, 0.015, 0.011, "#fff");
      circle(0.016, -0.015, 0.005, "#173d35"); circle(0.016, 0.015, 0.005, "#173d35");
      ctx.restore();
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { alive = false; cancelAnimationFrame(frame); direction.current = { x: 0, y: 0 }; window.removeEventListener("keydown", key); window.removeEventListener("keyup", key); window.removeEventListener("blur", blur); document.removeEventListener("visibilitychange", blur); };
  }, [character]);

  return <section className="wormGame surface" aria-label="한자 지렁이 게임">
    <div className="wormHud"><span>한지 <b>{score}점</b></span>{rank}<span>{snapshot.characterIndex + 1}/{snapshot.characters.length}자 · {Math.min(character.strokeData.length, Math.floor(progress.targetIndex / 2) + 1)}/{character.strokeData.length}획</span></div>
    <div className="wormWord"><strong>{character.char}</strong><span>{reading.meaning} <b>{reading.reading}</b></span></div>
    <div className="wormInstructions"><span className="wormTargetLabel">{progress.targetIndex % 2 === 0 ? "① 시작점" : "② 끝점"}으로!</span><span aria-label={`충돌 ${progress.hits ?? 0}회, 3회면 종료`}>충돌 <b>{progress.hits ?? 0}/3</b></span></div>
    <div className="wormStage"><canvas ref={canvasRef} aria-label={`${character.char} 지렁이 이동판`} /></div>
    <p className="wormHint" role="status">{connected ? hint : "연결 복구 중 · 잠시 멈췄어요"}</p>
    <div className="wormControls"><span>반짝이는 점을<br />따라가요</span><div className="wormJoystick" role="group" aria-label="지렁이 조이스틱" tabIndex={0}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); const r = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2); direction.current = { x, y }; setStick({ x: x * 24, y: y * 24 }); }}
      onPointerMove={(e) => { if (!e.currentTarget.hasPointerCapture(e.pointerId)) return; const r = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - r.left - r.width / 2) / (r.width / 2), y = (e.clientY - r.top - r.height / 2) / (r.height / 2); const d = Math.max(1, Math.hypot(x, y)); direction.current = { x: x / d, y: y / d }; setStick({ x: x / d * 24, y: y / d * 24 }); }}
      onLostPointerCapture={() => { direction.current = { x: 0, y: 0 }; setStick({ x: 0, y: 0 }); }}
      onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); }}
      onPointerCancel={() => { direction.current = { x: 0, y: 0 }; setStick({ x: 0, y: 0 }); }}>
      <span aria-hidden="true" style={{ transform: `translate(${stick.x}px, ${stick.y}px)` }}>✦</span>
    </div><span>손을 떼면<br />멈춰요</span></div>
  </section>;
}
