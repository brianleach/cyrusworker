# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Commands

```bash
npm run dev          # Start local dev server (requires Docker)
npm run deploy       # Deploy to Cloudflare Workers
npm run typecheck    # Run TypeScript type checking
npm run tail         # Tail production logs
```

## Architecture

CyrusWorker runs Cyrus Community Edition (Claude Code-powered Linear agent) on Cloudflare's edge infrastructure using the Sandbox SDK.

### Components

**Worker (src/index.ts)** - Single-file Cloudflare Worker handling all routes:
- `/health` - Health check endpoint
- `/webhook` - Receives Linear AgentSessionEvent webhooks, auto-bootstraps if needed, forwards to Cyrus
- `/callback` - Linear OAuth callback for app installation
- `/_admin/` - Admin UI for monitoring, managing repos, viewing logs
- `/api/*` - Internal API routes (bootstrap, status, config, repos, storage)

**Sandbox Container (Dockerfile)** - Runs in Cloudflare Containers with:
- Node.js (20 in the `cloudflare/sandbox` base image; 22 in `Dockerfile.local`), git, GitHub CLI
- Claude Code CLI (`@anthropic-ai/claude-code`)
- Cyrus Community Edition from npm (`cyrus-ai`), pinned to an exact version in the Dockerfile
- Working directories: `/root/.cyrus/repos`, `/root/.cyrus/worktrees`

**Cyrus EdgeWorker** - Runs inside the container on port 3456:
- Receives forwarded webhooks from the Worker
- Processes issues using Claude Code
- Posts responses back to Linear

### Data Flow

1. User delegates issue to Cyrus or @mentions it in Linear
2. Linear sends AgentSessionEvent webhook to Worker
3. Worker verifies signature using `LINEAR_WEBHOOK_SECRET`
4. Worker checks if Cyrus is running (health check to port 3456)
5. If Cyrus is not running, Worker auto-bootstraps (restore from R2, clone repos, start Cyrus)
6. Worker forwards webhook to Cyrus EdgeWorker at `localhost:3456/linear-webhook`
7. Cyrus processes the issue using Claude Code and responds in Linear

### API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | Returns "OK" - health check |
| `/webhook` | POST | Linear AgentSessionEvent webhook receiver (auto-bootstraps if needed) |
| `/callback` | GET | Linear OAuth callback |
| `/api/bootstrap` | POST | Full bootstrap: restore config, clone repos, start Cyrus |
| `/api/status` | GET | Sandbox process and disk status |
| `/api/config` | GET | Current Cyrus config JSON |
| `/api/version` | GET | Installed `cyrus` CLI version (works while Cyrus is offline) |
| `/api/init` | POST | Initialize Cyrus .env file from Worker secrets |
| `/api/start` | POST | Start Cyrus EdgeWorker |
| `/api/workspaces` | GET | Authorized Linear workspaces (id + name) from R2 |
| `/api/add-repo` | POST | Add repository to Cyrus (JSON body: `{url: string, workspace?: string}`); resolves the workspace Worker-side, 400s on ambiguity |
| `/api/refresh-token` | POST | Refresh every workspace's OAuth token and sync into config.json |
| `/api/sync-tokens` | POST | Sync stored credentials into `config.linearWorkspaces` |
| `/api/restore` | POST | Restore config/tokens from R2 to sandbox |
| `/api/save` | POST | Save config/tokens from sandbox to R2 |
| `/api/restart` | POST | Restart container processes |
| `/api/backup` | POST | Backup full ~/.cyrus to R2 |
| `/api/exec` | POST | Execute command in sandbox (JSON body: `{command: string}`) |
| `/_admin/` | GET | Admin UI (HTML) |

### R2 Storage Structure

Config and state are persisted to R2 bucket (`CYRUS_STORAGE`):

```
config/
  config.json      # Cyrus configuration with repositories
  .env             # Environment variables
  repo-urls.json   # Clone URLs for auto-restore
tokens/
  {orgId}.json     # OAuth tokens by organization (source of truth)
  latest.json      # Most recent OAuth token (duplicate of one of the above)
backups/
  latest.tar.gz    # Full ~/.cyrus backup
  {timestamp}.tar.gz
```

### Bindings

- `Sandbox` - Durable Object namespace for sandbox containers
- `CYRUS_STORAGE` - R2 bucket for config persistence

## Secrets

Set via `npx wrangler secret put <NAME>`:
- `ANTHROPIC_API_KEY` - Claude API key for Claude Code
- `GH_TOKEN` - GitHub PAT for PR creation
- `GIT_USER_NAME`, `GIT_USER_EMAIL` - Git commit identity
- `LINEAR_CLIENT_ID` - Linear OAuth Application client ID
- `LINEAR_CLIENT_SECRET` - Linear OAuth Application client secret
- `LINEAR_WEBHOOK_SECRET` - Linear OAuth Application webhook signing secret
- `GATEWAY_TOKEN` (recommended) - Token to protect Admin UI (`/_admin/?token=...`)
- `GIT_SSH_PRIVATE_KEY` (optional) - SSH key for private repos

## Security Model

