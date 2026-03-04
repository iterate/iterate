# PATH setup for iterate sandbox tools.
# Login shells reset PATH via /etc/profile, so we set it here.
export PATH="$HOME/.iterate/bin:$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.npm-global/bin:$PATH"

# Source iterate environment variables
if [ -f ~/.iterate/.env ]; then
    set -a
    . ~/.iterate/.env
    set +a
fi

PS1='\[\033[90m\]\w\[\033[0m\] > '
