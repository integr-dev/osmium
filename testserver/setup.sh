#!/usr/bin/env bash
#
# Puts a Paper server in this directory, configured for the build rig: offline
# mode, superflat, creative, nothing hostile, no watchdog. Re-runnable — it
# rewrites the configuration every time and only downloads the jar once.
#
# Running this accepts the Minecraft EULA on your behalf (eula.txt), which the
# server refuses to start without.
#
#   ./setup.sh                    the default names below get operator
#   ./setup.sh alice bob          those names instead
#   ./setup.sh --fresh            throw the world away and generate it again
set -euo pipefail

cd "$(dirname "$0")"

# Pinned, not "latest". mineflayer's tested list is what decides this, and a
# server that drifts ahead of the client library fails as a protocol error
# somewhere unrelated to whatever is being tested.
VERSION="${MC_VERSION:-1.21.4}"

# Who gets operator, so the harness can /gamemode, /tp and /setblock. Offline
# UUIDs, since the server runs offline — see `uuid` below.
FRESH=0
OPS=()
for arg in "$@"; do
  if [ "$arg" = "--fresh" ]; then FRESH=1; else OPS+=("$arg"); fi
done
if [ ${#OPS[@]} -eq 0 ]; then OPS=(osmium probe integr); fi

say() { printf '\033[36m==\033[0m %s\n' "$*"; }

# ---------------------------------------------------------------- the jar

manifest=$(curl -fsS "https://fill.papermc.io/v3/projects/paper/versions/${VERSION}/builds/latest")
url=$(printf '%s' "$manifest" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).downloads["server:default"].url))')
sum=$(printf '%s' "$manifest" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).downloads["server:default"].checksums.sha256))')
jar=$(basename "$url")

if [ -f "$jar" ] && [ "$(sha256sum "$jar" | cut -d" " -f1)" = "$sum" ]; then
  say "$jar is already here"
else
  say "downloading $jar"
  curl -fL --progress-bar -o "$jar.part" "$url"
  have=$(sha256sum "$jar.part" | cut -d" " -f1)
  if [ "$have" != "$sum" ]; then
    rm -f "$jar.part"
    echo "checksum mismatch: wanted $sum, got $have" >&2
    exit 1
  fi
  mv "$jar.part" "$jar"
fi

# `start.sh` reads this rather than globbing, so an older jar left behind by a
# version change is ignored instead of being picked by accident.
printf '%s\n' "$jar" > jar.txt

# ---------------------------------------------------------------- the world

say 'accepting the Minecraft EULA (https://aka.ms/MinecraftEULA)'
printf 'eula=true\n' > eula.txt

# One stone layer on bedrock, at y=-60. A rig builds above it, so anything
# standing in the box is something the printer put there.
#
# Nothing generated on top of it: an empty `structure_overrides`, and `lakes` and
# `features` off. A village or a lake dropped into the middle of a test box is a
# build that reads as wrong through no fault of the printer, and it happens miles
# from where anybody is looking.
layers='{"layers":[{"block":"minecraft:bedrock","height":1},{"block":"minecraft:stone","height":3},{"block":"minecraft:grass_block","height":1}],"biome":"minecraft:plains","lakes":false,"features":false,"structure_overrides":[]}'

cat > server.properties <<PROPS
# Written by setup.sh. Edits here are lost on the next run.
online-mode=false
enforce-secure-profile=false
gamemode=creative
force-gamemode=true
allow-flight=true
level-type=minecraft:flat
generator-settings=${layers}
level-name=world
difficulty=peaceful
spawn-monsters=false
spawn-npcs=false
spawn-animals=false
generate-structures=false
pvp=false
spawn-protection=0
allow-nether=false
view-distance=16
simulation-distance=16
# Disables the watchdog. A rig that is being stepped through in a debugger
# otherwise gets its server killed for taking too long over one tick.
max-tick-time=-1
max-players=8
server-port=25565
motd=Osmium build rig
sync-chunk-writes=false
enable-status=true
PROPS

# Paper fills in every key this leaves out, so only the ones the rig needs are
# written. The packet ceiling is the one that matters: a printer places as fast
# as the server will take it, and Paper's default of 500 packets a second is
# under what that is — a working printer would be kicked for flooding.
mkdir -p config
cat > config/paper-global.yml <<'PAPER'
_version: 29
packet-limiter:
  all-packets:
    action: KICK
    interval: 7.0
    max-packet-rate: 20000.0
  kick-message: <red>Sent too many packets
  overrides: {}
misc:
  max-joins-per-tick: 8
chunk-system:
  io-threads: -1
PAPER

# ---------------------------------------------------------------- operators

say "operator: ${OPS[*]}"
node -e '
  const crypto = require("crypto")
  // The same UUID an offline server derives for a name: MD5 of
  // "OfflinePlayer:<name>", stamped as version 3. Getting this wrong writes an
  // ops.json the server reads and then matches against nobody.
  const uuid = (name) => {
    const h = crypto.createHash("md5").update("OfflinePlayer:" + name, "utf8").digest()
    h[6] = (h[6] & 0x0f) | 0x30
    h[8] = (h[8] & 0x3f) | 0x80
    const hex = h.toString("hex")
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-")
  }
  const ops = process.argv.slice(1).map((name) => ({
    uuid: uuid(name), name, level: 4, bypassesPlayerLimit: true,
  }))
  require("fs").writeFileSync("ops.json", JSON.stringify(ops, null, 2) + "\n")
' "${OPS[@]}"

# ---------------------------------------------------------------- the world

# Thrown away on request rather than on every run: generating it again is cheap,
# and losing what was built there by accident is not.
#
# The rest of holding the world still — no mob spawning, no fire, no weather, no
# random ticks — is gamerules, which live in the world rather than in a file. The
# rig sets them every time it runs, and they stay set; see `prepare` in
# `host/src/rig/harness.ts`.
if [ "$FRESH" -eq 1 ]; then
  say 'throwing the world away'
  rm -rf world world_nether world_the_end
fi

say 'ready — ./start.sh'
