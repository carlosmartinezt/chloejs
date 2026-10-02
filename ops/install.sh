#!/usr/bin/env bash
# Install the service that runs the agents, and start it. Run it from the top
# of your own project, the folder with chloe.config.ts in it:
#
#   npx chloe install
#
# The unit is called chloe.service. One box runs one of these, so this replaces
# an existing one and points it at the folder it was run from.
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
# with the condition that picks the source.
CORE="$ROOT/node_modules/@chloejs/core"
if [ -L "$CORE" ]; then
  START="--conditions=chloe-source $(cd "$CORE" && pwd -P)/server.ts"
else
  START="$CORE/dist/server.js"
  [ -f "$CORE/dist/server.js" ] || {
    echo "No $CORE/dist. Reinstall @chloejs/core." >&2
    exit 1
  }
fi

# A setting is declared in chloe.config.ts, which is TypeScript, so it is read by
# node rather than sourced. Asking the same module the runtime asks means this
# script cannot disagree with it about a default. An empty setting comes back as
# "-" so that read gets two fields either way.
SETTINGS=$(cd "$ROOT" && node --conditions=chloe-source --input-type=module -e '
  const { loadSettings, settings } = await import("@chloejs/core");
  await loadSettings();
  console.log(settings.node || "-", settings.model.prefer.join(",") || "-");
') || {
  echo "the settings could not be read. The error is above." >&2
  exit 1
}
read -r NODEBIN PREFER <<<"$SETTINGS"
[ "$NODEBIN" != "-" ] || NODEBIN=$(dirname "$(command -v node)")
[ "$PREFER" != "-" ] || PREFER=""

# A CLI route runs model calls through that program, so the unit needs it on the
# path. Each is found the same way as node, because they usually sit somewhere
# like ~/.local/bin and systemd starts with almost no path at all.
CLIBIN=""
for one in claude codex opencode; do
  if command -v "$one" >/dev/null 2>&1; then CLIBIN="$CLIBIN:$(dirname "$(command -v "$one")")"; fi
done

[ -n "$CLIBIN" ] || case ",$PREFER," in
  *,gateway,*) ;;
  *) echo "model.prefer is \"$PREFER\" and none of those commands is on the path. Install one," >&2
     echo "or put \"gateway\" in model.prefer and a key in .env as CHLOE_MODEL_KEY." >&2
     exit 1 ;;
esac

# Credentials live in .env, so nobody else on the box reads it.
[ ! -e "$ROOT/.env" ] || chmod 600 "$ROOT/.env"

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
# nothing. The port and the loopback bind are in serve/http.ts.
ExecStart=$NODEBIN/node $START
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
echo "Model calls try ${PREFER:-whichever this box can}, in that order."
echo "The site and the API are on http://127.0.0.1:3067, loopback only."
echo "Make the one account with: npx chloe account"
echo "From another machine: ssh -L 3067:127.0.0.1:3067 you@thisbox"
