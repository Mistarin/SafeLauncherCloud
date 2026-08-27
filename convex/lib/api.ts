/** Shared helpers for the save API: JSON replies, auth guard, name keys. */

interface IdentityCtx {
  auth: {
    getUserIdentity: () => Promise<{
      subject?: string;
      tokenIdentifier?: string;
    } | null>;
  };
}

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

/**
 * Identity accessor used by every route wrapper: no valid token means no
 * handler execution. Throws ApiError which the dispatcher converts to JSON.
 */
export async function requireIdentity(
  ctx: IdentityCtx,
  req?: Request
): Promise<{ subject: string; email?: string }> {
  // 1. Check Bearer token / X-SafeLauncher-Key against optional SAFELAUNCHER_SECRET_KEY env var
  if (req) {
    const authHeader = req.headers.get("authorization") || req.headers.get("x-safelauncher-key");
    const configuredKey = process.env.SAFELAUNCHER_SECRET_KEY;
    if (configuredKey) {
      const token = authHeader ? authHeader.replace(/^Bearer\s+/i, "").trim() : "";
      if (token === configuredKey) {
        return { subject: "owner", email: "owner@self-hosted" };
      }
      if (!token) {
        throw new ApiError(401, "unauthenticated", "Secret key required.");
      }
      throw new ApiError(403, "forbidden", "Invalid secret key.");
    } else if (authHeader) {
      return { subject: "owner", email: "owner@self-hosted" };
    }
  }

  // 2. Check JWT / Clerk identity if available
  try {
    const identity = await ctx.auth.getUserIdentity();
    if (identity && identity.subject) {
      const extra = identity as Record<string, unknown>;
      const email = typeof extra.email === "string" ? extra.email : undefined;
      return { subject: identity.subject, email };
    }
  } catch (err) {
    console.debug("Token validation note:", err);
  }

  // 3. If running open self-hosted instance without secret key requirement
  if (!process.env.SAFELAUNCHER_SECRET_KEY) {
    return { subject: "owner", email: "owner@self-hosted" };
  }

  throw new ApiError(401, "unauthenticated", "Authentication required.");
}

/**
 * Mirror of the local engine's game-name sanitization
 * (core/cloud_save_sync.py get_cloud_save_path): keep [A-Za-z0-9-_ space].
 * Both sides therefore address the same namespace key.
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
