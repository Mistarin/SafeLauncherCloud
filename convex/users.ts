/** User provisioning and account/quota overview. */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity } from "./lib/api";
import { QUOTA_BYTES, MAX_SAVE_BYTES, KEEP_VERSIONS } from "./lib/limits";

/** Idempotently ensure a users row exists for the caller; returns its id. */
export const getOrCreateUser = mutation({
  args: {},
  returns: v.id("users"),
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const existing = await ctx.db
      .query("users")
      .withIndex("by_subject", (q) => q.eq("subject", identity.subject))
      .unique();
    if (existing) {
      if (identity.email && existing.email !== identity.email) {
        await ctx.db.patch(existing._id, { email: identity.email });
      }
      return existing._id;
    }
    return ctx.db.insert("users", {
      subject: identity.subject,
      email: identity.email,
      createdAt: Date.now(),
    });
  },
});

/**
 * Return this user's payload encryption key, generating it on first use.
 *
 * Threat model: protects save contents against anyone who obtains storage
 * files or download URLs without database access. It is NOT zero-knowledge —
 * the backend can see the key and must be trusted with account integrity.
 */
export const ensureDataKey = mutation({
  args: {},
  returns: v.object({ dataKeyB64: v.string() }),
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_subject", (q) => q.eq("subject", identity.subject))
      .unique();
    if (!user) {
      throw new Error("user_missing");
    }
    if (user.dataKeyWrapped) {
      return { dataKeyB64: uint8ToB64(new Uint8Array(user.dataKeyWrapped)) };
    }
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    await ctx.db.patch(user._id, {
      dataKeyWrapped: key.slice().buffer as ArrayBuffer,
    });
    return { dataKeyB64: uint8ToB64(key) };
  },
});

function uint8ToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Account snapshot powering the settings UI quota bar and lists. */
export const accountOverview = query({
  args: {},
  returns: v.object({
    subject: v.string(),
    email: v.union(v.string(), v.null()),
    games: v.array(
      v.object({
        nameKey: v.string(),
        displayName: v.string(),
        totalBytes: v.number(),
        latestSourceMtime: v.number(),
        versions: v.number(),
      })
    ),
    bytesUsed: v.number(),
    quotaBytes: v.number(),
    maxSaveBytes: v.number(),
    keepVersions: v.number(),
  }),
  handler: async (ctx) => {
    const identity = await requireIdentity(ctx);
    const user = await ctx.db
      .query("users")
      .withIndex("by_subject", (q) => q.eq("subject", identity.subject))
      .unique();
    let bytesUsed = 0;
    const games: Array<{
      nameKey: string;
      displayName: string;
      totalBytes: number;
      latestSourceMtime: number;
      versions: number;
    }> = [];
    if (user) {
      for await (
        const g of ctx.db.query("games").withIndex("by_user", (q) => q.eq("userId", user._id))
      ) {
        bytesUsed += g.totalBytes;
        let versionCount = 0;
        for await (
          const _s of ctx.db
            .query("saves")
            .withIndex("by_game_version", (q) => q.eq("gameId", g._id))
        ) {
          versionCount += 1;
        }
        games.push({
          nameKey: g.nameKey,
          displayName: g.displayName,
          totalBytes: g.totalBytes,
          latestSourceMtime: g.latestSourceMtime,
          versions: versionCount,
        });
      }
    }
    return {
      subject: identity.subject,
      email: user?.email ?? null,
      games,
      bytesUsed,
      quotaBytes: QUOTA_BYTES,
      maxSaveBytes: MAX_SAVE_BYTES,
      keepVersions: KEEP_VERSIONS,
    };
  },
});
