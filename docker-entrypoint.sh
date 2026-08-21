#!/bin/sh
set -e

PUID="${PUID:-568}"
PGID="${PGID:-568}"

if ! getent group "${PGID}" >/dev/null 2>&1; then
  groupadd -g "${PGID}" teslacam
fi

if ! getent passwd "${PUID}" >/dev/null 2>&1; then
  useradd -u "${PUID}" -g "${PGID}" -M -d /tmp -s /usr/sbin/nologin teslacam
fi

mkdir -p /cache
chown -R "${PUID}:${PGID}" /cache /app || true

export HOME=/tmp
exec gosu "${PUID}:${PGID}" "$@"
