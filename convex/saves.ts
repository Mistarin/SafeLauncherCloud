/** Save upload/download lifecycle: quotas, retention, idempotent confirms. */
import { v } from "convex/values";
import {
  mutation,
  query,
  action,
  internalQuery,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireIdentity, ApiError } from "./lib/api";
import { MAX_SAVE_BYTES, QUOTA_BYTES, KEEP_VERSIONS } from "./lib/limits";

const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

async function userBySubject(ctx: MutationCtx | QueryCtx) {
  const identity = await requireIdentity(ctx);
  const user = await ctx.db
    .query("users")
    .withIndex("by_subject", (q) => q.eq("subject", identity.subject))
    .unique();
  if (!user) {
    // Direct REST calls without prior provisioning fail closed here.
    throw new ApiError(404, "user_missing", "Account not provisioned.");
  }
  return user;
}

async function bytesUsedForUser(
  ctx: MutationCtx | QueryCtx,
  userId: import("./_generated/dataModel").Id<"users">
): Promise<number> {
  let total = 0;
  for await (const g of ctx.db
    .query("games")
    .withIndex("by_user", (q) => q.eq("userId", userId))) {
    total += g.totalBytes;
  }
  return total;
}

/**
 * Step 1 of upload: validate size + quota, create a pending save row, mint
 * an expiring storage upload URL. The row is promoted in confirmUpload.
 */
export const requestUpload = mutation({
  args: {
    nameKey: v.string(),
    displayName: v.string(),
    plainSha256: v.string(),
    sourceMaxMtime: v.number(),
    declaredSizeBytes: v.number(),
  },
  returns: v.object({
    saveId: v.id("saves"),
    uploadUrl: v.string(),
  }),
  handler: async (ctx, args) => {
    if (args.declaredSizeBytes <= 0 || args.declaredSizeBytes > MAX_SAVE_BYTES) {
      throw new ApiError(413, "save_too_large",
        `Save must be between 1 byte and ${MAX_SAVE_BYTES} bytes.`);
    }
    if (!/^[0-9a-f]{64}$/.test(args.plainSha256)) {
      throw new ApiError(400, "bad_hash", "plainSha256 must be lowercase hex sha256.");
    }

    const identity = await requireIdentity(ctx);
    let user = await ctx.db
      .query("users")
      .withIndex("by_subject", (q) => q.eq("subject", identity.subject))
      .unique();
    if (!user) {
      const userId = await ctx.db.insert("users", {
        subject: identity.subject,
        email: identity.email,
        createdAt: Date.now(),
      });
      user = (await ctx.db.get(userId))!;
    }

    // Garbage-collect abandoned pending uploads for this account.
    const cutoff = Date.now() - PENDING_TTL_MS;
    for await (const s of ctx.db
      .query("saves")
      .withIndex("by_user", (q) => q.eq("userId", user._id))) {
      if (s.state === "pending" && s.createdAt < cutoff) {
        await ctx.db.delete(s._id);
      }
    }

    const used = await bytesUsedForUser(ctx, user._id);
    if (used + args.declaredSizeBytes > QUOTA_BYTES) {
      throw new ApiError(
        507,
        "quota_exceeded",
        `Quota exceeded: ${used} bytes used of ${QUOTA_BYTES}; freeing space or removing old games is required.`,
        { usedBytes: used, quotaBytes: QUOTA_BYTES, requestedBytes: args.declaredSizeBytes }
      );
    }

    let game = await ctx.db
      .query("games")
      .withIndex("by_user_and_name", (q) =>
        q.eq("userId", user._id).eq("nameKey", args.nameKey)
      )
      .unique();
    if (!game) {
      const gameId = await ctx.db.insert("games", {
        userId: user._id,
        nameKey: args.nameKey,
        displayName: args.displayName.slice(0, 128),
        latestSourceMtime: args.sourceMaxMtime,
        totalBytes: 0,
        createdAt: Date.now(),
      });
      game = (await ctx.db.get(gameId))!;
    }

    const saveId = await ctx.db.insert("saves", {
      gameId: game._id,
      userId: user._id,
      version: 0, // assigned at confirm; reserved to keep the row validatable
      state: "pending",
      sizeBytes: args.declaredSizeBytes,
      plainSha256: args.plainSha256,
      sourceMaxMtime: args.sourceMaxMtime,
      createdAt: Date.now(),
    });

    const uploadUrl = await ctx.storage.generateUploadUrl();
    return { saveId, uploadUrl };
  },
});

function isStorageMetadata(meta: unknown): meta is { size: number } {
  return typeof meta === "object" && meta !== null &&
    typeof (meta as { size?: unknown }).size === "number";
}

