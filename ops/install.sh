#!/usr/bin/env bash
# Install the service that runs the agents, and start it. Run it from the top
# of your own project, the folder with chloe.config.ts in it:
#
#   npx chloe install
#
# On Linux it is a systemd user unit, chloe.service. On a Mac it is a launchd
# agent, org.chloejs.chloe, logging to ~/Library/Logs/chloe.log. One box runs
# one of these, so this replaces an existing one and points it at the folder it
# was run from.
#
# Why a service at all: because a process in a terminal dies with the terminal.
# The service survives a reboot and restarts if it crashes. Without it the agents only run while someone is watching,
# which is the opposite of the point.
set -euo pipefail

ROOT=$(pwd)
[ -f "$ROOT/chloe.config.ts" ] || {
  echo "No chloe.config.ts in $ROOT. Run this from the top of your project." >&2
  exit 1
}
[ -d "$ROOT/node_modules" ] || {
  echo "No node_modules. Run npm install in $ROOT first." >&2
  exit 1
}
# Your agent files are TypeScript that node reads directly, which needs a
# version that strips types without being asked.
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || {
  echo "Node 22 or newer is needed: your agent files are .ts and node reads them directly." >&2
  exit 1
}

# Two shapes of install, and they are started differently. A normal install runs
# the built copy in dist/. An install by path is a symlink to a clone of the
# chloejs repo, which has the source and may have no dist/ at all, so it is run
# with the condition that picks the source. The same test decides where the
# settings are read from: with the condition on a packed install, node looks
# for the source it does not ship and the read fails.
CORE="$ROOT/node_modules/@chloejs/core"
if [ -L "$CORE" ]; then
  ENTRY="$(cd "$CORE" && pwd -P)/server.ts"
  CONDITION="--conditions=chloe-source"
else
  ENTRY="$CORE/dist/server.js"
  CONDITION=""
  [ -f "$CORE/dist/server.js" ] || {
    echo "No $CORE/dist. Reinstall @chloejs/core." >&2
    exit 1
  }
fi

START="${CONDITION:+$CONDITION }$ENTRY"

# Linux with systemd, or a Mac with launchd: fail before writing anything.
UNSUPPORTED="This installer needs Linux with systemd, or macOS. On another system, run npx chloe under any supervisor that restarts it."
case "$(uname -s)" in
  Linux)
    SYSTEM=linux
    command -v systemctl >/dev/null 2>&1 || { echo "$UNSUPPORTED" >&2; exit 1; }
    ;;
  Darwin) SYSTEM=mac ;;
  *) echo "$UNSUPPORTED" >&2; exit 1 ;;
esac

# A setting is declared in chloe.config.ts, which is TypeScript, so it is read by
# node rather than sourced. Asking the same module the runtime asks means this
# script cannot disagree with it about a default. An empty setting comes back as
# "-" so that read gets every field either way. The key itself never leaves
# node: only whether there is one.
SETTINGS=$(cd "$ROOT" && node $CONDITION --input-type=module -e '
  const { loadSettings, settings } = await import("@chloejs/core");
  await loadSettings();
  const { node, model, serve } = settings;
  console.log(node || "-", model.preferredRoute.join(",") || "-", model.key ? "yes" : "no", serve.host || "-", serve.port);
') || {
  echo "the settings could not be read. The error is above." >&2
  exit 1
}
read -r NODEBIN PREFER HASKEY HOST PORT <<<"$SETTINGS"
[ "$NODEBIN" != "-" ] || NODEBIN=$(dirname "$(command -v node)")
[ "$PREFER" != "-" ] || PREFER=""
[ "$HOST" != "-" ] || HOST=""

# A CLI route runs model calls through that program, so the unit needs it on the
# path. Each is found the same way as node, because they usually sit somewhere
# like ~/.local/bin and systemd and launchd start with almost no path at all.
CLIBIN=""
for one in claude codex opencode; do
  if command -v "$one" >/dev/null 2>&1; then CLIBIN="$CLIBIN:$(dirname "$(command -v "$one")")"; fi
done

[ -n "$CLIBIN" ] || case ",$PREFER," in
  *,gateway,*) ;;
  *) echo "model.preferredRoute is \"$PREFER\" and none of those commands is on the path. Install one," >&2
     echo "or put \"gateway\" in model.preferredRoute, the key in .env as CHLOE_MODEL_KEY, and model: { key: process.env.CHLOE_MODEL_KEY } in chloe.config.ts." >&2
     exit 1 ;;
