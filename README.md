# SafeLauncherCloud — Self-Hosted Convex Cloud Save Backend

Private, self-hosted cloud save synchronization backend for [SafeLauncher](https://github.com/Mistarin/SafeLauncher).

Provides zero-knowledge encrypted game save backups on Convex File Storage with version rollback and zero maintenance overhead.

---

## ⚡ 2-Minute Quick Start

### 1. Create a Free Convex Account
1. Visit [convex.dev](https://convex.dev) and sign up (100% free with 1 GB storage & bandwidth).
2. Install the Convex CLI if you haven't already:
   ```bash
   npm install -g convex
   ```

### 2. Clone & Deploy Your Private Cloud
```bash
git clone https://github.com/Mistarin/SafeLauncherCloud.git
cd SafeLauncherCloud
npm install

# Deploy directly to your free Convex account
npx convex deploy
```

### 3. (Optional) Set a Secret Access Key
To protect your instance with a secret passphrase:
```bash
npx convex env set SAFELAUNCHER_SECRET_KEY your-super-secret-passphrase
```

### 4. Connect to SafeLauncher
Run the terminal setup wizard in SafeLauncher:
```bash
safelauncher --setup-cloud
```
* Enter your **Convex Site URL** (e.g. `https://your-project.convex.site`)
* Enter your **Secret Key** (if configured)
* SafeLauncher will verify the connection and begin syncing your game saves automatically!

---

## 🔒 Security & Privacy

* **Client-Side AES-256-GCM Encryption**: Save archives are encrypted on your local machine before being sent over HTTPS.
* **100% Private**: You own your Convex instance. No third parties have access to your save files.
* **Automatic Pruning**: Retains the latest 3 save generations per game automatically to optimize storage quota.

---

## 📊 Storage Limits

| Parameter | Value |
| :--- | :--- |
| **Max Save Upload Size** | 50 MiB per game save |
| **Default Storage Quota** | 1 GiB (Matches Convex free tier) |
| **Version History** | 3 versions retained per game |

---

## 🛠️ API Reference

| Method | Endpoint | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Liveness health check |
| `GET` | `/api/me` | Account overview & storage quota |
| `GET` | `/api/games` | List all backed-up games & version history |
| `POST` | `/api/games/{nameKey}/init-upload` | Request upload URL for save archive |
| `POST` | `/api/games/{nameKey}/confirm-upload` | Confirm upload & promote save version |
| `GET` | `/api/games/{nameKey}/download` | Fetch download URL for latest or specific version |
| `DELETE` | `/api/games/{nameKey}` | Delete a specific save generation |
