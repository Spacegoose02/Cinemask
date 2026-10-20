#!/bin/sh
# Runs the app as PUID:PGID (Unraid defaults 99:100 = nobody:users) instead of root.
set -eu
PUID="${PUID:-99}"
PGID="${PGID:-100}"
# Media folders and files must stay readable by Plex, Jellyfin and Audiobookshelf, which often run as
# other users. /config is still private: its directory is 0700 and secrets are written as 0600.
UMASK="${UMASK:-002}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$CONFIG_DIR"
  chown -R "$PUID:$PGID" "$CONFIG_DIR"
  chmod 700 "$CONFIG_DIR"
  umask "$UMASK"
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --inh-caps=-all "$@"
fi
exec "$@"
