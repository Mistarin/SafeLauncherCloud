import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { ApiError, requireIdentity, isValidNameKey } from "./lib/api";

async function userBySubject(ctx: MutationCtx | QueryCtx, authSubject?: string) {
  const subject = authSubject ?? (await requireIdentity(ctx, undefined)).subject;
  return await ctx.db
    .query("users")
    .withIndex("by_subject", (q) => q.eq("subject", subject))
    .unique();
}

export const getMetadata = internalQuery({
  args: { authSubject: v.optional(v.string()), nameKey: v.string() },
  handler: async (ctx, args) => {
    if (!isValidNameKey(args.nameKey)) {
      throw new ApiError(400, "invalid_name_key", "Invalid game name key.");
    }
    const user = await userBySubject(ctx, args.authSubject);
    if (!user) return null;
    return await ctx.db
      .query("metadata")
      .withIndex("by_user_and_name", (q) =>
        q.eq("userId", user._id).eq("nameKey", args.nameKey)
      )
      .unique();
  },
});

export const putMetadata = internalMutation({
  args: {
    authSubject: v.optional(v.string()),
    nameKey: v.string(),
    appId: v.optional(v.string()),
    data: v.string(),
    revision: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!isValidNameKey(args.nameKey)) {
      throw new ApiError(400, "invalid_name_key", "Invalid game name key.");
    }
    if (args.data.length < 1 || args.data.length > 1024 * 1024) {
      throw new ApiError(413, "metadata_too_large", "Metadata payload is too large.");
    }
    const user = await userBySubject(ctx, args.authSubject);
    if (!user) throw new ApiError(401, "user_not_found", "User is not initialized.");

    const existing = await ctx.db
      .query("metadata")
      .withIndex("by_user_and_name", (q) =>
        q.eq("userId", user._id).eq("nameKey", args.nameKey)
      )
      .unique();
    if (existing && args.revision === undefined) {
      throw new ApiError(409, "metadata_revision_required", "Revision is required when updating metadata.", {
        revision: existing.revision,
      });
    }
    if (existing && args.revision !== existing.revision) {
      throw new ApiError(409, "metadata_revision_conflict", "Metadata revision is stale.", {
        revision: existing.revision,
      });
    }

    const updatedAt = Date.now();
    const revision = existing ? existing.revision + 1 : 1;
    const value = {
      userId: user._id,
      nameKey: args.nameKey,
      appId: args.appId,
      data: args.data,
      revision,
      updatedAt,
    };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("metadata", value);
    return { revision, updatedAt };
  },
});

/** Remove launcher metadata through the authenticated HTTP boundary only. */
export const deleteMetadata = internalMutation({
  args: { authSubject: v.string(), nameKey: v.string() },
  handler: async (ctx, args) => {
    if (!isValidNameKey(args.nameKey)) {
      throw new ApiError(400, "invalid_name_key", "Invalid game name key.");
    }
    const user = await userBySubject(ctx, args.authSubject);
    if (!user) return false;
    const existing = await ctx.db
      .query("metadata")
      .withIndex("by_user_and_name", (q) =>
        q.eq("userId", user._id).eq("nameKey", args.nameKey)
      )
      .unique();
    if (!existing) return false;
    await ctx.db.delete(existing._id);
    return true;
  },
});
