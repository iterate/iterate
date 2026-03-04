if [ -n "$BASH_VERSION" ]; then
    if [ -f "$HOME/.bashrc" ]; then
        . "$HOME/.bashrc"
    fi
fi

if [ -z "$BASH_VERSION" ]; then
    export PATH="$HOME/.iterate/bin:$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.npm-global/bin:$PATH"
fi

if [ -z "$BASH_VERSION" ] && [ -f ~/.iterate/.env ]; then
    set -a
    . ~/.iterate/.env
    set +a
fi
