You are in an empty `cyrusworker` directory. Initialize git early and commit often throughout this setup.

## First Steps

1. `git init`
2. Save this entire prompt to `PROMPT-KICKSTART.md`
3. Commit: `git commit -m "docs: add kickstart prompt"`

## Project Overview

CyrusWorker runs [Cyrus](https://github.com/ceedaragents/cyrus) (Claude Code-powered Linear agent) on Cloudflare's edge infrastructure using Sandbox SDK. Instead of running on a local Mac mini or VPS, it runs entirely on Cloudflare Workers + Containers.

Inspired by [Moltworker](https://github.com/cloudflare/moltworker) which runs Moltbot AI assistant on Cloudflare Sandbox.

## Architecture
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                               │
│  ┌──────────────┐    ┌─────────────────────────────────────┐   │
│  │   Worker     │    │        Sandbox Container             │   │
│  │              │    │  ┌─────────────────────────────────┐ │   │
│  │ - Webhook RX │───▶│  │  - Node.js 22                   │ │   │
│  │ - Auth/OAuth │    │  │  - Claude Code CLI              │ │   │
│  │ - Admin UI   │◀───│  │  - Cyrus agent                  │ │   │
│  │ - R2 backup  │    │  │  - git + gh CLI                 │ │   │
│  └──────────────┘    │  └─────────────────────────────────┘ │   │
│         │            └─────────────────────────────────────────┘   │
│         │                          │                              │
│    ┌────▼────┐              ┌──────▼──────┐                      │
│    │   R2    │              │  AI Gateway │                      │
│    │ Storage │              │  (Anthropic)│                      │
│    └─────────┘              └─────────────┘                      │
└─────────────────────────────────────────────────────────────────┘
▲                           │
│                           ▼
┌────┴────┐               ┌─────────────┐
│ Linear  │               │   GitHub    │
│Webhooks │               │  (PRs)      │
└─────────┘               └─────────────┘

## Target Project Structure
cyrusworker/
├── src/
│   ├── index.ts              # Main Worker entrypoint
│   ├── routes/
│   │   ├── webhook.ts        # Linear webhook handler
│   │   ├── oauth.ts          # Linear OAuth callback
│   │   ├── admin.ts          # Admin UI routes
│   │   └── api.ts            # Internal API routes
│   ├── sandbox/
│   │   └── manager.ts        # Sandbox lifecycle management
│   └── utils/
│       ├── linear.ts         # Linear API helpers
│       ├── r2.ts             # R2 backup/restore
│       └── auth.ts           # Cloudflare Access validation
├── Dockerfile                # Sandbox container image
├── start-cyrus.sh            # Container startup script
├── cyrus-config.template.json  # Cyrus config template
├── wrangler.jsonc            # Cloudflare configuration
├── package.json
├── tsconfig.json
├── README.md
├── PROMPT-KICKSTART.md       # This file
└── .gitignore

## Step-by-Step Implementation

### Step 1: Git init + this prompt
````bash
git init
# Save this prompt to PROMPT-KICKSTART.md
git add PROMPT-KICKSTART.md
git commit -m "docs: add kickstart prompt"
````

### Step 2: Create .gitignore
node_modules/
dist/
.dev.vars
.wrangler/
*.log
Commit: `git commit -m "chore: add gitignore"`

### Step 3: Create package.json
````json
{
  "name": "cyrusworker",
  "version": "0.1.0",
  "description": "Run Cyrus (Claude Code Linear agent) on Cloudflare Workers + Sandbox",
  "main": "src/index.ts",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail",
    "typecheck": "tsc --noEmit"
  },
  "keywords": ["cloudflare", "workers", "cyrus", "linear", "claude-code", "ai-agent"],
  "license": "MIT",
  "dependencies": {
    "@cloudflare/sandbox": "^0.1.0"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250124.0",
    "typescript": "^5.3.0",
    "wrangler": "^3.100.0"
  }
}
````
Commit: `git commit -m "chore: add package.json"`

### Step 4: Create tsconfig.json
````json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
````
Commit: `git commit -m "chore: add tsconfig"`

### Step 5: Create wrangler.jsonc
````jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cyrusworker",
  "main": "src/index.ts",
  "compatibility_date": "2025-01-30",
  "compatibility_flags": ["nodejs_compat"],

  "containers": [
    {
      "class_name": "Sandbox",
      "image": "./Dockerfile",
      "instance_type": "standard-1",
      "max_instances": 5
    }
  ],

  "durable_objects": {
    "bindings": [
      {
        "class_name": "Sandbox",
        "name": "Sandbox"
      }
    ]
  },

  "migrations": [
    {
      "new_sqlite_classes": ["Sandbox"],
      "tag": "v1"
    }
  ],

  "r2_buckets": [
    {
      "binding": "CYRUS_STORAGE",
      "bucket_name": "cyrusworker-data"
    }
  ],

  "vars": {
    "SANDBOX_SLEEP_AFTER": "never"
  }
}
````
Commit: `git commit -m "config: add wrangler.jsonc"`

