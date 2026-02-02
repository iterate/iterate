# Source iterate environment variables
if [ -f ~/.iterate/.env ]; then
    set -a  # auto-export all variables
    . ~/.iterate/.env
    set +a
fi
