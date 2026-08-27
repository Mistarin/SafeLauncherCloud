/** User provisioning and account/quota overview. */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireIdentity } from "./lib/api";
import { QUOTA_BYTES, MAX_SAVE_BYTES, KEEP_VERSIONS } from "./lib/limits";

/** Idempotently ensure a users row exists for the caller; returns its id. */
export const getOrCreateUser = mutation({
  args: {
    authSubject: v.optional(v.string()),
  },
  returns: v.id("users"),
  handler: async (ctx, args) => {
    let subject = args.authSubject;
    let email: string | undefined = "owner@self-hosted";
    if (!subject) {
      const identity = await requireIdentity(ctx);
      subject = identity.subject;
      email = identity.email;
    }
    const existing = await ctx.db
      .query("users")
      .withIndex("by_subject", (q) => q.eq("subject", subject!))
      .unique();
    if (existing) {
      if (email && existing.email !== email) {
        await ctx.db.patch(existing._id, { email });
      }
      return existing._id;
    }
    return ctx.db.insert("users", {
      subject: subject!,
      email: email,
      createdAt: Date.now(),
    });
  },
});

/**
 * Return this user's payload encryption key, generating it on first use.
 */
export const ensureDataKey = mutation({
  args: {
    authSubject: v.optional(v.string()),
  },
  returns: v.object({ dataKeyB64: v.string() }),
  handler: async (ctx, args) => {
    let subject = args.authSubject;
    if (!subject) {
      const identity = await requireIdentity(ctx);
      subject = identity.subject;
    }
    let user = await ctx.db
      .query("users")
      .withIndex("by_subject", (q) => q.eq("subject", subject!))
      .unique();
    if (!user) {
      const userId = await ctx.db.insert("users", {
        subject: subject!,
        email: "owner@self-hosted",
        createdAt: Date.now(),
      });
      user = (await ctx.db.get(userId))!;
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
  args: {
    authSubject: v.optional(v.string()),
  },
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
  handler: async (ctx, args) => {
    let subject = args.authSubject;
    let email: string | null = null;
    if (!subject) {
      const identity = await requireIdentity(ctx);
      subject = identity.subject;
      email = identity.email ?? null;
    }
    const user = await ctx.db
      .query("users")
      .withIndex("by_subject", (q) => q.eq("subject", subject!))
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
      email = user.email ?? email;
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
      subject: subject!,
      email: email,
      games,
      bytesUsed,
      quotaBytes: QUOTA_BYTES,
      maxSaveBytes: MAX_SAVE_BYTES,
      keepVersions: KEEP_VERSIONS,
    };
  },
});