Authentication is handled by:
- **Webhook endpoint**: Linear signature verification (HMAC-SHA256 with `LINEAR_WEBHOOK_SECRET`)
- **Admin UI**: Protected by `GATEWAY_TOKEN` query parameter (access via `/_admin/?token=...`)
- **API routes**: Protected by `GATEWAY_TOKEN` query parameter (same as Admin UI)
- **External APIs**: Protected by API keys (Anthropic, GitHub)

The `GATEWAY_TOKEN` never leaves the Worker - it's checked before any sandbox calls are made, so the container never sees it.

## HIPAA/PHI Considerations

Linear issues may contain PHI/PII. The following measures minimize exposure:

- **Webhook forwarding** - Issue data forwarded to Cyrus, not logged by Worker
- **`/api/status` uses minimal `ps` output** - no command arguments shown
- **No `console.log` of issue content** - only webhook type/action logged

**Remaining exposure points (by design):**
- `/api/exec` returns command output - required for debugging
- Admin UI displays logs and exec output
- R2 backups may include cached issue data in ~/.cyrus

When working on this codebase, avoid adding logging that could capture issue titles, descriptions, or other PHI/PII.

## Key Functions

- `runBootstrap()` - Full bootstrap sequence: kill Cyrus, restore from R2, init env, clone repos, start Cyrus
- `handleAgentSessionWebhook()` - Receives webhooks, auto-bootstraps if needed, forwards to Cyrus
- `restoreConfigFromR2()` - Restores config.json and .env from R2 to sandbox
- `saveConfigToR2()` - Saves config.json, .env, repo URLs from sandbox to R2
- `syncConfigCredentials()` - Writes stored Linear tokens into `config.linearWorkspaces` (the only place Cyrus reads them)
- `refreshOAuthTokensIfNeeded()` - Refreshes every org's OAuth token that is expiring
- `writeSandboxFile()` - base64 file write; use for anything containing secrets
- `cloneMissingRepos()` - Clones repositories that exist in config but not on disk
- `handleOAuthCallback()` - Exchanges OAuth code for tokens, stores in R2
- `handleAdminUI()` - Returns admin dashboard HTML

## Setup: Linear OAuth Authorization

After deploying the worker:

1. Visit the authorization URL:
   ```
   https://linear.app/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=https://YOUR_WORKER.workers.dev/callback&response_type=code&scope=write,app:assignable,app:mentionable&actor=app
   ```

2. Authorize the app for your workspace

3. Linear redirects to `/callback` which exchanges the code for tokens and stores them in R2

4. You should see "Authorization Complete!" with your organization name

5. Add a repository via Admin UI or API:
   ```bash
   curl -X POST "https://your-worker.workers.dev/api/add-repo?token=YOUR_GATEWAY_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"url": "https://github.com/org/repo"}'
   ```

**Note**: The `actor=app` parameter makes the OAuth token act as the Linear app (Cyrus) rather than your user account.

## Auto-Bootstrap

The webhook handler automatically bootstraps Cyrus on-demand when a webhook arrives:

1. Health check to `localhost:3456/status`
2. If not responding, run full bootstrap:
   - Kill any stuck Cyrus processes
   - Restore config from R2
   - Create .env with secrets
   - Configure git credentials
   - Clone missing repositories
   - Start Cyrus EdgeWorker
3. Forward webhook to Cyrus

This follows the serverless model - the container sleeps when idle and wakes up on demand when webhooks arrive, saving compute.

## Cyrus Source

**IMPORTANT**: Cyrus is published to npm as [`cyrus-ai`](https://www.npmjs.com/package/cyrus-ai) (source: https://github.com/cyrusagents/cyrus, formerly `ceedaragents/cyrus`; the old URL redirects)

- Installed via `npm install -g cyrus-ai@<version>` in the Dockerfile, **pinned to an exact version**
- Keep the pin. The Worker shells out to `cyrus <subcommand>`, so a floating
  install lets an upstream rename break this Worker with no change here. That
  already happened once: `cyrus self-auth` was renamed `self-auth-linear`.
- When bumping the pin, verify the subcommands the Worker calls still exist
  (`cyrus self-add-repo`, `cyrus start`) and that the config schema below is unchanged.
- Runs as an EdgeWorker server to receive webhooks and process issues via Claude Code

### Config format

Cyrus reads Linear credentials **only** from `linearWorkspaces`, keyed by Linear
organization id. A config with no repositories therefore has no credentials
unless `linearWorkspaces` is written explicitly - `cyrus self-add-repo` requires
at least one workspace to exist before it will add anything.

Per-repository `linearToken` is a legacy format. Cyrus migrates it into
`linearWorkspaces` on read and ignores it once `linearWorkspaces` is present, so
writing repo-level tokens does not refresh anything.

```json
{
  "linearWorkspaces": {
    "<linear-org-id>": {
      "linearToken": "lin_oauth_...",
      "linearRefreshToken": "...",
      "linearWorkspaceName": "Acme"
    }
  },
  "repositories": [{
    "name": "repo-name",
    "repositoryPath": "/root/.cyrus/repos/repo-name",
    "linearWorkspaceId": "<linear-org-id>"
  }]
}
```

`cyrus self-add-repo` prompts on stdin when more than one workspace exists and no
workspace name is given. There is no TTY under `sandbox.exec`, so that prompt
hangs the exec - `/api/add-repo` always resolves the workspace itself and passes
it positionally.

## Known TODOs

None at this time.
