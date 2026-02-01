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
- `/webhook` - Receives Linear AgentSessionEvent webhooks (delegation, mentions, prompts)
- `/callback` - Linear OAuth callback for app installation
- `/_admin/` - Admin UI for monitoring sandbox status, viewing config, triggering backups
- `/api/*` - Internal API routes (status, config, backup, exec)

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

1. User delegates issue to Cyrus or @mentions it in Linear
2. Linear sends AgentSessionEvent webhook to Worker
3. Worker verifies signature using `LINEAR_WEBHOOK_SECRET`
4. Worker gets sandbox instance for the organization
5. Worker executes `cyrus process-issue` (for new sessions) or `cyrus process-prompt` (for follow-ups) in sandbox
6. Sandbox container runs Claude Code to process the issue
7. Config state can be backed up to R2 bucket (`CYRUS_STORAGE`)

### API Routes

| Route | Method | Description |
|-------|--------|-------------|
| `/health` | GET | Returns "OK" - health check |
| `/webhook` | POST | Linear AgentSessionEvent webhook receiver |
| `/callback` | GET | Linear OAuth callback |
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
- `LINEAR_CLIENT_ID` - Linear OAuth Application client ID
- `LINEAR_CLIENT_SECRET` - Linear OAuth Application client secret
- `LINEAR_WEBHOOK_SECRET` - Linear OAuth Application webhook signing secret
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

- `handleAgentSessionWebhook()` - Handles Linear AgentSessionEvent webhooks (created/prompted actions)
- `verifyLinearSignature()` - TODO: needs proper HMAC-SHA256 implementation
- `handleOAuthCallback()` - TODO: needs token exchange implementation
- `handleAdminUI()` - Returns inline HTML for admin dashboard

## Known TODOs

- `verifyLinearSignature()` needs proper HMAC-SHA256 implementation (currently just checks signature exists)
- OAuth callback needs token exchange and R2 storage
