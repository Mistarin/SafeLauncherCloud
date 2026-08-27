/**
 * External identity provider wiring.
 *
 * SafeLauncher desktop clients authenticate against Clerk (OAuth2 + PKCE,
 * system-browser flow) and send the resulting JWT as an `Authorization:
 * Bearer` header on every Convex HTTP action. Convex verifies the token
 * signature against the issuer's JWKS before any handler runs.
 *
 * Deployment env vars:
 *   CLERK_ISSUER_DOMAIN — Clerk Frontend API URL, e.g. https://x-y-z.clerk.accounts.dev
 *   CLERK_JWKS_URL      — e.g. {CLERK_ISSUER_DOMAIN}/.well-known/jwks.json
 *   CLERK_JWT_AUDIENCE  — exact `aud` claim of accepted tokens (omitted only
 *                         while the value is unconfirmed; add it before prod).
 */
import type { AuthConfig } from "convex/server";

const issuer = process.env.CLERK_ISSUER_DOMAIN ?? "";
// Set CLERK_JWT_AUDIENCE="unconfirmed" until the access token's actual `aud`
// claim has been observed once; flip it to the real value afterwards so
// tokens for other audiences are rejected outright.
const rawAudience = process.env.CLERK_JWT_AUDIENCE ?? "";
const confirmedAudience =
  rawAudience && rawAudience !== "unconfirmed" ? rawAudience : "";

const authConfig: AuthConfig = {
  providers: [
    {
      type: "customJwt",
      issuer,
      jwks: process.env.CLERK_JWKS_URL ?? `${issuer}/.well-known/jwks.json`,
      algorithm: "RS256",
      ...(confirmedAudience ? { applicationID: confirmedAudience } : {}),
    },
  ],
};

export default authConfig;
