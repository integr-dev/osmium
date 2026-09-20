#!/usr/bin/env bash
#
# Runs the server set up by ./setup.sh. Console on stdin, log on stdout.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f jar.txt ]; then
  echo "no server here yet — run ./setup.sh first" >&2
  exit 1
fi

jar=$(cat jar.txt)
java="${JAVA_HOME:-}"
if [ -n "$java" ]; then java="$java/bin/java"; else java="java"; fi

# A flat world with one builder on it needs none of a real server's heap, and a
# small one keeps the pauses short enough that the rig's timings mean something.
exec "$java" -Xms1G -Xmx2G \
  -XX:+UseG1GC -XX:MaxGCPauseMillis=50 \
  -Dcom.mojang.eula.agree=true \
  -jar "$jar" nogui