esac

# The route a model call will take is the first one this box is set up for. A
# subscription is for trying things out, and this is the service, so say so
# without stopping: whether it is allowed is between the person and its terms.
for one in ${PREFER//,/ }; do
  if [ "$one" = gateway ]; then [ "$HASKEY" = yes ] && break || continue; fi
  command -v "$one" >/dev/null 2>&1 || continue
  case "$one" in
    claude|codex)
      echo "Model calls will go through $one, on a subscription. That is for trying things out: its terms may" >&2
      echo "not cover a service running agents. To run on a key, put \"gateway\" first in model.preferredRoute." >&2 ;;
  esac
  break
done

# Credentials live in .env, so nobody else on the box reads it.
[ ! -e "$ROOT/.env" ] || chmod 600 "$ROOT/.env"

if [ "$SYSTEM" = linux ]; then

mkdir -p ~/.config/systemd/user

# Written here rather than kept as a separate file, because systemd expands
# variables in ExecStart= only, never in WorkingDirectory= or EnvironmentFile=.
# A template plus an installer is two files that can disagree; this is one.
cat > ~/.config/systemd/user/chloe.service <<EOF
[Unit]
Description=Chloe, which runs the agents
After=network-online.target

[Service]
Type=simple
# The process watches each agent folder, so an edit there is live without a
# restart, including a new agent folder. A change to the runtime or this unit
# needs one.
Environment=PATH=$NODEBIN$CLIBIN:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$ROOT
# The server is what is run. The package's index is only its exports and starts
# nothing. Where it listens is serve in settings.
ExecStart=$NODEBIN/node $START
# A stop waits up to 60 seconds for the runs that are going. Mixed sends the
# stop to the server alone, so a model call it started can finish with it.
KillMode=mixed
TimeoutStopSec=75
Restart=on-failure
RestartSec=15
Nice=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=chloe

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable chloe.service
systemctl --user restart chloe.service

echo "Installed chloe.service, node at $NODEBIN."
echo "It starts at boot only for a user with lingering on: loginctl enable-linger $(id -un)"

else

# A path with & or < in it would otherwise break the plist.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

LABEL=org.chloejs.chloe
PLIST=~/Library/LaunchAgents/$LABEL.plist
LOG=~/Library/Logs/chloe.log
mkdir -p ~/Library/LaunchAgents ~/Library/Logs

# One <string> per argument, so a path with a space in it stays one argument.
ARGS="    <string>$(xml "$NODEBIN/node")</string>"
[ -z "$CONDITION" ] || ARGS="$ARGS
    <string>$CONDITION</string>"
ARGS="$ARGS
    <string>$(xml "$ENTRY")</string>"

# Starts at login, and is started again 15 seconds after it exits with an
# error. Where it listens is serve in settings. A stop waits up to 60 seconds
# for the runs that are going, and launchd's own wait is 20 unless told.
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
$ARGS
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml "$NODEBIN$CLIBIN:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>15</integer>
  <key>ExitTimeOut</key>
  <integer>75</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml "$LOG")</string>
  <key>StandardErrorPath</key>
  <string>$(xml "$LOG")</string>
</dict>
</plist>
EOF

# Replace a running one. bootout fails when none is loaded, and bootstrap can
# fail for a moment while the old one is still stopping, so it is tried again.
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
for try in 1 2 3 4 5; do
  launchctl bootstrap "$DOMAIN" "$PLIST" && break
  [ "$try" -lt 5 ] || { echo "launchctl could not load $PLIST." >&2; exit 1; }
  sleep 1
done
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "Installed $LABEL at $PLIST, node at $NODEBIN."
echo "It starts when you log in. Its output is in $LOG."

fi
echo "Model calls try ${PREFER:-whichever this box can}, in that order."
echo "The site and the API are on http://${HOST:-127.0.0.1}:$PORT."
echo "Make the one account with: npx chloe account"
if [ "$HOST" = 127.0.0.1 ]; then
  echo "That is this machine only. From another one: ssh -L $PORT:127.0.0.1:$PORT you@thisbox"
fi
