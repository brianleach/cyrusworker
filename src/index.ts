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

// Get OAuth token data from R2
async function getOAuthTokenFromR2(env: Env): Promise<{
  access_token: string;
  organization_id: string;
  organization_name: string;
} | null> {
  try {
    const tokenObj = await env.CYRUS_STORAGE.get("tokens/latest.json");
    if (!tokenObj) return null;

    return JSON.parse(await tokenObj.text()) as {
      access_token: string;
      organization_id: string;
      organization_name: string;
    };
  } catch (error) {
    console.error("Failed to get token from R2:", error);
    return null;
  }
}

// Build Cyrus config.json - returns empty config (repos added via cyrus self-add-repo)
// Note: We don't create incomplete repository entries that lack name/repositoryPath
// Those cause Cyrus EdgeWorker to fail with "Cannot read properties of undefined"
async function buildCyrusConfigFromTokens(_env: Env): Promise<{ config: object } | null> {
  // Return empty repositories array - actual repos get added via cyrus self-add-repo
  // which properly sets all required fields (name, repositoryPath, linearToken, etc.)
  return { config: { repositories: [] } };
}

// Helper to restore Cyrus config from R2 to sandbox
async function restoreConfigFromR2(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env
): Promise<{ restored: boolean; files: string[] }> {
  const files: string[] = [];

  try {
    // First try to restore saved config.json
    const configObj = await env.CYRUS_STORAGE.get("config/config.json");
    if (configObj) {
      const config = await configObj.text();
      const b64 = btoa(config);
      await sandbox.exec(`mkdir -p /root/.cyrus && echo ${b64} | base64 -d > /root/.cyrus/config.json`);
      files.push("config.json");
    } else {
      // No saved config - build from OAuth tokens
      const result = await buildCyrusConfigFromTokens(env);
      if (result) {
        const configJson = JSON.stringify(result.config, null, 2);
        const b64 = btoa(configJson);
        await sandbox.exec(`mkdir -p /root/.cyrus && echo ${b64} | base64 -d > /root/.cyrus/config.json`);
        files.push("config.json (built from tokens)");
      }
    }

    // Restore .env
    const envObj = await env.CYRUS_STORAGE.get("config/.env");
    if (envObj) {
      const envContent = await envObj.text();
      const b64 = btoa(envContent);
      await sandbox.exec(`mkdir -p /root/.cyrus && echo ${b64} | base64 -d > /root/.cyrus/.env`);
      files.push(".env");
    }

    // Restore tokens (for backup purposes, though Cyrus uses config.json)
    const tokenList = await env.CYRUS_STORAGE.list({ prefix: "tokens/" });
    for (const obj of tokenList.objects) {
      const tokenObj = await env.CYRUS_STORAGE.get(obj.key);
      if (tokenObj) {
        const tokenContent = await tokenObj.text();
        const filename = obj.key.replace("tokens/", "");
        const b64 = btoa(tokenContent);
        await sandbox.exec(`mkdir -p /root/.cyrus/tokens && echo ${b64} | base64 -d > /root/.cyrus/tokens/${filename}`);
        files.push(`tokens/${filename}`);
      }
    }

    return { restored: files.length > 0, files };
  } catch (error) {
    console.error("Failed to restore from R2:", error);
    return { restored: false, files: [] };
  }
}

