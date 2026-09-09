/** New sb_secret keys are API keys, not bearer JWTs. Legacy service_role JWTs need both. */
export function supabaseServiceHeaders(rawKey: string): Record<string, string> {
  const key = rawKey.trim();
  return { apikey: key, ...(key.startsWith("sb_") ? {} : { authorization: `Bearer ${key}` }), "content-type": "application/json" };
}