### Step 6: Create Dockerfile
````dockerfile
# Build cache bust: 2025-01-31-v1
FROM cloudflare/sandbox:latest

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    git \
    openssh-client \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install Cyrus
RUN npm install -g cyrus-ai

# Create working directories
RUN mkdir -p /root/.cyrus /data/repos /data/worktrees /data/backup

# Copy startup script and config template
COPY start-cyrus.sh /usr/local/bin/start-cyrus.sh
COPY cyrus-config.template.json /root/cyrus-config.template.json
RUN chmod +x /usr/local/bin/start-cyrus.sh

WORKDIR /data

CMD ["/usr/local/bin/start-cyrus.sh"]
````
Commit: `git commit -m "docker: add Dockerfile for sandbox container"`

### Step 7: Create start-cyrus.sh
````bash
#!/bin/bash
set -e

echo "=== CyrusWorker Container Starting ==="
echo "Date: $(date)"

# Restore config from mounted backup if available
if [ -d "/data/backup/.cyrus" ]; then
    echo "Restoring Cyrus config from backup..."
    cp -r /data/backup/.cyrus/* /root/.cyrus/ 2>/dev/null || true
fi

# Configure git identity
if [ -n "$GIT_USER_NAME" ]; then
    git config --global user.name "$GIT_USER_NAME"
    echo "Git user.name: $GIT_USER_NAME"
fi
if [ -n "$GIT_USER_EMAIL" ]; then
    git config --global user.email "$GIT_USER_EMAIL"
    echo "Git user.email: $GIT_USER_EMAIL"
fi

# GitHub CLI authentication
if [ -n "$GH_TOKEN" ]; then
    echo "$GH_TOKEN" | gh auth login --with-token
    echo "GitHub CLI authenticated"
    gh auth status
fi

# SSH key setup for private repos
if [ -n "$GIT_SSH_PRIVATE_KEY" ]; then
    mkdir -p /root/.ssh
    echo "$GIT_SSH_PRIVATE_KEY" > /root/.ssh/id_ed25519
    chmod 600 /root/.ssh/id_ed25519
    ssh-keyscan github.com >> /root/.ssh/known_hosts 2>/dev/null
    echo "SSH key configured"
fi

# Generate Cyrus config from template if not exists
if [ ! -f "/root/.cyrus/config.json" ]; then
    echo "Generating Cyrus config from template..."
    if command -v envsubst &> /dev/null; then
        envsubst < /root/cyrus-config.template.json > /root/.cyrus/config.json
    else
        cp /root/cyrus-config.template.json /root/.cyrus/config.json
    fi
fi

# Anthropic API key for Claude Code
if [ -n "$ANTHROPIC_API_KEY" ]; then
    export ANTHROPIC_API_KEY
    echo "Anthropic API key configured"
fi

echo "=== Container Ready ==="
echo "Cyrus config: /root/.cyrus/config.json"
echo "Repos dir: /data/repos"
echo "Worktrees dir: /data/worktrees"

# Keep container running, wait for commands from Worker
exec tail -f /dev/null
````
Commit: `git commit -m "docker: add container startup script"`

### Step 8: Create cyrus-config.template.json
````json
{
  "repositories": [],
  "promptDefaults": {
    "debugger": {
      "allowedTools": "readOnly"
    },
    "builder": {
      "allowedTools": "safe"
    },
    "scoper": {
      "allowedTools": ["Read(**)", "WebFetch", "Task"]
    }
  }
}
````
Commit: `git commit -m "config: add cyrus config template"`

### Step 9: Create src/index.ts
````typescript
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  CYRUS_STORAGE: R2Bucket;
  LINEAR_WEBHOOK_SECRET?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ANTHROPIC_API_KEY?: string;
  GH_TOKEN?: string;
  GIT_USER_NAME?: string;
  GIT_USER_EMAIL?: string;
}

interface LinearWebhookPayload {
  type: string;
  action: string;
  organizationId: string;
  data?: {
    id: string;
    identifier: string;
    title: string;
    assignee?: {
      id: string;
      name: string;
      email: string;
    };
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Health check
      if (url.pathname === "/health") {
        return new Response("OK", { status: 200 });
      }

      // Linear webhook endpoint
      if (url.pathname === "/webhook/linear" && request.method === "POST") {
        return await handleLinearWebhook(request, env);
      }

      // Linear OAuth callback
      if (url.pathname === "/oauth/callback") {
        return handleOAuthCallback(request, env);
      }

      // Admin UI
      if (url.pathname === "/_admin" || url.pathname === "/_admin/") {
        return handleAdminUI(request, env);
      }

      // API routes
      if (url.pathname.startsWith("/api/")) {
        return await handleApiRoutes(request, env, url);
      }

      // Root
      if (url.pathname === "/") {
        return new Response(
          "CyrusWorker - Claude Code Linear Agent on Cloudflare\n\nEndpoints:\n- /_admin/ - Admin UI\n- /webhook/linear - Linear webhook\n- /health - Health check",
          { headers: { "Content-Type": "text/plain" } }
        );
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("Request error:", error);
      return new Response(`Internal Error: ${error}`, { status: 500 });
    }
  },
};

async function handleLinearWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  const body = await request.text();

  // Verify webhook signature if secret is configured
  if (env.LINEAR_WEBHOOK_SECRET) {
    const signature = request.headers.get("linear-signature");
    if (!verifyLinearSignature(body, signature, env.LINEAR_WEBHOOK_SECRET)) {
      return new Response("Invalid signature", { status: 401 });
    }
  }

  const payload: LinearWebhookPayload = JSON.parse(body);
  console.log("Linear webhook:", payload.type, payload.action);

  // Only process issue updates
  if (payload.type !== "Issue") {
    return Response.json({ status: "ignored", reason: "not an issue" });
  }

  // Check if assigned to Cyrus
  const assignee = payload.data?.assignee;
  if (!assignee || !isCyrusAssignee(assignee)) {
    return Response.json({ status: "ignored", reason: "not assigned to cyrus" });
  }

  // Get sandbox instance
  const sandboxId = `workspace-${payload.organizationId}`;
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  // Process issue in sandbox
  const issueJson = JSON.stringify(payload.data);
  const result = await sandbox.exec(
    `echo 'Processing issue: ${payload.data?.identifier}' && cyrus process-issue '${issueJson}'`
  );

  return Response.json({
    status: "processed",
    issue: payload.data?.identifier,
    success: result.success,
    output: result.stdout,
    error: result.stderr,
  });
}

async function handleApiRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, "primary");

  // Get sandbox status
  if (url.pathname === "/api/status") {
    const result = await sandbox.exec("ps aux && echo '---' && df -h");
    return Response.json({
      output: result.stdout,
      success: result.success,
    });
  }

  // Get config
  if (url.pathname === "/api/config") {
    const result = await sandbox.exec("cat /root/.cyrus/config.json 2>/dev/null || echo '{}'");
    try {
      return Response.json(JSON.parse(result.stdout));
    } catch {
      return Response.json({});
    }
  }

  // Trigger backup
  if (url.pathname === "/api/backup" && request.method === "POST") {
    const result = await sandbox.exec(
      "tar -czf /tmp/cyrus-backup.tar.gz -C /root .cyrus 2>/dev/null && base64 /tmp/cyrus-backup.tar.gz"
    );

    if (result.success && result.stdout) {
      const backupData = Uint8Array.from(atob(result.stdout.trim()), (c) =>
        c.charCodeAt(0)
      );
      const timestamp = Date.now();
      await env.CYRUS_STORAGE.put("backups/latest.tar.gz", backupData);
      await env.CYRUS_STORAGE.put(`backups/${timestamp}.tar.gz`, backupData);
      return Response.json({ success: true, timestamp });
    }

    return Response.json({ success: false, error: result.stderr });
  }

  // Execute command (protected - only for admin)
  if (url.pathname === "/api/exec" && request.method === "POST") {
    const { command } = (await request.json()) as { command: string };
    const result = await sandbox.exec(command);
    return Response.json({
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
  }

  return new Response("Not Found", { status: 404 });
}

function handleOAuthCallback(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  // TODO: Exchange code for tokens, store in R2
  console.log("OAuth callback:", { code: !!code, state });

  return new Response(
    "OAuth complete! You can close this window and return to CyrusWorker.",
    { headers: { "Content-Type": "text/plain" } }
  );
}

function handleAdminUI(request: Request, env: Env): Response {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CyrusWorker Admin</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 900px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    h1 { color: #333; }
    .card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin: 16px 0;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .card h2 { margin-top: 0; color: #444; }
    button {
      background: #0066cc;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 8px;
    }
    button:hover { background: #0055aa; }
    button.secondary { background: #666; }
    pre {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 16px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 13px;
    }
    .status {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 14px;
    }
    .status.ok { background: #d4edda; color: #155724; }
    .status.error { background: #f8d7da; color: #721c24; }
    input[type="text"] {
      width: 100%;
      padding: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
      margin-bottom: 8px;
    }
  </style>
</head>
<body>
  <h1>🤖 CyrusWorker Admin</h1>

  <div class="card">
    <h2>Sandbox Status</h2>
    <div id="status">Loading...</div>
    <button onclick="refreshStatus()">Refresh</button>
  </div>

  <div class="card">
    <h2>Configuration</h2>
    <pre id="config">Loading...</pre>
    <button onclick="loadConfig()">Reload Config</button>
  </div>

  <div class="card">
    <h2>Backup</h2>
    <p>Backup Cyrus config to R2 storage.</p>
    <button onclick="triggerBackup()">Backup Now</button>
    <span id="backupStatus"></span>
  </div>

  <div class="card">
    <h2>Execute Command</h2>
    <input type="text" id="cmdInput" placeholder="Enter command (e.g., ls -la /root/.cyrus)" />
    <button onclick="execCommand()">Execute</button>
    <pre id="cmdOutput"></pre>
  </div>

  <script>
    async function refreshStatus() {
      document.getElementById('status').innerHTML = 'Loading...';
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        document.getElementById('status').innerHTML =
          '<span class="status ok">Running</span><pre>' + (data.output || 'No output') + '</pre>';
      } catch (e) {
        document.getElementById('status').innerHTML =
          '<span class="status error">Error</span><pre>' + e.message + '</pre>';
      }
    }

    async function loadConfig() {
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        document.getElementById('config').textContent = JSON.stringify(data, null, 2);
      } catch (e) {
        document.getElementById('config').textContent = 'Error: ' + e.message;
      }
    }

    async function triggerBackup() {
      document.getElementById('backupStatus').textContent = 'Backing up...';
      try {
        const res = await fetch('/api/backup', { method: 'POST' });
        const data = await res.json();
        document.getElementById('backupStatus').textContent =
          data.success ? '✓ Backup complete: ' + new Date(data.timestamp).toLocaleString() : '✗ Failed: ' + data.error;
      } catch (e) {
        document.getElementById('backupStatus').textContent = '✗ Error: ' + e.message;
      }
    }

    async function execCommand() {
      const cmd = document.getElementById('cmdInput').value;
      if (!cmd) return;
      document.getElementById('cmdOutput').textContent = 'Executing...';
      try {
        const res = await fetch('/api/exec', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: cmd })
        });
        const data = await res.json();
        document.getElementById('cmdOutput').textContent =
          (data.stdout || '') + (data.stderr ? '\\nSTDERR:\\n' + data.stderr : '');
      } catch (e) {
        document.getElementById('cmdOutput').textContent = 'Error: ' + e.message;
      }
    }

    // Initial load
    refreshStatus();
    loadConfig();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

function verifyLinearSignature(
  body: string,
  signature: string | null,
  secret: string
): boolean {
  // TODO: Implement HMAC-SHA256 verification
  // For now, just check signature exists
  if (!signature) return false;
  return true;
}

function isCyrusAssignee(assignee: { name?: string; email?: string }): boolean {
  const name = assignee.name?.toLowerCase() || "";
  const email = assignee.email?.toLowerCase() || "";
  return (
    name.includes("cyrus") ||
    email.includes("cyrus") ||
    name.includes("claude") ||
    email.includes("claude")
  );
}
````
Commit: `git commit -m "feat: add main worker entrypoint with webhook, admin UI, and API routes"`

### Step 10: Create README.md
````markdown
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

1. Go to Linear Settings → API → Webhooks
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
````
Commit: `git commit -m "docs: add README"`

### Step 11: Create .dev.vars.example
ANTHROPIC_API_KEY=sk-ant-...
GH_TOKEN=ghp_...
GIT_USER_NAME=Your Name
GIT_USER_EMAIL=you@example.com
LINEAR_WEBHOOK_SECRET=...
Commit: `git commit -m "docs: add .dev.vars.example"`

### Step 12: Install dependencies and verify
````bash
npm install
npm run typecheck
````
Commit: `git commit -m "chore: install dependencies"`

### Step 13: Final commit with all files
````bash
git add -A
git commit -m "feat: initial cyrusworker implementation"
````

## Post-Setup Verification

1. Ensure Docker is running: `docker info`
2. Login to Cloudflare: `wrangler login`
3. Test locally: `npm run dev`
4. Deploy: `npm run deploy`

## Known Challenges to Address

1. **Claude Code Auth** - CLI uses OAuth; may need API key workaround
2. **Git Operations** - SSH keys or HTTPS tokens for private repos
3. **Worktree Persistence** - May need selective R2 backup strategy
4. **Cyrus Headless Mode** - May need to contribute `--headless` flag upstream

## Next Steps After Initial Setup

- [ ] Implement proper Linear webhook signature verification (HMAC-SHA256)
- [ ] Add Cloudflare Access JWT validation for admin routes
- [ ] Test end-to-end with a real Linear issue
- [ ] Add repository cloning via admin UI
- [ ] Implement R2 restore on container startup
- [ ] Add AI Gateway integration for cost tracking
- [ ] Consider forking Cyrus for headless/webhook mode
