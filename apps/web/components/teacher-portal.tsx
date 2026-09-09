"use client";

import type { Session } from "@supabase/supabase-js";
import { useEffect, useState, type FormEvent } from "react";
import { TeacherDashboard } from "./teacher-dashboard";
import { getSupabaseBrowserClient } from "@/lib/supabase";

interface TeacherSession {
  accessToken: string;
  email: string;
  demo: boolean;
}

function toTeacherSession(session: Session | null): TeacherSession | null {
  if (!session?.access_token) return null;
  return {
    accessToken: session.access_token,
    email: session.user.email ?? "교사",
    demo: false,
  };
}


function hasStoredSupabaseSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return Object.keys(window.localStorage).some((key) => key.startsWith("sb-") && key.endsWith("-auth-token"));
  } catch {
    return false;
  }
}

export function TeacherPortal() {
  const demoMode = process.env.NEXT_PUBLIC_TEACHER_AUTH_MODE === "demo";
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<TeacherSession | null>(null);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (demoMode) {
      queueMicrotask(() => {
        setSession({
          accessToken: "demo-teacher-token",
          email: "로컬 데모 교사",
          demo: true,
        });
        setReady(true);
      });
      return;
    }
    const supabase = getSupabaseBrowserClient();
    if (!supabase) {
      queueMicrotask(() => setReady(true));
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    const markSession = (nextSession: TeacherSession | null) => {
      if (cancelled) return;
      setSession(nextSession);
      if (nextSession) window.localStorage.setItem("hanja:teacher:last-login", "true");
    };
    const resolveSession = async (attempt = 0) => {
      const { data } = await supabase.auth.getSession();
      const nextSession = toTeacherSession(data.session);
      markSession(nextSession);
      if (nextSession || cancelled) {
        setReady(true);
        return;
      }
      const hadLogin = window.localStorage.getItem("hanja:teacher:last-login") === "true" || hasStoredSupabaseSession();
      if (hadLogin && attempt < 3) {
        setMessage("이전 로그인 정보를 확인하고 있습니다…");
        retryTimer = window.setTimeout(() => { void resolveSession(attempt + 1); }, 700);
        return;
      }
      setReady(true);
    };

    void resolveSession();
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      markSession(toTeacherSession(nextSession));
      setReady(true);
    });
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      data.subscription.unsubscribe();
    };
  }, [demoMode]);

  async function sendMagicLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const supabase = getSupabaseBrowserClient();
    if (!supabase || !email.trim()) return;
    setSending(true);
    setMessage("");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setSending(false);
    setMessage(
      error
        ? `로그인 메일을 보내지 못했습니다: ${error.message}`
        : "이메일로 보낸 로그인 링크를 눌러 주세요. 이 화면은 닫지 않아도 됩니다.",
    );
  }

  async function signOut() {
    if (session?.demo) return;
    await getSupabaseBrowserClient()?.auth.signOut();
  }

  if (!ready) {
    return <main className="teacherAuthPage"><div className="teacherAuthCard surface">로그인 상태를 확인하고 있습니다…</div></main>;
  }

  if (session) {
    return (
      <TeacherDashboard
        accessToken={session.accessToken}
        onSignOut={() => void signOut()}
        teacherEmail={session.email}
      />
    );
  }

  const configured = Boolean(getSupabaseBrowserClient());
  return (
    <main className="teacherAuthPage">
      <section className="teacherAuthCard surface">
        <span className="brandStamp">획!</span>
        <p className="kicker">TEACHER SIGN IN</p>
        <h1>교사 로그인</h1>
        <p className="teacherAuthDescription">
          교사의 한자 목록과 승인 기록을 안전하게 저장하기 위해 이메일 로그인이 필요합니다.
          학생은 로그인 없이 QR로 바로 참여합니다.
        </p>
        {configured ? (
          <form onSubmit={sendMagicLink}>
            <label htmlFor="teacher-email">교사 이메일</label>
            <input
              autoComplete="email"
              id="teacher-email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="teacher@school.kr"
              required
              type="email"
              value={email}
            />
            <button className="primaryButton" disabled={sending} type="submit">
              <span>{sending ? "메일을 보내는 중" : "이메일로 로그인 링크 받기"}</span>
              <span aria-hidden="true">→</span>
            </button>
          </form>
        ) : (
          <div className="authConfigNotice">
            Supabase 환경변수가 아직 설정되지 않았습니다. README의 교사 로그인 설정을 먼저 완료해 주세요.
          </div>
        )}
        <p className="notice" role="status">{message}</p>
        <small>공용 PC에서는 수업이 끝난 뒤 반드시 로그아웃해 주세요.</small>
      </section>
    </main>
  );
}