/**
 * Step 2 of upload: attach the uploaded blob after verifying its true size
 * against stored object metadata (never client claims), assign the next
 * version, evict generations beyond retention, update aggregates.
 * Idempotent on retry.
 */
export const confirmUpload = mutation({
  args: {
    nameKey: v.string(),
    saveId: v.id("saves"),
    storageId: v.id("_storage"),
  },
  returns: v.object({
    ok: v.boolean(),
    version: v.number(),
    evictedVersions: v.array(v.number()),
    gameTotalBytes: v.number(),
  }),
  handler: async (ctx, args) => {
    const user = await userBySubject(ctx);

    const save = await ctx.db.get(args.saveId);
    if (!save || save.userId !== user._id) {
      throw new ApiError(404, "not_found", "No such pending save.");
    }
    if (save.state === "confirmed") {
      // Idempotent replay (client crashed before receiving response).
      const game = (await ctx.db.get(save.gameId))!;
      return { ok: true, version: save.version, evictedVersions: [], gameTotalBytes: game.totalBytes };
    }

    const meta = await ctx.db.system.get(args.storageId);
    if (!isStorageMetadata(meta)) {
      throw new ApiError(400, "upload_incomplete", "Blob not found; re-run init-upload.");
    }
    if (meta.size > MAX_SAVE_BYTES) {
      await ctx.storage.delete(args.storageId);
      await ctx.db.patch(save._id, { state: "failed" });
      throw new ApiError(413, "save_too_large",
        `Uploaded blob is ${meta.size} bytes; limit is ${MAX_SAVE_BYTES}.`);
    }

    const game = (await ctx.db.get(save.gameId))!;
    if (!game || game.userId !== user._id || game.nameKey !== args.nameKey) {
      throw new ApiError(404, "not_found", "Game vanished during upload.");
    }

    // Next sequential version for this game.
    let maxVersion = 0;
    for await (const s of ctx.db
      .query("saves")
      .withIndex("by_game_version", (q) => q.eq("gameId", game._id))) {
      if (s.version > maxVersion) maxVersion = s.version;
    }
    const version = maxVersion + 1;

    await ctx.db.patch(save._id, {
      state: "confirmed",
      version,
      storageId: args.storageId,
      sizeBytes: meta.size,
    });

    // Retention: newest KEEP_VERSIONS generations survive.
    const confirmed: Array<{ id: import("./_generated/dataModel").Id<"saves">; version: number; storageId?: unknown }> = [];
    for await (const s of ctx.db
      .query("saves")
      .withIndex("by_game_version", (q) => q.eq("gameId", game._id))) {
      if (s.state !== "confirmed") continue;
      confirmed.push({ id: s._id, version: s.version, storageId: s.storageId });
    }
    confirmed.sort((a, b) => b.version - a.version);
    const evictedVersions: number[] = [];
    for (const old of confirmed.slice(KEEP_VERSIONS)) {
      if (old.storageId) {
        try {
          await ctx.storage.delete(old.storageId as import("./_generated/dataModel").Id<"_storage">);
        } catch {
          // Already gone (replayed eviction); nothing else to do.
        }
      }
      await ctx.db.delete(old.id);
      evictedVersions.push(old.version);
    }

    // Recompute authoritative totals from live rows only.
    let totalBytes = 0;
    let latestSourceMtime = game.latestSourceMtime;
    for await (const s of ctx.db
      .query("saves")
      .withIndex("by_game_version", (q) => q.eq("gameId", game._id))) {
      if (s.state !== "confirmed") continue;
      totalBytes += s.sizeBytes;
      if (s.sourceMaxMtime > latestSourceMtime) latestSourceMtime = s.sourceMaxMtime;
    }
    await ctx.db.patch(game._id, { totalBytes, latestSourceMtime });

    return { ok: true, version, evictedVersions, gameTotalBytes: totalBytes };
  },
});

