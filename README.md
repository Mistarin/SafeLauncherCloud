# SafeLauncherCloud

Private, self-hosted cloud save synchronization backend for [SafeLauncher](https://github.com/Mistarin/SafeLauncher).

Stores client-encrypted game save backups on Convex File Storage with version rollback,
plus separate launcher-owned metadata for achievements, playtime, and last-played state.

---

## Quickstart

### 1. Create a Convex account
1. Sign up at [convex.dev](https://convex.dev).
2. Install the Convex CLI:
   ```bash
   npm install -g convex
   ```

### 2. Clone and deploy
```bash
git clone https://github.com/Mistarin/SafeLauncherCloud.git
cd SafeLauncherCloud
npm install

# Deploy to your Convex project
npx convex deploy
```

### 3. Set the secret access key
The API fails closed until a shared secret is configured:
```bash
npx convex env set SAFELAUNCHER_SECRET_KEY your-secret-passphrase
```

### 4. Connect to SafeLauncher
Run the setup wizard in SafeLauncher:
```bash
safelauncher --setup-cloud
```
* Enter your **Convex Site URL** (e.g. `https://your-project.convex.site`)
* Enter your **Secret Key** (if configured)

---

## Security and privacy

* **Client-side AES-256-GCM encryption**: Save archives are encrypted locally before upload over HTTPS.
* **Self-hosted**: You control the Convex deployment. Save archives and launcher metadata are encrypted client-side before upload. The current account key-recovery design is not zero-knowledge: an administrator with database and deployment access can recover the account key.
* **Automatic pruning**: Retains the 2 most recent save versions per game (active plus one backup) to stay within storage limits.

---

## Storage limits

| Parameter | Value |
| :--- | :--- |
| Max save upload size | 50 MiB per game save |
| Default storage quota | 1 GiB (matches Convex free tier) |
| Version history | 2 versions retained per game (active plus one backup) |

---

## API reference

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Liveness health check |
| `GET` | `/api/me` | Account overview and storage quota |
| `GET` | `/api/games` | List all backed-up games and version history |
| `GET` | `/api/games/{nameKey}/metadata` | Fetch encrypted SafeLauncher-owned achievements/playtime metadata |
| `PUT` | `/api/games/{nameKey}/metadata` | Store encrypted metadata with revision checking |
| `DELETE` | `/api/games/{nameKey}/metadata` | Delete launcher-owned metadata for a game |
| `POST` | `/api/games/{nameKey}/init-upload` | Request upload URL for save archive |
| `POST` | `/api/games/{nameKey}/confirm-upload` | Confirm upload and promote save version |
| `GET` | `/api/games/{nameKey}/download` | Fetch download URL for latest or specific version |
| `DELETE` | `/api/games/{nameKey}` | Delete a specific save generation |

Metadata is encrypted by the desktop client before upload and is stored in a
separate table from game save archives. This allows achievements, playtime,
and last-played state to synchronize even when no game save is detectable.
The `PUT` endpoint accepts `{ data, revision?, appId? }` for creation; updates
to an existing record require the current revision. A stale or missing update
revision returns HTTP 409 with the current revision so the client can merge
and retry.
