# Source .bashrc for bash login shells (where PATH and env vars are set)
if [ -n "$BASH_VERSION" ]; then
    if [ -f "$HOME/.bashrc" ]; then
        . "$HOME/.bashrc"
    fi
fi

# Source iterate environment variables (for sh)
if [ -z "$BASH_VERSION" ] && [ -f ~/.iterate/.env ]; then
    set -a
    . ~/.iterate/.env
    set +a
fi
