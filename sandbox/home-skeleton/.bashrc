# PATH setup for iterate sandbox tools.
# Login shells reset PATH via /etc/profile, so we set it here.
# This is also set in the Dockerfile (for non-shell `docker exec`) - keep both in sync!
export PATH="$HOME/.iterate/bin:/opt/claude/.local/bin:/opt/opencode/.opencode/bin:/opt/mitmproxy/bin:/opt/uv/bin:/opt/npm-global/bin:/opt/bun/bin:/opt/fly/bin:/usr/local/go/bin:/opt/go/bin:$PATH"

# Source iterate environment variables
if [ -f ~/.iterate/.env ]; then
    set -a  # auto-export all variables
    . ~/.iterate/.env
    set +a
fi

# Prompt: grey pwd path + lightning
PS1='\[\033[90m\]\w\[\033[0m\] ⚡️ '
