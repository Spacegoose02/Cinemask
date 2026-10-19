#!/bin/sh
# Runs the app as PUID:PGID (Unraid defaults 99:100 = nobody:users) instead of root.
set -eu
PUID="${PUID:-99}"
PGID="${PGID:-100}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$CONFIG_DIR"
  chown -R "$PUID:$PGID" "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  umask 077
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all "$@"
fi
exec "$@"
