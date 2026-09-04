/** Hard resource limits shared by every enforcement point. */

/** Maximum size in bytes of a single encrypted save blob upload. */
export const MAX_SAVE_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Per-user total budget across all games (encrypted blobs counted). */
export const QUOTA_BYTES = 1024 * 1024 * 1024; // 1 GiB (Convex Free Tier)

/** Historical generations retained per game after a confirmed upload.
 *  Two slots: the active save plus one backup generation, which conflict
 *  resolution uses to preserve the losing side of a fork. */
export const KEEP_VERSIONS = 2;

/** Minimum milliseconds between unauthenticated health spam checks. */
export const MAX_UPLOADS_PER_DAY = 1000;
