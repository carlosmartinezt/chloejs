#!/bin/sh
# The machine's start, as root: the wall between the two users, then chloe as
# the runtime user. docs/machines.md says what each piece is for.
set -e

workspace=/home/runtime/workspace

# The shell user may not see chloe's own processes, which carry what chloe is
# doing for the agent. Needs SYS_ADMIN.
mount -o remount,hidepid=2 /proc 2>/dev/null \
  || echo "chloe machine: processes are visible to the shell user (needs SYS_ADMIN)."

# The shell user reaches the internet only through chloe's proxy on loopback.
# iptables matches the uid as the kernel sees it, which in a rootless container
# is the host's uid: translate through /proc/self/uid_map.
hostuid() {
  wanted=$(id -u "$1")
  while read from to count; do
    if [ "$wanted" -ge "$from" ] && [ "$wanted" -lt "$((from + count))" ]; then
      echo $((to + wanted - from))
      return
    fi
  done < /proc/self/uid_map
  echo "$wanted"
}

if ! iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null; then
  echo "chloe machine: no firewall (needs NET_ADMIN): the shell user can reach the internet without chloe's proxy."
elif ! iptables -A OUTPUT -m owner --uid-owner "$(hostuid shell)" -j REJECT 2>/dev/null; then
  echo "chloe machine: no firewall (the rule for the shell user could not be written): the shell user can reach the internet without chloe's proxy."
elif timeout 5 su -s /bin/bash shell -c 'exec 3<>/dev/tcp/deb.debian.org/80' 2>/dev/null; then
  # Rules can be written and still not bite, in a rootless container, so the
  # wall is tried before it is believed.
  echo "chloe machine: the firewall did not hold: the shell user can reach the internet without chloe's proxy."
fi

# A volume mounted over the workspace or the data folder arrives root-owned,
# and one first used under another mapping of users holds files of the wrong
# owner.
mkdir -p "$workspace/routines" /home/runtime/data
chown runtime:runtime "$workspace" /home/runtime/data
if [ -n "$(find /home/runtime/data ! -user runtime -print -quit)" ]; then
  chown -R runtime:runtime /home/runtime/data
fi
chmod 1777 "$workspace"
chmod 700 /home/runtime/data

# The routines are the agent's folder, lent by the copy that made the machine,
# which owns it; only routines that are the machine's own are made chloe's here.
if ! mountpoint -q "$workspace/routines"; then
  chown runtime:runtime "$workspace/routines"
  chmod 755 "$workspace/routines"
fi

# The config and .env are copied in when the machine is made, and are chloe's
# user's, .env readable by it alone.
for file in chloe.config.ts .env; do
  [ -f "/home/runtime/$file" ] && chown runtime:runtime "/home/runtime/$file"
done
[ -f /home/runtime/.env ] && chmod 600 /home/runtime/.env

# chloe runs as the runtime user, from the machine's home, which is the project
# it runs in: its chloe.config.ts and .env are at the top. The runtime itself is
# either a clone, run from its source, or the installed package, run from its
# built server.
cd /home/runtime
export HOME=/home/runtime
export CHLOE_STATE=/home/runtime/data
if [ -f /home/runtime/chloe/dist/server.js ]; then
  exec setpriv --reuid=runtime --regid=runtime --init-groups --inh-caps=-all \
    node /home/runtime/chloe/dist/server.js
fi
exec setpriv --reuid=runtime --regid=runtime --init-groups --inh-caps=-all \
  node --conditions=chloe-source /home/runtime/chloe/server.ts