// Helper to save Cyrus config to R2
async function saveConfigToR2(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env
): Promise<{ saved: boolean; files: string[] }> {
  const files: string[] = [];

  try {
    // Save config.json
    const configResult = await sandbox.exec("cat /root/.cyrus/config.json 2>/dev/null || echo ''");
    if (configResult.stdout && configResult.stdout.trim()) {
      await env.CYRUS_STORAGE.put("config/config.json", configResult.stdout);
      files.push("config.json");
    }

    // Save .env
    const envResult = await sandbox.exec("cat /root/.cyrus/.env 2>/dev/null || echo ''");
    if (envResult.stdout && envResult.stdout.trim()) {
      await env.CYRUS_STORAGE.put("config/.env", envResult.stdout);
      files.push(".env");
    }

    // Save tokens
    const tokensResult = await sandbox.exec("ls /root/.cyrus/tokens/ 2>/dev/null || echo ''");
    if (tokensResult.stdout && tokensResult.stdout.trim()) {
      const tokenFiles = tokensResult.stdout.trim().split("\n").filter(f => f);
      for (const tokenFile of tokenFiles) {
        const tokenContent = await sandbox.exec(`cat /root/.cyrus/tokens/${tokenFile}`);
        if (tokenContent.stdout) {
          await env.CYRUS_STORAGE.put(`tokens/${tokenFile}`, tokenContent.stdout);
          files.push(`tokens/${tokenFile}`);
        }
      }
    }

    return { saved: files.length > 0, files };
  } catch (error) {
    console.error("Failed to save to R2:", error);
    return { saved: false, files: [] };
  }
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
        return await handleOAuthCallback(request, env);
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

  // Get sandbox instance
  const sandbox = getSandbox(env.Sandbox, "primary");

  // Forward webhook to Cyrus running on port 3456 inside the container
  // Cyrus expects webhooks at /webhook endpoint
  try {
    const forwardResult = await sandbox.exec(
      `curl -s -X POST http://localhost:3456/webhook -H "Content-Type: application/json" -H "linear-signature: ${request.headers.get("linear-signature") || ""}" -d '${body.replace(/'/g, "'\\''")}'`
    );

    console.log("Forwarded to Cyrus, response:", forwardResult.stdout?.substring(0, 200));

    if (forwardResult.success && forwardResult.stdout) {
      try {
        const cyrusResponse = JSON.parse(forwardResult.stdout);
        return Response.json({
          status: "forwarded",
          cyrusResponse,
        });
      } catch {
        // Cyrus might return non-JSON
        return Response.json({
          status: "forwarded",
          cyrusResponse: forwardResult.stdout,
        });
      }
    }

    return Response.json({
      status: "forward_failed",
      error: forwardResult.stderr || "Unknown error",
    });
  } catch (error) {
    console.error("Failed to forward webhook:", error);
    return Response.json({
      status: "error",
      error: String(error),
    }, { status: 500 });
  }
}

