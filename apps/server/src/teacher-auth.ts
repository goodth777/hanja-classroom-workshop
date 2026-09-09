export interface TeacherIdentity {
  id: string;
  email?: string;
}

export interface TeacherAuthVerifier {
  verify(accessToken: string): Promise<TeacherIdentity>;
}

export class TeacherAuthError extends Error {
  constructor(message = "Teacher authentication failed") {
    super(message);
    this.name = "TeacherAuthError";
  }
}

export class DemoTeacherAuthVerifier implements TeacherAuthVerifier {
  async verify(accessToken: string): Promise<TeacherIdentity> {
    if (accessToken !== "demo-teacher-token") throw new TeacherAuthError();
    return {
      id: "00000000-0000-4000-8000-000000000001",
      email: "demo-teacher@local.test",
    };
  }
}

export class SupabaseTeacherAuthVerifier implements TeacherAuthVerifier {
  constructor(
    private readonly url: string,
    private readonly publishableKey: string,
  ) {}

  async verify(accessToken: string): Promise<TeacherIdentity> {
    if (!accessToken) throw new TeacherAuthError();
    const response = await fetch(`${this.url.replace(/\/$/, "")}/auth/v1/user`, {
      headers: {
        apikey: this.publishableKey,
        authorization: `Bearer ${accessToken}`,
      },
    });
    if (!response.ok) throw new TeacherAuthError();
    const user = (await response.json()) as { id?: unknown; email?: unknown };
    if (typeof user.id !== "string" || !user.id) throw new TeacherAuthError();
    return {
      id: user.id,
      email: typeof user.email === "string" ? user.email : undefined,
    };
  }
}

class RejectingTeacherAuthVerifier implements TeacherAuthVerifier {
  async verify(): Promise<TeacherIdentity> {
    throw new TeacherAuthError("Teacher authentication is not configured");
  }
}

export function createTeacherAuthVerifier(
  environment: NodeJS.ProcessEnv = process.env,
): TeacherAuthVerifier {
  if (environment.TEACHER_AUTH_MODE === "demo" && environment.NODE_ENV !== "production") {
    return new DemoTeacherAuthVerifier();
  }
  const url = environment.SUPABASE_URL;
  const key = environment.SUPABASE_PUBLISHABLE_KEY ?? environment.SUPABASE_ANON_KEY;
  return url && key
    ? new SupabaseTeacherAuthVerifier(url, key)
    : new RejectingTeacherAuthVerifier();
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}
