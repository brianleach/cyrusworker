# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

**Worker (src/index.ts)** - Cloudflare Worker that handles:
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
6. Config state backed up to R2 bucket (`CYRUS_STORAGE`)

### Bindings

- `Sandbox` - Durable Object namespace for sandbox containers (per-org isolation via `workspace-{organizationId}`)
- `CYRUS_STORAGE` - R2 bucket for config backups

## Secrets

Set via `npx wrangler secret put <NAME>`:
- `ANTHROPIC_API_KEY` - Claude API key
- `GH_TOKEN` - GitHub PAT for PR creation
- `GIT_USER_NAME`, `GIT_USER_EMAIL` - Git commit identity
- `LINEAR_WEBHOOK_SECRET` - Webhook signature verification

## Known TODOs

- `verifyLinearSignature()` needs proper HMAC-SHA256 implementation
- OAuth callback needs token exchange and R2 storage
- No Cloudflare Access JWT validation on admin routes yet
