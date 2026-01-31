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

## Linear Webhook Setup

1. Go to Linear Settings -> API -> Webhooks
2. Add URL: `https://your-worker.workers.dev/webhook/linear`
3. Select events: Issue create, update
4. Copy signing secret to `LINEAR_WEBHOOK_SECRET`

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
| `CF_ACCESS_TEAM_DOMAIN` | No | Cloudflare Access team domain |
| `CF_ACCESS_AUD` | No | Cloudflare Access audience |

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
