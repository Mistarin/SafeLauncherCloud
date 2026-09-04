/**
 * HTTP API surface for the SafeLauncher desktop client (plain HTTPS).
 *
 * Routes are dispatched inside a single catch-all handler under /api/ so that
 * every request funnels through one auth + error wrapper. Handlers delegate
 * authorization and data access to functions in users.ts / saves.ts which
 * independently verify identity — direct REST calls to those functions get
 * the same guarantees.
 */
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { BACKEND_VERSION } from "./lib/limits";
import {
  ApiError,
  jsonResponse,
  requireIdentity,
  readJsonBody,
  argNumber,
} from "./lib/api";

const http = httpRouter();

/** Liveness probe — deliberately unauthenticated. */
http.route({
  path: "/api/health",
  method: "GET",
  handler: httpAction(async () =>
    jsonResponse({ ok: true, service: "safelauncher-cloud-saves", version: BACKEND_VERSION })
  ),
});

type Handler = (ctx: any, req: Request, params: Record<string, string>) => Promise<Response>;

interface RouteDef {
  method: string;
  pattern: RegExp; // against pathname
  handler: Handler;
}

const routes: RouteDef[] = [
  // --- account ------------------------------------------------------------
  {
    method: "GET",
    pattern: /^\/api\/me$/,
    handler: async (ctx, req) => {
      const identity = await requireIdentity(ctx, req);
      await ctx.runMutation(api.users.getOrCreateUser, { authSubject: identity.subject });
      const deviceId = req.headers.get("X-SafeLauncher-Device-Id");
      const deviceName = req.headers.get("X-SafeLauncher-Device-Name");
      const platform = req.headers.get("X-SafeLauncher-Platform");
      if (deviceId && deviceName) {
        await ctx.runMutation(api.users.heartbeatDevice, {
          authSubject: identity.subject,
          deviceId,
          deviceName,
          platform: platform ?? "Linux",
        });
      }
      const overview = await ctx.runQuery(api.users.accountOverview, { authSubject: identity.subject });
      return jsonResponse(overview);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/heartbeat$/,
    handler: async (ctx, req) => {
      const identity = await requireIdentity(ctx, req);
      const body = await readJsonBody(req);
      const deviceId = String(body.deviceId || req.headers.get("X-SafeLauncher-Device-Id") || "unknown");
      const deviceName = String(body.deviceName || req.headers.get("X-SafeLauncher-Device-Name") || "Desktop");
      const platform = String(body.platform || req.headers.get("X-SafeLauncher-Platform") || "Linux");
      const res = await ctx.runMutation(api.users.heartbeatDevice, {
        authSubject: identity.subject,
        deviceId,
        deviceName,
        platform,
      });
      return jsonResponse(res);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/key$/,
    handler: async (ctx, req) => {
      const identity = await requireIdentity(ctx, req);
      const { dataKeyB64 } = await ctx.runMutation(api.users.ensureDataKey, { authSubject: identity.subject });
      return jsonResponse({ dataKeyB64 });
    },
  },

  // --- saves ---------------------------------------------------------------
  {
    method: "GET",
    pattern: /^\/api\/games$/,
    handler: async (ctx, req) => {
      const identity = await requireIdentity(ctx, req);
      const listing = await ctx.runQuery(api.saves.listGames, { authSubject: identity.subject });
      return jsonResponse(listing);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/games\/([^/]+)\/init-upload$/,
    handler: async (ctx, req, params) => {
      const identity = await requireIdentity(ctx, req);
      const body = await readJsonBody(req);
      const result = await ctx.runMutation(api.saves.requestUpload, {
        authSubject: identity.subject,
        nameKey: decodeURIComponent(params.nameKey),
        displayName: typeof body.displayName === "string" ? body.displayName : params.nameKey,
        plainSha256: String(body.plainSha256 ?? ""),
        sourceMaxMtime: argNumber(body, "sourceMaxMtime"),
        declaredSizeBytes: argNumber(body, "declaredSizeBytes"),
      });
      return jsonResponse(result);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/games\/([^/]+)\/confirm-upload$/,
    handler: async (ctx, req, params) => {
      const identity = await requireIdentity(ctx, req);
      const body = await readJsonBody(req);
      if (typeof body.saveId !== "string" || typeof body.storageId !== "string") {
        throw new ApiError(400, "missing_field", "saveId and storageId are required.");
      }
      const result = await ctx.runMutation(api.saves.confirmUpload, {
        authSubject: identity.subject,
        nameKey: decodeURIComponent(params.nameKey),
        saveId: body.saveId as never,
        storageId: body.storageId as never,
      });
      return jsonResponse(result);
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/games\/([^/]+)\/download$/,
    handler: async (ctx, req, params) => {
      const identity = await requireIdentity(ctx, req);
      const url = new URL(req.url);
      const versionParam = url.searchParams.get("version");
      const ref = await ctx.runAction(api.saves.resolveDownload, {
        authSubject: identity.subject,
        nameKey: decodeURIComponent(params.nameKey),
        version:
          versionParam === null || versionParam === ""
            ? undefined
            : Number(versionParam),
      });
      if (!ref) {
        throw new ApiError(404, "no_save", "No confirmed save exists for this game.");
      }
      return jsonResponse(ref);
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/devices$/,
    handler: async (ctx, req) => {
      const identity = await requireIdentity(ctx, req);
      const body = await readJsonBody(req);
      if (typeof body.deviceId !== "string" || !body.deviceId) {
        throw new ApiError(400, "missing_field", "deviceId is required.");
      }
      const revoked = await ctx.runMutation(api.users.revokeDevice, {
        authSubject: identity.subject,
        deviceId: body.deviceId,
      });
      return jsonResponse({ revoked });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/games\/([^/]+)$/,
    handler: async (ctx, req, params) => {
      const identity = await requireIdentity(ctx, req);
      const body = await readJsonBody(req);
      const ok = await ctx.runMutation(api.saves.deleteSave, {
        authSubject: identity.subject,
        nameKey: decodeURIComponent(params.nameKey),
        version: argNumber(body, "version"),
      });
      return jsonResponse({ deleted: ok });
    },
  },
];

http.route({
  pathPrefix: "/api/",
  method: "POST",
  handler: httpAction(async (ctx, req) => dispatch("POST", ctx, req)),
});
http.route({
  pathPrefix: "/api/",
  method: "GET",
  handler: httpAction(async (ctx, req) => dispatch("GET", ctx, req)),
});
http.route({
  pathPrefix: "/api/",
  method: "DELETE",
  handler: httpAction(async (ctx, req) => dispatch("DELETE", ctx, req)),
});

async function dispatch(method: string, ctx: unknown, req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const params = match.groups ?? {};
      // Convert numbered groups into named ones below; we use named groups.
      return await route.handler(ctx, req, normalizeParams(match));
    }
    return jsonResponse({ error: "not_found", code: "not_found" }, 404);
  } catch (err) {
    if (err instanceof ApiError) {
      return jsonResponse(
        { error: err.message, code: err.code, ...(err.extra ?? {}) },
        err.status
      );
    }
    console.error("Unhandled API error", err);
    return jsonResponse({ error: "internal_error", code: "internal_error" }, 500);
  }
}

function normalizeParams(match: RegExpExecArray): Record<string, string> {
  // Named groups live on match.groups; fall back to first capture for
  // single-parameter patterns like /api/games/:nameKey/…
  if (match.groups && Object.keys(match.groups).length > 0) {
    return match.groups;
  }
  return { nameKey: match[1] };
}

export default http;
