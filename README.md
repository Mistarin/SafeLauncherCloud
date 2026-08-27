# SafeLauncherCloud

Private, self-hosted cloud save synchronization backend for [SafeLauncher](https://github.com/Mistarin/SafeLauncher).

Stores client-encrypted game save backups on Convex File Storage with version rollback.

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

### 3. (Optional) Set a secret access key
To require a shared secret on API requests:
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
* **Self-hosted**: You control the Convex deployment. No external service has access to decrypted save files.
* **Automatic pruning**: Retains the 3 most recent save versions per game to stay within storage limits.

---

## Storage limits

| Parameter | Value |
| :--- | :--- |
| Max save upload size | 50 MiB per game save |
| Default storage quota | 1 GiB (matches Convex free tier) |
| Version history | 3 versions retained per game |

---

## API reference

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Liveness health check |
| `GET` | `/api/me` | Account overview and storage quota |
| `GET` | `/api/games` | List all backed-up games and version history |
| `POST` | `/api/games/{nameKey}/init-upload` | Request upload URL for save archive |
| `POST` | `/api/games/{nameKey}/confirm-upload` | Confirm upload and promote save version |
| `GET` | `/api/games/{nameKey}/download` | Fetch download URL for latest or specific version |
| `DELETE` | `/api/games/{nameKey}` | Delete a specific save generation |
