/** User provisioning and account/quota overview. */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireIdentity } from "./lib/api";
import { QUOTA_BYTES, MAX_SAVE_BYTES, KEEP_VERSIONS } from "./lib/limits";

/** Idempotently ensure a users row exists for the subject; returns its id.
 *  Plain helper so other mutations can call it directly (registered
 *  mutations are not callable as functions). */
async function ensureUserRow(
  ctx: MutationCtx,
  subject: string,
  email: string = "owner@self-hosted"
): Promise<Id<"users">> {
  const existing = await ctx.db
    .query("users")
    .withIndex("by_subject", (q) => q.eq("subject", subject))
    .unique();
  if (existing) {
    if (email && existing.email !== email) {
      await ctx.db.patch(existing._id, { email });
    }
    return existing._id;
  }
  return ctx.db.insert("users", {
    subject,
    email,
    createdAt: Date.now(),
  });
}

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
    return ensureUserRow(ctx, subject!, email);
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
    concurrentDevices: v.number(),
    totalDevices: v.number(),
    devices: v.array(
      v.object({
        deviceId: v.string(),
        deviceName: v.string(),
        platform: v.string(),
        lastSeenAt: v.number(),
        isOnline: v.boolean(),
      })
    ),
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
    let devicesList: Array<{
      deviceId: string;
      deviceName: string;
      platform: string;
      lastSeenAt: number;
      isOnline: boolean;
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

      const now = Date.now();
      const onlineThreshold = now - 15 * 60 * 1000;
      const allDevices = await ctx.db
        .query("devices")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect();

      devicesList = allDevices.map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        platform: d.platform,
        lastSeenAt: d.lastSeenAt,
        isOnline: d.lastSeenAt >= onlineThreshold,
      }));
    }

    const concurrentDevices = devicesList.filter((d) => d.isOnline).length;

    return {
      subject: subject!,
      email: email,
      games,
      bytesUsed,
      quotaBytes: QUOTA_BYTES,
      maxSaveBytes: MAX_SAVE_BYTES,
      keepVersions: KEEP_VERSIONS,
      concurrentDevices,
      totalDevices: devicesList.length,
      devices: devicesList,
    };
  },
});

/** Heartbeat and register a connected device */
export const heartbeatDevice = mutation({
  args: {
    deviceId: v.string(),
    deviceName: v.string(),
    platform: v.optional(v.string()),
    authSubject: v.optional(v.string()),
  },
  returns: v.object({
    ok: v.boolean(),
    concurrentDevices: v.number(),
    devices: v.array(
      v.object({
        deviceId: v.string(),
        deviceName: v.string(),
        platform: v.string(),
        lastSeenAt: v.number(),
        isOnline: v.boolean(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    let subject = args.authSubject;
    if (!subject) {
      const identity = await requireIdentity(ctx);
      subject = identity.subject;
    }
    const userId = await ensureUserRow(ctx, subject!);
    const now = Date.now();

    const existingDevice = await ctx.db
      .query("devices")
      .withIndex("by_user_device", (q) =>
        q.eq("userId", userId).eq("deviceId", args.deviceId)
      )
      .unique();

    if (existingDevice) {
      await ctx.db.patch(existingDevice._id, {
        deviceName: args.deviceName,
        platform: args.platform ?? existingDevice.platform,
        lastSeenAt: now,
      });
    } else {
      await ctx.db.insert("devices", {
        userId: userId,
        deviceId: args.deviceId,
        deviceName: args.deviceName,
        platform: args.platform ?? "Linux",
        lastSeenAt: now,
        createdAt: now,
      });
    }

    const onlineThreshold = now - 15 * 60 * 1000;
    const allDevices = await ctx.db
      .query("devices")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const devicesList = allDevices.map((d) => ({
      deviceId: d.deviceId,
      deviceName: d.deviceName,
      platform: d.platform,
      lastSeenAt: d.lastSeenAt,
      isOnline: d.lastSeenAt >= onlineThreshold,
    }));

    const concurrentDevices = devicesList.filter((d) => d.isOnline).length;
    return { ok: true, concurrentDevices, devices: devicesList };
  },
});
