# Simplified Dockerfile - base image already has Node.js 20
FROM docker.io/cloudflare/sandbox:0.7.0

# Install minimal system dependencies
RUN apt-get update && apt-get install -y \
    git \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI and pnpm (pnpm is for cloned target repos, not Cyrus)
RUN npm install -g @anthropic-ai/claude-code pnpm

# Install Cyrus from npm at an exact version.
# Pinned deliberately: the Worker shells out to `cyrus <subcommand>` (see
# /api/add-repo), so a floating install lets an upstream rename break this
# Worker with no change here. Bump this pin explicitly and verify the
# subcommands the Worker calls still exist.
RUN npm install -g cyrus-ai@0.2.68 \
    && cyrus --version

# Create working directories
RUN mkdir -p /root/.cyrus /data/repos /data/worktrees /data/backup

# Copy startup script and config template
COPY start-cyrus.sh /usr/local/bin/start-cyrus.sh
COPY cyrus-config.template.json /root/cyrus-config.template.json
RUN chmod +x /usr/local/bin/start-cyrus.sh

WORKDIR /data

# Don't override CMD - sandbox base image's entrypoint handles the internal API
