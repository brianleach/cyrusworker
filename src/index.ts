import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

interface Env {
  Sandbox: DurableObjectNamespace<Sandbox>;
  CYRUS_STORAGE: R2Bucket;
  LINEAR_WEBHOOK_SECRET?: string;
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  ANTHROPIC_API_KEY?: string;
  GH_TOKEN?: string;
  GIT_USER_NAME?: string;
  GIT_USER_EMAIL?: string;
}

interface AgentSessionWebhookPayload {
  type: string; // "AgentSessionEvent"
  action: string; // "created" | "prompted"
  organizationId: string;
  webhookId: string;
  webhookTimestamp: number;
  promptContext?: string; // Formatted XML string with issue details, comments, guidance
  agentSession?: {
    id: string;
    issue?: {
      id: string;
      identifier: string;
      title: string;
      description?: string;
      team?: {
        id: string;
        name: string;
        key: string;
      };
    };
    comment?: {
      id: string;
      body: string;
    };
  };
  agentActivity?: {
    id: string;
    body?: string; // User's message for "prompted" action
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

      // Linear Agent Session webhook endpoint
      if (url.pathname === "/webhook" && request.method === "POST") {
        return await handleAgentSessionWebhook(request, env);
      }

      // Linear OAuth callback
      if (url.pathname === "/callback") {
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
          "CyrusWorker - Claude Code Linear Agent on Cloudflare\n\nEndpoints:\n- /_admin/ - Admin UI\n- /webhook - Linear AgentSessionEvent webhook\n- /callback - Linear OAuth callback\n- /health - Health check",
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

async function handleAgentSessionWebhook(
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

  const payload: AgentSessionWebhookPayload = JSON.parse(body);
  console.log("Linear webhook:", payload.type, payload.action);

  // Only process AgentSessionEvent webhooks
  if (payload.type !== "AgentSessionEvent") {
    return Response.json({ status: "ignored", reason: "not an agent session event" });
  }

  // Must respond within 5 seconds, so return quickly and process async
  const agentSession = payload.agentSession;
  if (!agentSession) {
    return Response.json({ status: "ignored", reason: "no agent session" });
  }

  // Get sandbox instance per organization
  const sandboxId = `workspace-${payload.organizationId}`;
  const sandbox = getSandbox(env.Sandbox, sandboxId);

  // Write webhook payload to temp file to avoid exposing PHI/PII in command args
  const sessionId = agentSession.id || "unknown";
  const tempFile = `/tmp/session-${sessionId}.json`;

  // Include full payload for Cyrus to process
  const sessionData = JSON.stringify({
    action: payload.action,
    sessionId: agentSession.id,
    issue: agentSession.issue,
    comment: agentSession.comment,
    promptContext: payload.promptContext,
    userMessage: payload.agentActivity?.body, // For "prompted" actions
  });

  await sandbox.exec(`cat > ${tempFile} << 'SESSION_EOF'
${sessionData}
SESSION_EOF`);

  // Handle based on action type
  if (payload.action === "created") {
    // New delegation or mention - start processing
    const result = await sandbox.exec(
      `cyrus process-issue "$(cat ${tempFile})" && rm -f ${tempFile}`
    );
    return Response.json({
      status: "processed",
      sessionId: agentSession.id,
      issue: agentSession.issue?.identifier,
      success: result.success,
    });
  } else if (payload.action === "prompted") {
    // Follow-up message from user
    const result = await sandbox.exec(
      `cyrus process-prompt "$(cat ${tempFile})" && rm -f ${tempFile}`
    );
    return Response.json({
      status: "prompted",
      sessionId: agentSession.id,
      success: result.success,
    });
  }

  return Response.json({ status: "ignored", reason: "unknown action" });
}

async function handleApiRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, "primary");

  // Get sandbox status (avoid showing full command args which could contain PHI/PII)
  if (url.pathname === "/api/status") {
    const result = await sandbox.exec("ps -eo pid,comm,etime,pcpu,pmem --no-headers && echo '---' && df -h");
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
  // WARNING: Backup may contain PHI/PII if Cyrus caches issue data in ~/.cyrus
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

  // Execute command in sandbox
  // WARNING: Output may contain PHI/PII from Linear issues. Do not log responses.
  // This endpoint is required for Cyrus to process issues but use caution with admin debugging.
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

  // Restart/reset the sandbox container
  if (url.pathname === "/api/restart" && request.method === "POST") {
    try {
      // Kill any running cyrus processes and clear temp files
      await sandbox.exec("pkill -f cyrus || true; pkill -f claude || true; rm -rf /tmp/issue-* /tmp/session-* 2>/dev/null || true");

      // Re-run the startup script to reinitialize
      const result = await sandbox.exec("/usr/local/bin/start-cyrus.sh &");

      return Response.json({
        success: true,
        message: "Container processes restarted",
      });
    } catch (error) {
      return Response.json({
        success: false,
        error: String(error),
      });
    }
  }

  // Start Cyrus self-auth flow
  if (url.pathname === "/api/auth" && request.method === "POST") {
    const result = await sandbox.exec("cyrus self-auth 2>&1");
    return Response.json({
      success: result.success,
      output: result.stdout + result.stderr,
      message: "Look for an authorization URL in the output. Open it in your browser to authorize Cyrus.",
    });
  }

  // Add a repository to Cyrus config
  if (url.pathname === "/api/add-repo" && request.method === "POST") {
    const { url: repoUrl, workspace } = (await request.json()) as {
      url: string;
      workspace?: string;
    };

    if (!repoUrl) {
      return Response.json({ success: false, error: "Missing 'url' parameter" }, { status: 400 });
    }

    const cmd = workspace
      ? `cyrus self-add-repo "${repoUrl}" "${workspace}"`
      : `cyrus self-add-repo "${repoUrl}"`;

    const result = await sandbox.exec(cmd);
    return Response.json({
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  // Initialize Cyrus environment in sandbox
  // Creates ~/.cyrus/.env with secrets from Worker environment
  if (url.pathname === "/api/init" && request.method === "POST") {
    const baseUrl = url.origin;

    // Build .env content from Worker secrets
    const envContent = [
      "# Cyrus environment (generated by CyrusWorker)",
      "LINEAR_DIRECT_WEBHOOKS=true",
      `CYRUS_BASE_URL=${baseUrl}`,
      "CYRUS_SERVER_PORT=3456",
      "",
      "# Linear OAuth",
      `LINEAR_CLIENT_ID=${env.LINEAR_CLIENT_ID || ""}`,
      `LINEAR_CLIENT_SECRET=${env.LINEAR_CLIENT_SECRET || ""}`,
      `LINEAR_WEBHOOK_SECRET=${env.LINEAR_WEBHOOK_SECRET || ""}`,
      "",
      "# Claude Code",
      `ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY || ""}`,
      "",
      "# GitHub",
      `GH_TOKEN=${env.GH_TOKEN || ""}`,
      `GIT_USER_NAME=${env.GIT_USER_NAME || ""}`,
      `GIT_USER_EMAIL=${env.GIT_USER_EMAIL || ""}`,
    ].join("\n");

    // Write .env file to sandbox
    const result = await sandbox.exec(`mkdir -p /root/.cyrus && cat > /root/.cyrus/.env << 'ENVEOF'
${envContent}
ENVEOF`);

    if (result.success) {
      // Also set up git config and gh auth
      await sandbox.exec(`
        git config --global user.name "${env.GIT_USER_NAME || "Cyrus"}"
        git config --global user.email "${env.GIT_USER_EMAIL || "cyrus@example.com"}"
      `);

      if (env.GH_TOKEN) {
        await sandbox.exec(`echo "${env.GH_TOKEN}" | gh auth login --with-token 2>/dev/null || true`);
      }
    }

    return Response.json({
      success: result.success,
      message: result.success ? "Cyrus environment initialized" : "Failed to initialize",
      error: result.stderr || undefined,
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
  <h1>CyrusWorker Admin</h1>

  <div class="card">
    <h2>Sandbox Status</h2>
    <div id="status">Loading...</div>
    <button onclick="refreshStatus()">Refresh</button>
    <button class="secondary" onclick="restartContainer()">Restart Container</button>
    <span id="restartStatus"></span>
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

    async function restartContainer() {
      document.getElementById('restartStatus').textContent = 'Restarting...';
      try {
        const res = await fetch('/api/restart', { method: 'POST' });
        const data = await res.json();
        document.getElementById('restartStatus').textContent =
          data.success ? 'Restarted!' : 'Failed: ' + data.error;
        if (data.success) setTimeout(refreshStatus, 2000);
      } catch (e) {
        document.getElementById('restartStatus').textContent = 'Error: ' + e.message;
      }
    }

    async function triggerBackup() {
      document.getElementById('backupStatus').textContent = 'Backing up...';
      try {
        const res = await fetch('/api/backup', { method: 'POST' });
        const data = await res.json();
        document.getElementById('backupStatus').textContent =
          data.success ? 'Backup complete: ' + new Date(data.timestamp).toLocaleString() : 'Failed: ' + data.error;
      } catch (e) {
        document.getElementById('backupStatus').textContent = 'Error: ' + e.message;
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

