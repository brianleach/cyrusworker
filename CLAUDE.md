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

CyrusWorker runs the Cyrus AI agent (Claude Code-powered Linear agent) on Cloudflare's edge infrastructure using the Sandbox SDK.

### Components

**Worker (src/index.ts)** - Single-file Cloudflare Worker handling all routes:
- `/health` - Health check endpoint
- `/webhook/linear` - Receives Linear webhooks, verifies signatures, dispatches to sandbox
- `/_admin/` - Admin UI for monitoring sandbox status, viewing config, triggering backups
- `/api/*` - Internal API routes (status, config, backup, exec)
- `/oauth/callback` - Linear OAuth flow (incomplete)

**Sandbox Container (Dockerfile)** - Runs in Cloudflare Containers with:
- Node.js 22, git, GitHub CLI
- Claude Code CLI (`@anthropic-ai/claude-code`)
- Cyrus AI agent (`cyrus-ai`)
- Working directories: `/data/repos`, `/data/worktrees`, `/data/backup`

**Container Startup (start-cyrus.sh)** - Initializes container with:
- Git identity from env vars
- GitHub CLI auth via `GH_TOKEN`
- SSH key setup for private repos
- Cyrus config generation from template

### Data Flow

1. Linear webhook arrives at Worker
2. Worker verifies signature using `LINEAR_WEBHOOK_SECRET`
3. If issue is assigned to Cyrus (name/email contains "cyrus" or "claude"), Worker gets sandbox instance
4. Worker executes `cyrus process-issue` in sandbox via `sandbox.exec()`
5. Sandbox container runs Claude Code to process the issue
6. Config state can be backed up to R2 bucket (`CYRUS_STORAGE`)

### API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | Returns "OK" - health check |
| `/webhook/linear` | POST | Linear webhook receiver |
| `/api/status` | GET | Sandbox process and disk status |
| `/api/config` | GET | Current Cyrus config JSON |
| `/api/backup` | POST | Backup config to R2 |
| `/api/exec` | POST | Execute command in sandbox (JSON body: `{command: string}`) |
| `/_admin/` | GET | Admin UI (HTML) |

### Bindings

- `Sandbox` - Durable Object namespace for sandbox containers (per-org isolation via `workspace-{organizationId}`)
- `CYRUS_STORAGE` - R2 bucket for config backups

## Secrets

Set via `npx wrangler secret put <NAME>`:
- `ANTHROPIC_API_KEY` - Claude API key for Claude Code
- `GH_TOKEN` - GitHub PAT for PR creation
- `GIT_USER_NAME`, `GIT_USER_EMAIL` - Git commit identity
- `LINEAR_WEBHOOK_SECRET` - Webhook signature verification
- `GIT_SSH_PRIVATE_KEY` (optional) - SSH key for private repos

## Security Model

Authentication is handled by:
- **Webhook endpoint**: Linear signature verification (HMAC-SHA256 with `LINEAR_WEBHOOK_SECRET`)
- **API/Admin routes**: Publicly accessible but require sandbox to be running to do anything meaningful
- **External APIs**: Protected by API keys (Anthropic, GitHub)

No Cloudflare Zero Trust - the webhook signature verification and API keys provide sufficient protection.

## HIPAA/PHI Considerations

Linear issues may contain PHI/PII. The following measures minimize exposure:

- **Issue data passed via temp file** - not command args (avoids `ps aux` exposure)
- **Webhook response excludes stdout/stderr** - only returns success status
- **`/api/status` uses minimal `ps` output** - no command arguments shown
- **No `console.log` of issue content** - only webhook type/action logged

**Remaining exposure points (by design):**
- `/api/exec` returns command output - required for Cyrus to function
- `/api/backup` may include cached issue data in ~/.cyrus
- Admin UI displays exec output

When working on this codebase, avoid adding logging that could capture issue titles, descriptions, or other PHI/PII.

## Key Functions

- `handleLinearWebhook()` - Verifies signature, checks assignee, dispatches to sandbox
- `isCyrusAssignee()` - Returns true if assignee name/email contains "cyrus" or "claude"
- `verifyLinearSignature()` - TODO: needs proper HMAC-SHA256 implementation
- `handleAdminUI()` - Returns inline HTML for admin dashboard

## Known TODOs

- `verifyLinearSignature()` needs proper HMAC-SHA256 implementation (currently just checks signature exists)
- OAuth callback needs token exchange and R2 storage
