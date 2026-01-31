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
