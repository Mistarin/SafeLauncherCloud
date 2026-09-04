/** Shared helpers for the save API: JSON replies, auth guard, name keys. */


export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>
  ) {
    super(message);
  }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Identity accessor: verifies the private server secret key if configured in Convex env,
 * otherwise treats requests as the server owner.
 */
export async function requireIdentity(
  _ctx: unknown,
  req?: Request
): Promise<{ subject: string; email?: string }> {
  const configuredKey = process.env.SAFELAUNCHER_SECRET_KEY;
  if (configuredKey) {
    if (!req) {
      throw new ApiError(401, "unauthenticated", "Secret key required.");
    }
    const authHeader = req.headers.get("authorization") || req.headers.get("x-safelauncher-key") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token || !constantTimeCompare(token, configuredKey)) {
      throw new ApiError(401, "unauthenticated", "Invalid or missing secret key.");
    }
    return { subject: "owner", email: "owner@self-hosted" };
  }

  // Personal private deployment without pre-shared secret requirement
  return { subject: "owner", email: "owner@self-hosted" };
}

/**
 * Game-name namespace keys are computed by the client
 * (core/cloud_backend.py normalize_name_key): [A-Za-z0-9-_ space] with a
 * short sha256(raw-name) suffix whenever sanitization would drop characters,
 * so distinct game names can never collide. The client sends final keys;
 * this server mirror validates the charset rather than re-deriving keys.
 */
export function sanitizeNameKey(gameName: string): string {
  const cleaned = Array.from(gameName)
    .filter((c) => /[A-Za-z0-9\-_ ]/.test(c))
    .join("")
    .trim();
  if (!cleaned) {
    throw new ApiError(400, "invalid_name", "Game name sanitizes to empty.");
  }
  if (cleaned.length > 128) {
    throw new ApiError(400, "invalid_name", "Game name key too long.");
  }
  return cleaned;
}

/** True when a client-supplied nameKey is already in the canonical charset. */
export function isValidNameKey(nameKey: string): boolean {
  return /^[A-Za-z0-9\-_ ]{1,128}$/.test(nameKey) && nameKey === nameKey.trim() && nameKey.length > 0;
}

export type ParsedBody = Record<string, unknown>;

export async function readJsonBody(req: Request): Promise<ParsedBody> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new ApiError(400, "bad_json", "Request body must be valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ApiError(400, "bad_json", "Request body must be a JSON object.");
  }
  return parsed as ParsedBody;
}

export function argString(
  body: ParsedBody,
  field: string,
  opts: { maxLen?: number } = {}
): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError(400, "missing_field", `Field '${field}' is required.`);
  }
  if (opts.maxLen && value.length > opts.maxLen) {
    throw new ApiError(400, "field_too_long", `Field '${field}' exceeds ${opts.maxLen} chars.`);
  }
  return value;
}

export function argNumber(body: ParsedBody, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(400, "missing_field", `Field '${field}' must be a number.`);
  }
  return value;
}
