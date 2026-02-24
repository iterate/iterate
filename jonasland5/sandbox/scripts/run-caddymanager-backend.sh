#!/bin/sh
set -eu

cd /opt/caddymanager/backend
exec /usr/local/bin/node app.js
