export interface Token {
  subject: string | null;
  expiresAt: number;
  refreshable: boolean;
}

export type SessionResponse =
  | { status: 200; body: { userId: string } }
  | { status: 401; body: { code: "SESSION_EXPIRED" } }
  | { status: 500; body: { code: "INTERNAL_ERROR" } };

class SessionExpiredError extends Error {}

export function validateToken(token: Token, now: number): string {
  if (token.expiresAt <= now) throw new SessionExpiredError("expired");
  if (token.subject === null) throw new TypeError("missing subject");
  return token.subject.toUpperCase();
}

export function restoreSession(token: Token, now: number): SessionResponse {
  try {
    return { status: 200, body: { userId: validateToken(token, now) } };
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      return { status: 401, body: { code: "SESSION_EXPIRED" } };
    }
    return { status: 500, body: { code: "INTERNAL_ERROR" } };
  }
}