/** All games with their retained generation metadata for conflict checks. */
export const listGames = query({
  args: {},
  returns: v.object({
    games: v.array(
      v.object({
        nameKey: v.string(),
        displayName: v.string(),
        totalBytes: v.number(),
        latestSourceMtime: v.number(),
        versions: v.array(
          v.object({
            version: v.number(),
            sizeBytes: v.number(),
            plainSha256: v.string(),
            sourceMaxMtime: v.number(),
            createdAt: v.number(),
          })
        ),
      })
    ),
    bytesUsed: v.number(),
    quotaBytes: v.number(),
  }),
  handler: async (ctx) => {
    const user = await userBySubject(ctx);
    const out: Array<{
      nameKey: string; displayName: string; totalBytes: number;
      latestSourceMtime: number;
      versions: Array<{
        version: number; sizeBytes: number; plainSha256: string;
        sourceMaxMtime: number; createdAt: number;
      }>;
    }> = [];
    for await (const g of ctx.db
      .query("games")
      .withIndex("by_user", (q) => q.eq("userId", user._id))) {
      const versions: Array<{
        version: number; sizeBytes: number; plainSha256: string;
        sourceMaxMtime: number; createdAt: number;
      }> = [];
      for await (const s of ctx.db
        .query("saves")
        .withIndex("by_game_version", (q) => q.eq("gameId", g._id))) {
        if (s.state !== "confirmed") continue;
        versions.push({
          version: s.version,
          sizeBytes: s.sizeBytes,
          plainSha256: s.plainSha256,
          sourceMaxMtime: s.sourceMaxMtime,
          createdAt: s.createdAt,
        });
      }
      versions.sort((a, b) => b.version - a.version);
      out.push({
        nameKey: g.nameKey,
        displayName: g.displayName,
        totalBytes: g.totalBytes,
        latestSourceMtime: g.latestSourceMtime,
        versions: versions.slice(0, KEEP_VERSIONS),
      });
    }
    const bytesUsed = await bytesUsedForUser(ctx, user._id);
    return { games: out, bytesUsed, quotaBytes: QUOTA_BYTES };
  },
});

/** Metadata used by the download flow: resolves an expiring blob URL. */
export const resolveDownload = action({
  args: { nameKey: v.string(), version: v.optional(v.number()) },
  returns: v.union(
    v.null(),
    v.object({ url: v.string(), sizeBytes: v.number(), version: v.number() })
  ),
  handler: async (ctx, args): Promise<{ url: string; sizeBytes: number; version: number } | null> => {
    const identity = await requireIdentity(ctx);
    const ref = await ctx.runQuery(internal.saves.lookupDownloadRefInternal, {
      subject: identity.subject,
      nameKey: args.nameKey,
      version: args.version,
    });
    if (!ref) return null;
    // Blob contents are client-encrypted ciphertext, so the URL alone is
    // useless without the caller's data key.
    const url = await ctx.storage.getUrl(ref.storageId);
    if (!url) return null;
    return { url, sizeBytes: ref.sizeBytes, version: ref.version };
  },
});

export const lookupDownloadRefInternal = internalQuery({
  args: {
    subject: v.string(),
    nameKey: v.string(),
    version: v.optional(v.number()),
  },
  returns: v.union(
    v.null(),
    v.object({ storageId: v.id("_storage"), sizeBytes: v.number(), version: v.number() })
  ),
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_subject", (q) => q.eq("subject", args.subject))
      .unique();
    if (!user) return null;

    const game = await ctx.db
      .query("games")
      .withIndex("by_user_and_name", (q) =>
        q.eq("userId", user._id).eq("nameKey", args.nameKey))
      .unique();
    if (!game) return null;

    let best: Doc<"saves"> | null = null;
    for await (const s of ctx.db
      .query("saves")
      .withIndex("by_game_version", (q) => q.eq("gameId", game._id))) {
      if (s.state !== "confirmed" || !s.storageId) continue;
      if (args.version !== undefined && s.version === args.version) {
        return { storageId: s.storageId, sizeBytes: s.sizeBytes, version: s.version };
      }
      if (!best || s.version > best.version) best = s;
    }
    if (!best || !best.storageId) return null;
    return { storageId: best.storageId, sizeBytes: best.sizeBytes, version: best.version };
  },
});

/** Explicit manual delete of one generation. */
export const deleteSave = mutation({
  args: { nameKey: v.string(), version: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const user = await userBySubject(ctx);
    const game = await ctx.db
      .query("games")
      .withIndex("by_user_and_name", (q) =>
        q.eq("userId", user._id).eq("nameKey", args.nameKey))
      .unique();
    if (!game) return false;

    let removed = false;
    for await (const s of ctx.db
      .query("saves")
      .withIndex("by_game_version", (q) => q.eq("gameId", game._id))) {
      if (s.state === "confirmed" && s.version === args.version) {
        if (s.storageId) await ctx.storage.delete(s.storageId);
        await ctx.db.delete(s._id);
        removed = true;
      }
    }
    if (removed) {
      let totalBytes = 0;
      let latestSourceMtime = 0;
      for await (const s of ctx.db
        .query("saves")
        .withIndex("by_game_version", (q) => q.eq("gameId", game._id))) {
        if (s.state !== "confirmed") continue;
        totalBytes += s.sizeBytes;
        if (s.sourceMaxMtime > latestSourceMtime) latestSourceMtime = s.sourceMaxMtime;
      }
      await ctx.db.patch(game._id, {
        totalBytes,
        latestSourceMtime: latestSourceMtime || Date.now(),
      });
    }
    return removed;
  },
});
