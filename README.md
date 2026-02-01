# CyrusWorker

Run [Cyrus](https://github.com/ceedaragents/cyrus) (Claude Code-powered Linear agent) on Cloudflare's edge infrastructure using Sandbox SDK.

Inspired by [Moltworker](https://github.com/cloudflare/moltworker).

## Why CyrusWorker?

Instead of running Cyrus on a local Mac mini or VPS:

- **No hardware required** - Runs in Cloudflare Sandbox containers
- **Always on** - No need to keep a local machine running
- **Global edge** - Low latency webhook processing worldwide
- **Persistent storage** - R2 backup of config and state
- **Secure** - Optional Cloudflare Access authentication

## Requirements

- [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5/month) - Required for Sandbox
- [Anthropic API key](https://console.anthropic.com/) - For Claude Code
- [GitHub PAT](https://github.com/settings/tokens) - For PR creation
- Linear workspace

## Quick Start
```bash
# Install dependencies
npm install

# Set required secrets
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put GH_TOKEN
npx wrangler secret put GIT_USER_NAME
npx wrangler secret put GIT_USER_EMAIL
npx wrangler secret put LINEAR_WEBHOOK_SECRET

# Deploy (requires Docker running)
npm run deploy
```

## Configuring Cyrus

Cyrus is configured via `/root/.cyrus/config.json` inside the container. The initial config is generated from `cyrus-config.template.json` on first startup.

### Adding Repositories

Edit `cyrus-config.template.json` before deploying to add repositories Cyrus can work with:

```json
{
  "repositories": [
    {
      "url": "git@github.com:your-org/your-repo.git",
      "path": "/data/repos/your-repo"
    }
  ],
  "promptDefaults": {
    "debugger": { "allowedTools": "readOnly" },
    "builder": { "allowedTools": "safe" },
    "scoper": { "allowedTools": ["Read(**)", "WebFetch", "Task"] }
  }
}
```

### Tool Permission Modes

Cyrus operates in different modes depending on the task:

| Mode | Allowed Tools | Use Case |
|------|--------------|----------|
| `debugger` | `readOnly` | Investigating issues, reading logs |
| `builder` | `safe` | Writing code, creating PRs |
| `scoper` | `Read`, `WebFetch`, `Task` | Scoping work, research |

### Updating Config After Deployment

Use the Admin UI (`/_admin/`) to:
1. View current config via the Config panel
2. Execute commands to edit config: `vi /root/.cyrus/config.json`
3. Backup config to R2 for persistence across restarts

## Connecting to Linear

### Step 1: Create a Cyrus User in Linear

Cyrus processes issues assigned to it. The worker identifies Cyrus by checking if the assignee's name or email contains "cyrus" or "claude" (case-insensitive).

Options:
- **Invite a team member** with email like `cyrus@your-domain.com`
- **Create a service account** named "Cyrus" or "Claude"

### Step 2: Create a Webhook

1. Go to **Linear Settings → API → Webhooks**
2. Click **New webhook**
3. Set the URL: `https://your-worker.workers.dev/webhook/linear`
4. Select events:
   - **Issue created** - Cyrus processes new issues assigned to it
   - **Issue updated** - Cyrus responds to assignment changes and updates
5. Copy the **Signing secret**

### Step 3: Configure the Webhook Secret

```bash
npx wrangler secret put LINEAR_WEBHOOK_SECRET
# Paste the signing secret from Linear
```

### How It Works

1. When an issue is created or updated in Linear, a webhook is sent to your worker
2. The worker verifies the webhook signature using `LINEAR_WEBHOOK_SECRET`
3. If the issue is assigned to a user with "cyrus" or "claude" in their name/email:
   - A sandbox container is started (or reused) for that Linear organization
   - Cyrus processes the issue: `cyrus process-issue '{issueData}'`
   - The sandbox persists for subsequent requests
4. Unassigned issues or issues assigned to other users are ignored

### Testing the Integration

1. Create a test issue in Linear
2. Assign it to your Cyrus user
3. Check the Admin UI for sandbox status and logs
4. View worker logs: `npm run tail`

## Admin UI

Access at: `https://your-worker.workers.dev/_admin/`

## Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Claude API key for Claude Code |
| `GH_TOKEN` | Yes | GitHub PAT for PR creation |
| `GIT_USER_NAME` | Yes | Git commit author name |
| `GIT_USER_EMAIL` | Yes | Git commit author email |
| `LINEAR_WEBHOOK_SECRET` | Yes | Linear webhook signing secret |
| `GIT_SSH_PRIVATE_KEY` | No | SSH private key for private repos |
| `CF_ACCESS_TEAM_DOMAIN` | No | Cloudflare Access team domain |
| `CF_ACCESS_AUD` | No | Cloudflare Access audience |

### Where to Get Each Secret

#### ANTHROPIC_API_KEY
1. Go to [Anthropic Console](https://console.anthropic.com/)
2. Sign in or create an account
3. Navigate to **API Keys** in the sidebar
4. Click **Create Key**
5. Copy the key (starts with `sk-ant-`)

#### GH_TOKEN
1. Go to [GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens](https://github.com/settings/tokens?type=beta)
2. Click **Generate new token**
3. Set a name and expiration
4. Under **Repository access**, select the repos Cyrus should access
5. Under **Permissions → Repository permissions**, enable:
   - **Contents**: Read and write (for commits)
   - **Pull requests**: Read and write (for creating PRs)
   - **Metadata**: Read-only (required)
6. Click **Generate token** and copy it (starts with `github_pat_` or `ghp_`)

#### GIT_USER_NAME / GIT_USER_EMAIL
These are used for git commits. Use values that identify Cyrus:
```bash
npx wrangler secret put GIT_USER_NAME
# Enter: Cyrus

npx wrangler secret put GIT_USER_EMAIL
# Enter: cyrus@your-domain.com
```

#### LINEAR_WEBHOOK_SECRET
1. Go to [Linear Settings → API → Webhooks](https://linear.app/settings/api/webhooks)
2. Create a new webhook (see [Connecting to Linear](#connecting-to-linear))
3. After creating, the **Signing secret** is displayed
4. Copy the secret value

#### GIT_SSH_PRIVATE_KEY (Optional)
Only needed for SSH access to private repos. Generate a new key:
```bash
ssh-keygen -t ed25519 -C "cyrus@your-domain.com" -f cyrus-key -N ""
```
- Add `cyrus-key.pub` as a deploy key in your GitHub repo settings
- Use `cyrus-key` (private key) as the secret value

#### CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD (Optional)
For protecting the Admin UI with Cloudflare Access:
1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access → Applications**
3. Create a new application for your worker
4. **Team domain**: Found in **Settings → Custom Pages** (e.g., `yourteam.cloudflareaccess.com`)
5. **Audience (AUD)**: Found in your application's settings under **Overview → Application Audience (AUD) Tag**

## Private Repository Access

For private GitHub repositories, you have two options:

### Option 1: GitHub PAT (HTTPS)

The `GH_TOKEN` is automatically used by GitHub CLI for HTTPS operations. Configure your repositories with HTTPS URLs:

```json
{
  "repositories": [
    {
      "url": "https://github.com/your-org/private-repo.git",
      "path": "/data/repos/private-repo"
    }
  ]
}
```

### Option 2: SSH Key

For SSH access, set the `GIT_SSH_PRIVATE_KEY` secret:

```bash
# Generate a deploy key (or use existing)
ssh-keygen -t ed25519 -C "cyrus@your-domain.com" -f cyrus-key

# Add public key to GitHub repo as deploy key
# Then set the private key as a secret
npx wrangler secret put GIT_SSH_PRIVATE_KEY < cyrus-key
```

Configure repositories with SSH URLs:

```json
{
  "repositories": [
    {
      "url": "git@github.com:your-org/private-repo.git",
      "path": "/data/repos/private-repo"
    }
  ]
}
```

## Local Development
```bash
# Create .dev.vars with secrets
cp .dev.vars.example .dev.vars

# Start dev server (requires Docker)
npm run dev
```

## Architecture

See [PROMPT-KICKSTART.md](./PROMPT-KICKSTART.md) for full architecture details.

## License

MIT
