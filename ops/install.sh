#!/usr/bin/env bash
# Install the service that runs the agents, and start it. Run it from the top
# of your own project, the folder with chloe.config.ts in it:
#
#   sh node_modules/chloejs/ops/install.sh
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
# Node runs the TypeScript directly, which needs a version that strips types
# without being asked. Checked before the settings are read, because reading
# them is itself a TypeScript import.
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || {
  echo "Node 22 or newer is needed: this runs .ts files directly." >&2
  exit 1
}

# The settings are JSON, so they are read by node rather than sourced. Asking
# the same module the runtime asks means this script cannot disagree with it
# about a default. An empty setting comes back as "-" so that read gets two
# fields either way.
SETTINGS=$(node --input-type=module -e '
  const { settings } = await import(process.argv[1] + "/node_modules/chloejs/core/settings.ts");
  console.log(settings.node || "-", settings.model.via || "-");
' "$ROOT") || {
  echo "settings.json could not be read. The error is above." >&2
  exit 1
}
read -r NODEBIN MODELVIA <<<"$SETTINGS"
[ "$NODEBIN" != "-" ] || NODEBIN=$(dirname "$(command -v node)")
[ "$MODELVIA" != "-" ] || MODELVIA=""

# model.via "claude" runs model calls through the Claude Code CLI, so the unit
# needs it on the path. Found the same way as node, because it usually sits in
# ~/.local/bin and systemd starts with almost no path at all.
CLAUDEBIN=""
if command -v claude >/dev/null 2>&1; then CLAUDEBIN=":$(dirname "$(command -v claude)")"; fi

[ "$MODELVIA" != "claude" ] || [ -n "$CLAUDEBIN" ] || {
  echo "model.via is \"claude\", but the claude command is not on the path. Install" >&2
  echo "Claude Code, or set model.via to \"gateway\" and put credit on the key." >&2
  exit 1
}

# Credentials live in settings.local.json, so nobody else on the box reads it.
[ ! -e "$ROOT/settings.local.json" ] || chmod 600 "$ROOT/settings.local.json"

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
Environment=PATH=$NODEBIN$CLAUDEBIN:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$ROOT
# server.ts is what is run. The package's index.ts is only its exports and
# starts nothing. The port and the loopback bind are in serve/http.ts.
ExecStart=$NODEBIN/node $ROOT/node_modules/chloejs/server.ts
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
echo "Model calls go via ${MODELVIA:-whichever this box can}."
echo "The site and the API are on http://127.0.0.1:3067, loopback only."
echo "Make the one account with: npm run account"
echo "From another machine: ssh -L 3067:127.0.0.1:3067 you@thisbox"
