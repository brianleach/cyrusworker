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

echo "=== Container Ready ==="
echo "Cyrus config: /root/.cyrus/config.json"
echo "Repos dir: /data/repos"
echo "Worktrees dir: /data/worktrees"

# Check for .env file
if [ ! -f "/root/.cyrus/.env" ]; then
    echo "ERROR: /root/.cyrus/.env not found. Run /api/init first."
    exit 1
fi

# Start Cyrus server
echo "Starting Cyrus..."
exec cyrus
