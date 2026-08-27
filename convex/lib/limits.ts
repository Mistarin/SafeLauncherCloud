/** Hard resource limits shared by every enforcement point. */

/** Maximum size in bytes of a single encrypted save blob upload. */
export const MAX_SAVE_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Per-user total budget across all games (encrypted blobs counted). */
export const QUOTA_BYTES = 200 * 1024 * 1024; // 200 MiB

/** Historical generations retained per game after a confirmed upload. */
export const KEEP_VERSIONS = 3;

/** Minimum milliseconds between unauthenticated health spam checks. */
export const MAX_UPLOADS_PER_DAY = 1000;
