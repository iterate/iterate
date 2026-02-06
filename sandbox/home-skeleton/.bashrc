# PATH setup for iterate sandbox tools.
# Login shells reset PATH via /etc/profile, so we set it here.
# This is also set in the Dockerfile (for non-shell `docker exec`) - keep both in sync!
export PATH="$HOME/.iterate/bin:$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:/usr/local/go/bin:$HOME/go/bin:$PATH"

# Source iterate environment variables
if [ -f ~/.iterate/.env ]; then
    set -a  # auto-export all variables
    . ~/.iterate/.env
    set +a
fi

# Prompt: grey pwd path + lightning
PS1='\[\033[90m\]\w\[\033[0m\] ⚡️ '
