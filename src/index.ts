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
  GATEWAY_TOKEN?: string;
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
  refresh_token?: string;
  created_at?: number;
  expires_in?: number;
} | null> {
  try {
    const tokenObj = await env.CYRUS_STORAGE.get("tokens/latest.json");
    if (!tokenObj) return null;

    return JSON.parse(await tokenObj.text());
  } catch (error) {
    console.error("Failed to get token from R2:", error);
    return null;
  }
}

// Refresh OAuth token if expired or about to expire
async function refreshOAuthTokenIfNeeded(env: Env): Promise<{
  refreshed: boolean;
  access_token?: string;
  error?: string;
}> {
  const tokenData = await getOAuthTokenFromR2(env);
  if (!tokenData) {
    return { refreshed: false, error: "No token found" };
  }

  // Check if token is expired or will expire in next 5 minutes
  const now = Date.now();
  const expiresAt = (tokenData.created_at || 0) + ((tokenData.expires_in || 86400) * 1000);
  const fiveMinutes = 5 * 60 * 1000;

  if (now < expiresAt - fiveMinutes) {
    // Token is still valid
    return { refreshed: false, access_token: tokenData.access_token };
  }

  // Token is expired or about to expire - try to refresh
  if (!tokenData.refresh_token) {
    return { refreshed: false, error: "Token expired and no refresh token available" };
  }

  if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) {
    return { refreshed: false, error: "Missing OAuth credentials for refresh" };
  }

  console.log("Refreshing expired OAuth token...");

  try {
    const refreshResponse = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: env.LINEAR_CLIENT_ID,
        client_secret: env.LINEAR_CLIENT_SECRET,
        refresh_token: tokenData.refresh_token,
      }),
    });

    if (!refreshResponse.ok) {
      const errorText = await refreshResponse.text();
      console.error("Token refresh failed:", errorText);
      return { refreshed: false, error: `Refresh failed: ${refreshResponse.status}` };
    }

    const newTokens = await refreshResponse.json() as {
      access_token: string;
      token_type: string;
      expires_in?: number;
      scope?: string;
      refresh_token?: string;
    };

    // Update stored tokens
    const updatedTokenData = {
      ...tokenData,
      access_token: newTokens.access_token,
      expires_in: newTokens.expires_in,
      refresh_token: newTokens.refresh_token || tokenData.refresh_token,
      created_at: Date.now(),
    };

    await env.CYRUS_STORAGE.put(
      `tokens/${tokenData.organization_id}.json`,
      JSON.stringify(updatedTokenData, null, 2)
    );
    await env.CYRUS_STORAGE.put(
      "tokens/latest.json",
      JSON.stringify(updatedTokenData, null, 2)
    );

    console.log("OAuth token refreshed successfully");
    return { refreshed: true, access_token: newTokens.access_token };
  } catch (error) {
    console.error("Token refresh error:", error);
    return { refreshed: false, error: String(error) };
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

      // Also save repo clone URLs for each repository
      try {
        const config = JSON.parse(configResult.stdout) as { repositories?: Array<{ name: string; repositoryPath: string }> };
        if (config.repositories) {
          const repoUrls: Record<string, string> = {};
          for (const repo of config.repositories) {
            if (repo.repositoryPath && repo.name) {
              const urlResult = await sandbox.exec(`git -C "${repo.repositoryPath}" remote get-url origin 2>/dev/null || echo ''`);
              if (urlResult.stdout && urlResult.stdout.trim()) {
                // Strip any embedded credentials from the URL before saving
                let cleanUrl = urlResult.stdout.trim();
                // Remove patterns like https://token:x-oauth-basic@github.com -> https://github.com
                cleanUrl = cleanUrl.replace(/https:\/\/[^@]+@/, "https://");
                repoUrls[repo.name] = cleanUrl;
              }
            }
          }
          if (Object.keys(repoUrls).length > 0) {
            await env.CYRUS_STORAGE.put("config/repo-urls.json", JSON.stringify(repoUrls, null, 2));
            files.push("repo-urls.json");
          }
        }
      } catch (e) {
        console.error("Failed to save repo URLs:", e);
      }
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

// Helper to clone missing repositories
async function cloneMissingRepos(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  ghToken: string
): Promise<{ cloned: string[]; skipped: string[]; failed: string[] }> {
  const cloned: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  try {
    // Get repo URLs from R2
    const repoUrlsObj = await env.CYRUS_STORAGE.get("config/repo-urls.json");
    if (!repoUrlsObj) {
      return { cloned, skipped, failed };
    }
    const repoUrls = JSON.parse(await repoUrlsObj.text()) as Record<string, string>;

    // Get config to find repo paths
    const configObj = await env.CYRUS_STORAGE.get("config/config.json");
    if (!configObj) {
      return { cloned, skipped, failed };
    }
    const config = JSON.parse(await configObj.text()) as { repositories?: Array<{ name: string; repositoryPath: string }> };

    if (!config.repositories) {
      return { cloned, skipped, failed };
    }

    // Check each repo and clone if missing
    for (const repo of config.repositories) {
      if (!repo.name || !repo.repositoryPath) continue;

      // Check if repo directory exists and has .git
      const checkResult = await sandbox.exec(`test -d "${repo.repositoryPath}/.git" && echo 'exists' || echo 'missing'`);

      if (checkResult.stdout.includes("exists")) {
        skipped.push(repo.name);
        continue;
      }

      // Get clone URL
      const cloneUrl = repoUrls[repo.name];
      if (!cloneUrl) {
        failed.push(`${repo.name} (no URL)`);
        continue;
      }

      // Inject auth token into URL if it's a GitHub URL and doesn't already have auth
      let authUrl = cloneUrl;
      if (ghToken && cloneUrl.includes("github.com") && !cloneUrl.includes("@github.com")) {
        authUrl = cloneUrl.replace("https://", `https://${ghToken}:x-oauth-basic@`);
      }

      // Clone the repo
      const cloneResult = await sandbox.exec(`git clone "${authUrl}" "${repo.repositoryPath}" 2>&1`);
      if (cloneResult.exitCode === 0) {
        cloned.push(repo.name);
      } else {
        failed.push(`${repo.name} (${cloneResult.stderr || cloneResult.stdout || 'unknown error'})`);
      }
    }
  } catch (error) {
    console.error("Failed to clone repos:", error);
  }

  return { cloned, skipped, failed };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      // Health check
      if (url.pathname === "/health") {
        return new Response("OK", { status: 200 });
      }

      // Linear Agent Session webhook endpoint
      if (url.pathname === "/webhook" && request.method === "POST") {
        return await handleAgentSessionWebhook(request, env, ctx);
      }

      // Linear OAuth callback
      if (url.pathname === "/callback") {
        return await handleOAuthCallback(request, env, ctx);
      }

      // Admin UI (protected by gateway token)
      if (url.pathname === "/_admin" || url.pathname === "/_admin/") {
        // Verify gateway token
        if (env.GATEWAY_TOKEN) {
          const token = url.searchParams.get("token");
          if (token !== env.GATEWAY_TOKEN) {
            return new Response("Unauthorized - invalid or missing token", { status: 401 });
          }
        } else {
          console.warn("WARNING: GATEWAY_TOKEN not set - Admin UI and API routes are unprotected!");
        }
        return handleAdminUI(url, env.LINEAR_CLIENT_ID || '');
      }

      // API routes (protected by gateway token)
      if (url.pathname.startsWith("/api/")) {
        if (env.GATEWAY_TOKEN) {
          const token = url.searchParams.get("token");
          if (token !== env.GATEWAY_TOKEN) {
            return new Response("Unauthorized - invalid or missing token", { status: 401 });
          }
        } else {
          console.warn("WARNING: GATEWAY_TOKEN not set - Admin UI and API routes are unprotected!");
        }
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

// Helper to update linearToken in config.json for all repositories
async function updateConfigTokens(
  sandbox: ReturnType<typeof getSandbox>,
  newToken: string
): Promise<boolean> {
  try {
    const configResult = await sandbox.exec("cat /root/.cyrus/config.json 2>/dev/null || echo '{}'");
    if (!configResult.stdout || configResult.stdout.trim() === '{}') return false;

    const config = JSON.parse(configResult.stdout) as { repositories?: Array<{ linearToken?: string }> };
    if (!config.repositories || config.repositories.length === 0) return false;

    // Update all repositories with new token
    for (const repo of config.repositories) {
      repo.linearToken = newToken;
    }

    const updatedConfig = JSON.stringify(config, null, 2);
    const b64 = btoa(updatedConfig);
    await sandbox.exec(`echo ${b64} | base64 -d > /root/.cyrus/config.json`);
    return true;
  } catch (error) {
    console.error("Failed to update config tokens:", error);
    return false;
  }
}

// Helper to run bootstrap sequence
async function runBootstrap(
  sandbox: ReturnType<typeof getSandbox>,
  env: Env,
  baseUrl: string
): Promise<string[]> {
  const steps: string[] = [];

  // Refresh OAuth token if needed (before anything else)
  const refreshResult = await refreshOAuthTokenIfNeeded(env);
  if (refreshResult.error) {
    steps.push(`token: ${refreshResult.error}`);
  } else if (refreshResult.refreshed) {
    steps.push("token: refreshed");
  } else {
    steps.push("token: valid");
  }

  // Kill any existing Cyrus to prevent config overwrite
  await sandbox.exec("pkill -f 'cyrus start' 2>/dev/null || true");
  await sandbox.exec("sleep 1");

  // Restore config from R2
  const restoreResult = await restoreConfigFromR2(sandbox, env);
  steps.push(`restore: ${restoreResult.restored ? restoreResult.files.length + " files" : "none"}`);

  // Always sync the latest token from R2 to config (config.json in R2 may have stale token)
  if (refreshResult.access_token) {
    const updated = await updateConfigTokens(sandbox, refreshResult.access_token);
    if (updated) {
      steps.push("config: tokens synced");
      // Save updated config back to R2 so next restore has fresh token
      await saveConfigToR2(sandbox, env);
    }
  } else if (refreshResult.refreshed) {
    // Token was refreshed but we don't have it - shouldn't happen but log it
    steps.push("config: refresh succeeded but no token returned");
  }

  // Create .env file
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

  // Configure git
  await sandbox.exec(`git config --global user.name "${gitName}" && git config --global user.email "${gitEmail}"`);
  if (ghToken) {
    await sandbox.exec(`echo "https://${ghToken}:x-oauth-basic@github.com" > ~/.git-credentials && git config --global credential.helper store`);
  }

  // Clone missing repos
  const cloneResult = await cloneMissingRepos(sandbox, env, ghToken);
  if (cloneResult.cloned.length > 0) steps.push(`cloned: ${cloneResult.cloned.join(", ")}`);

  // Start Cyrus
  await sandbox.exec("nohup cyrus start > /var/log/cyrus.log 2>&1 &");
  await sandbox.exec("sleep 4");

  const checkStarted = await sandbox.exec("pgrep -f 'cyrus start' && echo 'started'");
  steps.push(checkStarted.stdout.includes("started") ? "cyrus: started" : "cyrus: failed");

  return steps;
}

async function handleAgentSessionWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const body = await request.text();
  const url = new URL(request.url);
  const signature = request.headers.get("linear-signature") || "";

  // Verify webhook signature if secret is configured
  if (env.LINEAR_WEBHOOK_SECRET) {
    if (!(await verifyLinearSignature(body, signature, env.LINEAR_WEBHOOK_SECRET))) {
      return new Response("Invalid signature", { status: 401 });
    }
  }

  // Parse payload for logging (minimal info only)
  let webhookType = "unknown";
  let webhookAction = "unknown";
  try {
    const payload: AgentSessionWebhookPayload = JSON.parse(body);
    webhookType = payload.type;
    webhookAction = payload.action;
  } catch {
    // Invalid JSON - still accept and let Cyrus handle it
  }
  console.log("Linear webhook received:", webhookType, webhookAction);

  // Return 200 immediately to Linear - process in background
  // This prevents "did not respond" errors during cold starts
  ctx.waitUntil(processWebhookInBackground(env, url.origin, body, signature));

  return Response.json({
    status: "accepted",
    message: "Webhook received, processing in background",
  });
}

// Process webhook in background after returning 200 to Linear
async function processWebhookInBackground(
  env: Env,
  baseUrl: string,
  body: string,
  signature: string
): Promise<void> {
  try {
    const sandbox = getSandbox(env.Sandbox, "primary");

    // Check if Cyrus is running, auto-bootstrap if not
    // Token refresh happens automatically during bootstrap
    const healthCheck = await sandbox.exec("curl -s -o /dev/null -w '%{http_code}' http://localhost:3456/status 2>/dev/null || echo '000'");
    const isRunning = healthCheck.stdout && !healthCheck.stdout.includes("000");

    if (!isRunning) {
      console.log("Cyrus not running, auto-bootstrapping...");
      const bootstrapSteps = await runBootstrap(sandbox, env, baseUrl);
      console.log("Bootstrap complete:", bootstrapSteps);
      // Give Cyrus a moment to fully initialize
      await sandbox.exec("sleep 2");
    }

    // Forward webhook to Cyrus running on port 3456 inside the container
    const forwardResult = await sandbox.exec(
      `curl -s -X POST http://localhost:3456/webhook -H "Content-Type: application/json" -H "linear-signature: ${signature}" -d '${body.replace(/'/g, "'\\''")}'`
    );

    if (forwardResult.success) {
      console.log("Webhook forwarded to Cyrus successfully");
    } else {
      console.error("Failed to forward webhook to Cyrus:", forwardResult.stderr);
    }
  } catch (error) {
    console.error("Error processing webhook in background:", error);
  }
}

async function handleApiRoutes(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  const sandbox = getSandbox(env.Sandbox, "primary");

  // Full bootstrap: restore config, init, setup git, clone repos, start Cyrus
  if (url.pathname === "/api/bootstrap" && request.method === "POST") {
    const steps = await runBootstrap(sandbox, env, url.origin);
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

  // Refresh OAuth token
  if (url.pathname === "/api/refresh-token" && request.method === "POST") {
    const result = await refreshOAuthTokenIfNeeded(env);

    // If token was refreshed, also update the config in sandbox
    if (result.refreshed && result.access_token) {
      const updated = await updateConfigTokens(sandbox, result.access_token);
      if (updated) {
        await saveConfigToR2(sandbox, env);
      }
      return Response.json({
        success: true,
        message: "Token refreshed and config updated",
        refreshed: true,
      });
    }

    return Response.json({
      success: !result.error,
      message: result.error || "Token is still valid",
      refreshed: result.refreshed,
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

async function handleOAuthCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
      refresh_token?: string;
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
      refresh_token: tokens.refresh_token,
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

    console.log("OAuth tokens stored in R2 for org:", orgInfo.id, orgInfo.name);

    // Auto-bootstrap in background so Cyrus picks up the new token
    ctx.waitUntil((async () => {
      try {
        const sandbox = getSandbox(env.Sandbox, "primary");
        console.log("Auto-bootstrapping after OAuth...");
        const steps = await runBootstrap(sandbox, env, url.origin);
        console.log("Auto-bootstrap complete:", steps);
      } catch (error) {
        console.error("Auto-bootstrap failed:", error);
      }
    })());

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
    <p style="margin-top: 12px;">🔄 Bootstrapping Cyrus in background...</p>
  </div>
  <div class="info">
    <p><strong>Next steps:</strong></p>
    <ol>
      <li>Wait ~10 seconds for bootstrap to complete</li>
      <li>Add a repository using the admin panel (if not already added)</li>
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

function handleAdminUI(url: URL, linearClientId: string): Response {
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
      max-width: 1000px;
      margin: 0 auto;
      padding: 20px;
      background: #f5f5f5;
    }
    h1 { color: #333; margin-bottom: 8px; }
    .subtitle { color: #666; margin-bottom: 20px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
    .card {
      background: white;
      border-radius: 8px;
      padding: 20px;
      margin: 16px 0;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
    .card.full { grid-column: 1 / -1; }
    .card h2 { margin-top: 0; color: #444; font-size: 18px; }
    button {
      background: #0066cc;
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      margin-right: 8px;
      font-size: 14px;
    }
    button:hover { background: #0055aa; }
    button.secondary { background: #666; }
    button.danger { background: #dc3545; }
    button:disabled { background: #ccc; cursor: not-allowed; }
    pre {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 12px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 12px;
      max-height: 200px;
      margin: 8px 0;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 500;
    }
    .status-badge.ok { background: #d4edda; color: #155724; }
    .status-badge.error { background: #f8d7da; color: #721c24; }
    .status-badge.warning { background: #fff3cd; color: #856404; }
    input[type="text"] {
      width: 100%;
      padding: 8px;
      border: 1px solid #ddd;
      border-radius: 4px;
      margin-bottom: 8px;
      font-size: 14px;
    }
    .repo-list { list-style: none; padding: 0; margin: 0; }
    .repo-item {
      padding: 12px;
      border: 1px solid #eee;
      border-radius: 4px;
      margin-bottom: 8px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .repo-item .name { font-weight: 600; color: #333; }
    .repo-item .path { font-size: 12px; color: #666; }
    .repo-item .workspace { font-size: 12px; color: #0066cc; }
    .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
    .stat-box { text-align: center; padding: 16px; background: #f8f9fa; border-radius: 8px; }
    .stat-box .value { font-size: 28px; font-weight: 700; color: #333; }
    .stat-box .label { font-size: 12px; color: #666; margin-top: 4px; }
    .log-output { font-family: monospace; font-size: 11px; white-space: pre-wrap; max-height: 400px; overflow-y: auto; }
    .inline-form { display: flex; gap: 8px; }
    .inline-form input { flex: 1; margin-bottom: 0; }
    .section-status { float: right; }
  </style>
</head>
<body>
  <h1>CyrusWorker Admin</h1>
  <p class="subtitle">Claude Code Linear Agent on Cloudflare</p>

  <div class="grid">
    <div class="card">
      <h2>Cyrus Status <span class="section-status" id="cyrusStatusBadge"></span></h2>
      <div class="stats-grid">
        <div class="stat-box">
          <div class="value" id="statRepos">-</div>
          <div class="label">Repositories</div>
        </div>
        <div class="stat-box">
          <div class="value" id="statStatus">-</div>
          <div class="label">Status</div>
        </div>
        <div class="stat-box">
          <div class="value" id="statVersion">-</div>
          <div class="label">Version</div>
        </div>
      </div>
      <button onclick="refreshCyrusStatus()">Refresh</button>
      <button class="secondary" onclick="bootstrap()">Bootstrap</button>
      <span id="cyrusActionStatus"></span>
    </div>

    <div class="card">
      <h2>Container</h2>
      <div id="containerStatus">Loading...</div>
      <button onclick="refreshContainer()">Refresh</button>
      <button class="secondary" onclick="restartContainer()">Restart</button>
      <span id="containerActionStatus"></span>
    </div>
  </div>

  <div class="card">
    <h2>Repositories</h2>
    <ul class="repo-list" id="repoList">
      <li>Loading...</li>
    </ul>
    <hr style="margin: 16px 0; border: none; border-top: 1px solid #eee;">
    <h3 style="font-size: 14px; margin-bottom: 12px;">Add Repository</h3>
    <div class="inline-form">
      <input type="text" id="repoUrl" placeholder="https://github.com/org/repo" />
      <input type="text" id="repoWorkspace" placeholder="Workspace name (optional)" style="max-width: 200px;" />
      <button onclick="addRepo()">Add</button>
    </div>
    <div id="addRepoStatus" style="margin-top: 8px; font-size: 13px;"></div>
  </div>

  <div class="card">
    <h2>Cyrus Logs <span id="logStreamStatus" style="font-size: 12px; color: #666;"></span></h2>
    <pre id="cyrusLogs" class="log-output">Loading...</pre>
    <button onclick="refreshLogs()">Refresh</button>
    <button class="secondary" onclick="copyToClipboard('cyrusLogs')">Copy</button>
    <label style="margin-left: 16px; font-size: 13px; cursor: pointer;">
      <input type="checkbox" id="autoRefreshLogs" onchange="toggleLogStream()"> Auto-refresh
    </label>
  </div>

  <div class="grid">
    <div class="card">
      <h2>Storage</h2>
      <button onclick="saveConfig()">Save to R2</button>
      <button onclick="restoreConfig()">Restore from R2</button>
      <span id="storageStatus"></span>
    </div>

    <div class="card">
      <h2>Linear OAuth</h2>
      <button onclick="refreshToken()">Refresh Token</button>
      <button class="secondary" onclick="reauthorizeLinear()">Reauthorize</button>
      <p id="oauthStatus" style="font-size: 12px; color: #666; margin-top: 8px;"></p>
      <p style="font-size: 12px; color: #666; margin-top: 4px;">Tokens auto-refresh during bootstrap. Use Reauthorize if refresh fails.</p>
    </div>
  </div>

  <div class="card">
    <h2>Execute Command</h2>
    <div class="inline-form" style="margin-bottom: 12px;">
      <input type="text" id="cmdInput" placeholder="ls -la /root/.cyrus" />
      <button onclick="runCommand()">Run</button>
      <button class="secondary" onclick="copyToClipboard('cmdOutput')">Copy</button>
    </div>
    <pre id="cmdOutput" style="min-height: 100px; max-height: 400px;"></pre>
  </div>

  <script>
    // Get token from URL for API calls
    const urlParams = new URLSearchParams(window.location.search);
    const apiToken = urlParams.get('token') || '';
    const apiBase = (path) => path + (apiToken ? '?token=' + encodeURIComponent(apiToken) : '');

    // Copy to clipboard helper
    function copyToClipboard(elementId) {
      const el = document.getElementById(elementId);
      const text = el.textContent || el.innerText || '';
      const btn = event.target;

      // Try modern clipboard API first, fall back to textarea method
      const fallbackCopy = () => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = 'Copy', 1500);
        } catch (e) {
          alert('Copy failed - please select and copy manually');
        }
        document.body.removeChild(textarea);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = 'Copied!';
          setTimeout(() => btn.textContent = 'Copy', 1500);
        }).catch(fallbackCopy);
      } else {
        fallbackCopy();
      }
    }

    // Refresh OAuth token
    async function refreshToken() {
      document.getElementById('oauthStatus').textContent = 'Refreshing...';
      try {
        const res = await fetch(apiBase('/api/refresh-token'), { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          const el = document.getElementById('oauthStatus'); el.textContent = data.message; el.style.color = 'green';
          if (data.refreshed) {
            // Restart Cyrus to pick up new token
            setTimeout(() => bootstrap(), 1000);
          }
        } else {
          const el = document.getElementById('oauthStatus'); el.textContent = data.message || 'Refresh failed'; el.style.color = 'red';
        }
      } catch (e) {
        const el = document.getElementById('oauthStatus'); el.textContent = 'Error: ' + e.message; el.style.color = 'red';
      }
    }

    // Reauthorize with Linear
    function reauthorizeLinear() {
      const clientId = '${linearClientId}';
      if (!clientId) {
        const el = document.getElementById('oauthStatus'); el.textContent = 'LINEAR_CLIENT_ID not configured'; el.style.color = 'red';
        return;
      }
      const redirectUri = encodeURIComponent(window.location.origin + '/callback');
      const authUrl = \`https://linear.app/oauth/authorize?client_id=\${clientId}&redirect_uri=\${redirectUri}&response_type=code&scope=write,app:assignable,app:mentionable&actor=app\`;
      window.open(authUrl, '_blank');
      document.getElementById('oauthStatus').textContent = 'Auth window opened - click Bootstrap after authorizing';
    }

    // Cyrus Status
    async function refreshCyrusStatus() {
      try {
        const [configRes, statusRes] = await Promise.all([
          fetch(apiBase('/api/config')),
          fetch(apiBase('/api/exec'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'curl -s http://localhost:3456/status 2>/dev/null && curl -s http://localhost:3456/version 2>/dev/null || echo "offline"' })
          })
        ]);

        const config = await configRes.json();
        const statusData = await statusRes.json();

        const repos = config.repositories || [];
        document.getElementById('statRepos').textContent = repos.length;

        // Parse Cyrus status
        let cyrusStatus = 'offline';
        let cyrusVersion = '-';
        if (statusData.stdout && !statusData.stdout.includes('offline')) {
          try {
            const parts = statusData.stdout.split('}{');
            if (parts.length === 1) {
              // Only status response
              const status = JSON.parse(parts[0]);
              cyrusStatus = status.status || 'unknown';
            } else if (parts.length >= 2) {
              // Both status and version responses concatenated
              const status = JSON.parse(parts[0] + '}');
              cyrusStatus = status.status || 'unknown';
              const version = JSON.parse('{' + parts[1]);
              cyrusVersion = version.cyrus_cli_version || '-';
            }
          } catch (e) {
            console.error('Status parse error:', e, statusData.stdout);
            cyrusStatus = 'error';
          }
        }

        document.getElementById('statStatus').textContent = cyrusStatus;
        document.getElementById('statVersion').textContent = cyrusVersion;
        document.getElementById('cyrusStatusBadge').innerHTML =
          cyrusStatus === 'offline' ? '<span class="status-badge error">Offline</span>' :
          cyrusStatus === 'idle' ? '<span class="status-badge ok">Ready</span>' :
          cyrusStatus === 'busy' ? '<span class="status-badge warning">Busy</span>' :
          '<span class="status-badge error">Error</span>';

        // Update repo list
        const repoList = document.getElementById('repoList');
        if (repos.length === 0) {
          repoList.innerHTML = '<li style="color: #666; padding: 12px;">No repositories configured</li>';
        } else {
          repoList.innerHTML = repos.map(r => \`
            <li class="repo-item">
              <div>
                <div class="name">\${r.name}</div>
                <div class="path">\${r.repositoryPath}</div>
                <div class="workspace">Workspace: \${r.linearWorkspaceName || 'default'}</div>
              </div>
              <span class="status-badge \${r.isActive ? 'ok' : 'warning'}">\${r.isActive ? 'Active' : 'Inactive'}</span>
            </li>
          \`).join('');
        }
      } catch (e) {
        document.getElementById('cyrusStatusBadge').innerHTML = '<span class="status-badge error">Error</span>';
      }
    }

    async function bootstrap() {
      document.getElementById('cyrusActionStatus').textContent = 'Bootstrapping...';
      try {
        const res = await fetch(apiBase('/api/bootstrap'), { method: 'POST' });
        const data = await res.json();
        document.getElementById('cyrusActionStatus').textContent = data.success ? 'Done!' : 'Failed';
        setTimeout(() => { refreshCyrusStatus(); refreshLogs(); }, 2000);
      } catch (e) {
        document.getElementById('cyrusActionStatus').textContent = 'Error: ' + e.message;
      }
    }

    // Container Status
    async function refreshContainer() {
      document.getElementById('containerStatus').innerHTML = 'Loading...';
      try {
        const res = await fetch(apiBase('/api/status'));
        const data = await res.json();
        const lines = (data.output || '').split('\\n').filter(l => l.includes('node') || l.includes('cyrus')).slice(0, 5);
        document.getElementById('containerStatus').innerHTML =
          '<span class="status-badge ok">Running</span>' +
          '<pre style="margin-top: 8px; max-height: 100px;">' + (lines.join('\\n') || 'No processes') + '</pre>';
      } catch (e) {
        document.getElementById('containerStatus').innerHTML = '<span class="status-badge error">Error</span>';
      }
    }

    async function restartContainer() {
      document.getElementById('containerActionStatus').textContent = 'Restarting...';
      try {
        const res = await fetch(apiBase('/api/restart'), { method: 'POST' });
        const data = await res.json();
        document.getElementById('containerActionStatus').textContent = data.success ? 'Restarted!' : 'Failed';
        setTimeout(refreshContainer, 2000);
      } catch (e) {
        document.getElementById('containerActionStatus').textContent = 'Error';
      }
    }

    // Repositories
    async function addRepo() {
      const url = document.getElementById('repoUrl').value.trim();
      const workspace = document.getElementById('repoWorkspace').value.trim();
      if (!url) { alert('Enter a repository URL'); return; }

      document.getElementById('addRepoStatus').innerHTML = '<span style="color: #666;">Adding repository...</span>';
      try {
        const res = await fetch(apiBase('/api/add-repo'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, workspace: workspace || undefined })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('addRepoStatus').innerHTML = '<span style="color: green;">Repository added!</span>';
          document.getElementById('repoUrl').value = '';
          document.getElementById('repoWorkspace').value = '';
          // Save to R2 after adding
          await fetch(apiBase('/api/save'), { method: 'POST' });
          setTimeout(refreshCyrusStatus, 1000);
        } else {
          document.getElementById('addRepoStatus').innerHTML = '<span style="color: red;">Failed: ' + (data.stderr || data.error || 'Unknown error') + '</span>';
        }
      } catch (e) {
        document.getElementById('addRepoStatus').innerHTML = '<span style="color: red;">Error: ' + e.message + '</span>';
      }
    }

    // Logs
    let logStreamInterval = null;
    async function refreshLogs() {
      try {
        const res = await fetch(apiBase('/api/exec'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'tail -50 /var/log/cyrus.log 2>/dev/null || echo "No logs available"' })
        });
        const data = await res.json();
        const logsEl = document.getElementById('cyrusLogs');
        logsEl.textContent = data.stdout || 'No logs';
        logsEl.scrollTop = logsEl.scrollHeight; // Auto-scroll to bottom
      } catch (e) {
        document.getElementById('cyrusLogs').textContent = 'Error loading logs';
      }
    }

    function toggleLogStream() {
      const checkbox = document.getElementById('autoRefreshLogs');
      const status = document.getElementById('logStreamStatus');
      if (checkbox.checked) {
        logStreamInterval = setInterval(refreshLogs, 3000);
        status.textContent = '(streaming)';
      } else {
        clearInterval(logStreamInterval);
        logStreamInterval = null;
        status.textContent = '';
      }
    }

    // Storage
    async function saveConfig() {
      document.getElementById('storageStatus').textContent = 'Saving...';
      try {
        const res = await fetch(apiBase('/api/save'), { method: 'POST' });
        const data = await res.json();
        document.getElementById('storageStatus').textContent = data.success ? 'Saved!' : 'Failed';
      } catch (e) {
        document.getElementById('storageStatus').textContent = 'Error';
      }
    }

    async function restoreConfig() {
      document.getElementById('storageStatus').textContent = 'Restoring...';
      try {
        const res = await fetch(apiBase('/api/restore'), { method: 'POST' });
        const data = await res.json();
        document.getElementById('storageStatus').textContent = data.success ? 'Restored!' : 'Failed';
        setTimeout(refreshCyrusStatus, 1000);
      } catch (e) {
        document.getElementById('storageStatus').textContent = 'Error';
      }
    }

    // Execute
    async function runCommand() {
      const cmd = document.getElementById('cmdInput').value;
      if (!cmd) return;
      document.getElementById('cmdOutput').textContent = 'Executing...';
      try {
        const res = await fetch(apiBase('/api/exec'), {
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
    refreshCyrusStatus();
    refreshContainer();
    refreshLogs();
    // Auto-refresh disabled by default to save compute
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html" },
  });
}

async function verifyLinearSignature(
  body: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;

  try {
    // Import the secret as a crypto key
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );

    // Compute the expected signature
    const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Constant-time comparison to prevent timing attacks
    if (signature.length !== expectedSignature.length) return false;
    let result = 0;
    for (let i = 0; i < signature.length; i++) {
      result |= signature.charCodeAt(i) ^ expectedSignature.charCodeAt(i);
    }
    return result === 0;
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

