# SafeLauncherDatabase — Convex Backend

Cloud save storage for [SafeLauncher](../SafeLauncher): user accounts via
Clerk, encrypted save archives on Convex File Storage, per-user quotas.

## Limits (`convex/lib/limits.ts`)

| Limit | Value |
|---|---|
| Max upload size | 10 MiB |
| Per-user quota | 200 MiB |
| Retained versions per game | 3 |

## API surface (`https://<deployment>.convex.site/api/*`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | liveness probe (no auth) |
| GET | `/api/me` | quota overview + game list |
| GET | `/api/key` | this user's payload encryption key (b64) |
| POST | `/api/games/{nameKey}/init-upload` | validate limits → pending row + expiring upload URL |
| POST | `/api/games/{nameKey}/confirm-upload` | verify blob metadata, assign version, evict old generations |
| GET | `/api/games` | all games incl. version stats for conflict checks |
| GET | `/api/games/{nameKey}/download[?version=N]` | authed resolve of the stored blob URL |
| DELETE | `/api/games/{nameKey}` `{version}` | drop one generation manually |

Every route except `/api/health` requires `Authorization: Bearer <JWT>` and
scopes all data access to the token subject.

## First-time setup

**Status: COMPLETE for the dev instance.** Instance
`upright-stallion-9201.clerk.accounts.dev` (app `app_3IUrFLINy7fN8Gwx3NVlXHitVfr`),
OAuth application `safelauncher-desktop`
(client id `tthAomibiA7PVISf`, public PKCE, redirect `http://127.0.0.1/callback`,
scopes profile/email/offline_access). Environment variables on the dev
deployment point at this instance; `CLERK_JWT_AUDIENCE` is currently the
sentinel value `unconfirmed`.

Remaining after the first real sign-in:

1. Decode SafeLauncher's stored access token locally and note its exact
   `aud` claim.
2. Pin it: `npx convex env set CLERK_JWT_AUDIENCE <aud-claim>` (replaces the
   `unconfirmed` sentinel, which skips audience verification).
3. Production (`npx convex deploy` → moonlit-sockeye-565): repeat the env
   vars for that deployment, then flip cloud_mode endpoints accordingly.

Reference steps as performed (for future instances):

1. **Create a Clerk application** at https://dashboard.clerk.com (free):
   - Enable sign-in methods you want (email/password, Google, …).
   - Copy the **Frontend API URL** (e.g. `https://verb-noun-00.clerk.accounts.dev`).
   - Create an **OAuth Application** (Configure → OAuth Applications): set
     redirect URI `http://127.0.0.1/callback`, mark *public*, enable PKCE,
     scope `profile email offline_access`. Copy its **Client ID**.
     (Equivalent to `POST https://api.clerk.com/v1/oauth_applications` with a
     secret key + `PATCH {id}` for the public/pkce/redirect fields.)
2. **Set environment variables** on the deployments:

   ```bash
   npx convex env set CLERK_ISSUER_DOMAIN <frontend-api-url>
   npx convex env set CLERK_JWKS_URL <frontend-api-url>/.well-known/jwks.json
   npx convex env set CLERK_JWT_AUDIENCE <aud-claim>
   ```

3. **Deploy**: dev auto-pushes via `npx convex dev`; production:

   ```bash
   npx convex deploy          # targets moonlit-sockeye-565
   ```

## Desktop-side configuration (SafeLauncher)

QSettings org/app `SafeLauncher` keys:

* `clerk_domain` — frontend API URL
* `clerk_client_id` — OAuth application client id
* `convex_site_url` — e.g. `https://moonlit-sockeye-565.convex.site`
* `cloud_mode` — `local` (default) or `convex`

Env overrides: `SAFELAUNCHER_CLERK_DOMAIN`, `SAFELAUNCHER_CLERK_CLIENT_ID`,
`SAFELAUNCHER_CONVEX_SITE_URL`.

Secrets handling: tokens live in `~/.local/share/safelauncher/auth.json`
(0600); payloads are AES-256-GCM sealed on-device before leaving the machine.
