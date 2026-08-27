import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    /** Clerk `sub` claim — stable user identifier. */
    subject: v.string(),
    /** Email surfaced for account UI; optional until first verified login. */
    email: v.optional(v.string()),
    createdAt: v.number(),
    /**
     * Envelope key protecting save payloads client-side. The plaintext key
     * never leaves the user's machine: this row merely mirrors it so other
     * devices can decrypt. TLS + authed endpoints guard retrieval.
     */
    dataKeyWrapped: v.optional(v.bytes()),
  }).index("by_subject", ["subject"]),

  games: defineTable({
    userId: v.id("users"),
    /** Sanitized game name key (same charset rules as the local engine). */
    nameKey: v.string(),
    displayName: v.string(),
    /** Newest manifest content clock across generations (source_max_mtime). */
    latestSourceMtime: v.number(),
    totalBytes: v.number(),
    createdAt: v.number(),
  })
    .index("by_user_and_name", ["userId", "nameKey"])
    .index("by_user", ["userId"]),

  saves: defineTable({
    gameId: v.id("games"),
    userId: v.id("users"),
    version: v.number(),
    /** File-storage id of the encrypted blob. Null while upload is pending. */
    storageId: v.optional(v.id("_storage")),
    state: v.union(
      v.literal("pending"),
      v.literal("confirmed"),
      v.literal("failed")
    ),
    sizeBytes: v.number(),
    plainSha256: v.string(),
    sourceMaxMtime: v.number(),
    createdAt: v.number(),
  })
    .index("by_game_version", ["gameId", "version"])
    .index("by_user", ["userId"])
    .index("by_state_created", ["state", "createdAt"]),
});
