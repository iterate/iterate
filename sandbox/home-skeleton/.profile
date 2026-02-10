# Source .bashrc for bash login shells (where PATH and env vars are set)
if [ -n "$BASH_VERSION" ]; then
    if [ -f "$HOME/.bashrc" ]; then
        . "$HOME/.bashrc"
    fi
fi

# PATH setup for non-bash login shells.
if [ -z "$BASH_VERSION" ]; then
    export PATH="$HOME/.iterate/bin:$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$HOME/.npm-global/bin:/usr/local/go/bin:$HOME/go/bin:$PATH"
fi

# Source iterate environment variables (for sh)
if [ -z "$BASH_VERSION" ] && [ -f ~/.iterate/.env ]; then
    set -a
    . ~/.iterate/.env
    set +a
fi