async function handleApiRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, "primary");

  // Full bootstrap: restore config, init, setup git, start Cyrus
  if (url.pathname === "/api/bootstrap" && request.method === "POST") {
    const steps: string[] = [];

    // Step 1: Restore config from R2
    const restoreResult = await restoreConfigFromR2(sandbox, env);
    steps.push(`restore: ${restoreResult.restored ? "restored " + restoreResult.files.length + " files" : "no files"}`);

    // Step 2: Create .env file
    const baseUrl = url.origin;
    const gitName = env.GIT_USER_NAME || "Cyrus";
    const gitEmail = env.GIT_USER_EMAIL || "cyrus@example.com";
    const ghToken = env.GH_TOKEN || "";

    const envContent = [
      "# Cyrus environment (generated by CyrusWorker)",
      "LINEAR_DIRECT_WEBHOOKS=true",
      `CYRUS_BASE_URL=${baseUrl}`,
      "CYRUS_SERVER_PORT=3456",
      "CYRUS_HOST_EXTERNAL=true",
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
      `GH_TOKEN=${ghToken}`,
      `GIT_USER_NAME=${gitName}`,
      `GIT_USER_EMAIL=${gitEmail}`,
    ].join("\\n");

    await sandbox.exec(`mkdir -p /root/.cyrus && printf '${envContent}' > /root/.cyrus/.env`);
    steps.push("init: created .env");

    // Step 3: Configure git
    await sandbox.exec(`git config --global user.name "${gitName}" && git config --global user.email "${gitEmail}"`);
    if (ghToken) {
      await sandbox.exec(`echo "https://${ghToken}:x-oauth-basic@github.com" > ~/.git-credentials && git config --global credential.helper store`);
    }
    steps.push("git: configured");

    // Step 4: Check if Cyrus is already running
    const checkRunning = await sandbox.exec("pgrep -f 'cyrus start' && echo 'running' || echo 'not running'");
    if (checkRunning.stdout.includes("running")) {
      steps.push("cyrus: already running");
    } else {
      // Start Cyrus in background
      await sandbox.exec("nohup cyrus start > /var/log/cyrus.log 2>&1 &");
      await sandbox.exec("sleep 3");

      // Verify it started
      const checkStarted = await sandbox.exec("pgrep -f 'cyrus start' && echo 'started' || echo 'failed'");
      steps.push(`cyrus: ${checkStarted.stdout.includes("started") ? "started" : "failed to start"}`);
    }

    return Response.json({
      success: true,
      message: "Bootstrap complete",
      steps,
    });
  }

  // Restore config from R2 to sandbox
  if (url.pathname === "/api/restore" && request.method === "POST") {
    const result = await restoreConfigFromR2(sandbox, env);
    return Response.json({
      success: result.restored,
      message: result.restored ? "Config restored from R2" : "No config found in R2",
      files: result.files,
    });
  }

  // Save config from sandbox to R2
  if (url.pathname === "/api/save" && request.method === "POST") {
    const result = await saveConfigToR2(sandbox, env);
    return Response.json({
      success: result.saved,
      message: result.saved ? "Config saved to R2" : "No config to save",
      files: result.files,
    });
  }

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

  // Start Cyrus server (after init)
  if (url.pathname === "/api/start" && request.method === "POST") {
    // First check if .env exists
    const checkEnv = await sandbox.exec("test -f /root/.cyrus/.env && echo 'exists'");
    if (!checkEnv.stdout.includes("exists")) {
      return Response.json({
        success: false,
        error: "Run /api/init first to create .env file",
      }, { status: 400 });
    }

    // Check if Cyrus is already running
    const checkRunning = await sandbox.exec("pgrep -f 'cyrus start' && echo 'running'");
    if (checkRunning.stdout.includes("running")) {
      return Response.json({
        success: true,
        message: "Cyrus is already running",
      });
    }

    // Start Cyrus in background
    const result = await sandbox.exec("nohup cyrus start > /var/log/cyrus.log 2>&1 & sleep 2 && pgrep -f 'cyrus start' && echo 'started'");
    const started = result.stdout.includes("started");

    return Response.json({
      success: started,
      message: started ? "Cyrus started. Check /api/status for process list." : "Failed to start Cyrus",
      error: started ? undefined : result.stderr,
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
    const gitName = env.GIT_USER_NAME || "Cyrus";
    const gitEmail = env.GIT_USER_EMAIL || "cyrus@example.com";
    const ghToken = env.GH_TOKEN || "";

    // Build .env content (using printf to avoid heredoc issues with sandbox)
    const envContent = [
      "# Cyrus environment (generated by CyrusWorker)",
      "LINEAR_DIRECT_WEBHOOKS=true",
      `CYRUS_BASE_URL=${baseUrl}`,
      "CYRUS_SERVER_PORT=3456",
      "CYRUS_HOST_EXTERNAL=true",
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
      `GH_TOKEN=${ghToken}`,
      `GIT_USER_NAME=${gitName}`,
      `GIT_USER_EMAIL=${gitEmail}`,
    ].join("\\n");

    const initScript = `mkdir -p /root/.cyrus && printf '${envContent}' > /root/.cyrus/.env && git config --global user.name "${gitName}" && git config --global user.email "${gitEmail}" && echo "init complete"`;

    const result = await sandbox.exec(initScript);
    return Response.json({
      success: result.success,
      message: result.success ? "Cyrus environment initialized" : "Failed to initialize",
      error: result.stderr || undefined,
    });
  }

  // Sync OAuth tokens from R2 to sandbox
  if (url.pathname === "/api/sync-tokens" && request.method === "POST") {
    try {
      // Get latest token from R2
      const tokenObj = await env.CYRUS_STORAGE.get("tokens/latest.json");
      if (!tokenObj) {
        return Response.json({
          success: false,
          error: "No tokens found in R2. Complete OAuth first.",
        });
      }

      const tokenData = await tokenObj.text();
      const tokens = JSON.parse(tokenData);

      // Write token to sandbox in Cyrus format
      // Cyrus expects tokens in ~/.cyrus/tokens/<workspace>.json
      const tokenPath = `/root/.cyrus/tokens/${tokens.organization_name || "default"}.json`;

      // Use printf to write (avoid heredoc issues)
      const escapedToken = tokenData.replace(/'/g, "'\\''");
      const cmd = `mkdir -p /root/.cyrus/tokens && printf '${escapedToken}' > '${tokenPath}' && echo "Token synced to ${tokenPath}"`;

      const result = await sandbox.exec(cmd);

      return Response.json({
        success: result.success,
        message: result.success ? `Tokens synced for ${tokens.organization_name}` : "Failed to sync",
        stdout: result.stdout,
        stderr: result.stderr,
      });
    } catch (error) {
      return Response.json({
        success: false,
        error: String(error),
      });
    }
  }

  return new Response("Not Found", { status: 404 });
}

async function handleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Debug logging
  console.log("OAuth callback received:", {
    hasCode: !!code,
    hasError: !!error,
    error: error || undefined,
    state: state || undefined
  });

  // Handle OAuth errors
  if (error) {
    const errorDescription = url.searchParams.get("error_description") || "Unknown error";
    return new Response(
      `OAuth Error: ${error}\n\n${errorDescription}`,
      { status: 400, headers: { "Content-Type": "text/plain" } }
    );
  }

  if (!code) {
    return new Response(
      "Missing authorization code",
      { status: 400, headers: { "Content-Type": "text/plain" } }
    );
  }

  if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) {
    return new Response(
      "OAuth not configured: missing LINEAR_CLIENT_ID or LINEAR_CLIENT_SECRET",
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }

  try {
    // Exchange authorization code for tokens
    const tokenResponse = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: env.LINEAR_CLIENT_ID,
        client_secret: env.LINEAR_CLIENT_SECRET,
        redirect_uri: `${url.origin}/callback`,
        code,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error("Token exchange failed:", errorText);
      return new Response(
        `Token exchange failed: ${tokenResponse.status}\n\n${errorText}`,
        { status: 500, headers: { "Content-Type": "text/plain" } }
      );
    }

    const tokens = await tokenResponse.json() as {
      access_token: string;
      token_type: string;
      expires_in?: number;
      scope?: string;
    };

    // Get organization info to identify the workspace
    const orgResponse = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({
        query: `{ organization { id name } }`,
      }),
    });

    let orgInfo = { id: "unknown", name: "Unknown Workspace" };
    if (orgResponse.ok) {
      const orgData = await orgResponse.json() as { data?: { organization?: { id: string; name: string } } };
      if (orgData.data?.organization) {
        orgInfo = orgData.data.organization;
      }
    }

    // Store tokens in R2 for persistence
    const tokenData = {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      organization_id: orgInfo.id,
      organization_name: orgInfo.name,
      created_at: Date.now(),
    };

    await env.CYRUS_STORAGE.put(
      `tokens/${orgInfo.id}.json`,
      JSON.stringify(tokenData, null, 2)
    );

    // Also store as "latest" for easy access
    await env.CYRUS_STORAGE.put(
      "tokens/latest.json",
      JSON.stringify(tokenData, null, 2)
    );

    // NOTE: Skipping sandbox write here - it causes timeouts during OAuth flow
    // Tokens are stored in R2 and can be synced to sandbox via /api/init
    console.log("OAuth tokens stored in R2 for org:", orgInfo.id, orgInfo.name);

    // Return success page
    const html = `<!DOCTYPE html>
<html>
<head>
  <title>Cyrus - Authorization Complete</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
    .success { color: #155724; background: #d4edda; padding: 20px; border-radius: 8px; }
    .info { background: #f8f9fa; padding: 15px; border-radius: 4px; margin-top: 20px; }
    code { background: #e9ecef; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <div class="success">
    <h2>✅ Authorization Complete!</h2>
    <p>Cyrus is now connected to <strong>${orgInfo.name}</strong>.</p>
  </div>
  <div class="info">
    <p><strong>Next steps:</strong></p>
    <ol>
      <li>Add a repository using the admin panel or API</li>
      <li>Delegate an issue to Cyrus in Linear</li>
    </ol>
    <p>Organization ID: <code>${orgInfo.id}</code></p>
  </div>
  <p>You can close this window.</p>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html" },
    });

  } catch (error) {
    console.error("OAuth callback error:", error);
    return new Response(
      `OAuth callback error: ${error}`,
      { status: 500, headers: { "Content-Type": "text/plain" } }
    );
  }
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

