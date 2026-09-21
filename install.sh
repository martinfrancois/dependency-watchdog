#!/usr/bin/env bash
#
# Install the watchdog and prune timers for the current user.
#
# Safe to re-run: it reinstalls the units and restarts the timers. It refuses to enable anything
# while credentials are missing, because a watchdog that cannot reach you is worse than none at
# all: its silence reads as good news.
#
# Environment:
#   ENABLE_PRUNE=0          install the watchdog only, leave the prune disabled
#   DEP_WATCHDOG_CONFIG_DIR override the config directory (default $XDG_CONFIG_HOME/dep-watchdog)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${DEP_WATCHDOG_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/dep-watchdog}"
SECRETS="$CONFIG_DIR/config.env"
SETTINGS="$CONFIG_DIR/config.json"
export DEP_WATCHDOG_CONFIG_DIR="$CONFIG_DIR"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

say() { printf '  %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

echo "Installing from $REPO_DIR"

command -v node >/dev/null || die "node is not on PATH. Node 24+ is required."
command -v gh   >/dev/null || die "the GitHub CLI (gh) is not on PATH."
gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"
say "node $(node --version), gh authenticated"

# The prune shells out to pnpm to validate an edited workspace file before pushing it, and refuses
# to push when it cannot. A user systemd unit inherits a minimal PATH, so a node installed by mise,
# nvm, asdf or fnm is not on it and neither is the pnpm beside it. Pin the units to the directory
# holding the node just verified, so the unit runs the same toolchain as this shell.
NODE_BIN="$(dirname "$(command -v node)")"
say "toolchain at $NODE_BIN"
if ! PATH="$NODE_BIN:$PATH" command -v pnpm >/dev/null 2>&1; then
  say "warning: pnpm is not beside node. The prune will refuse to push pnpm workspace files."
  say "         Install pnpm (corepack enable) if any watched repository uses one."
fi

[ -f "$SETTINGS" ] || die "No $SETTINGS. Copy config.example.json there and list your repositories."
[ -f "$SECRETS" ]  || die "No $SECRETS. Copy config.env.example there and fill it in."
# Only actual assignments count. The example file explains the word PLACEHOLDER in a comment, and
# matching that comment would refuse a correctly filled file.
if grep -qE '^[A-Za-z_][A-Za-z0-9_]*=.*PLACEHOLDER' "$SECRETS"; then
  grep -nE '^[A-Za-z_][A-Za-z0-9_]*=.*PLACEHOLDER' "$SECRETS" >&2
  die "Credentials above are still PLACEHOLDER. Fill them in, then re-run."
fi
say "config present"

# Resolve the Telegram chat id if it is still AUTO.
if grep -q '^TELEGRAM_CHAT_ID=AUTO' "$SECRETS"; then
  say "resolving Telegram chat id ..."
  token="$(grep '^TELEGRAM_BOT_TOKEN=' "$SECRETS" | cut -d= -f2-)"
  chat="$(node -e '
    import(process.argv[1] + "/src/notify.ts")
      .then(async (m) => process.stdout.write(await m.resolveChatId(process.argv[2])))
      .catch((e) => { console.error(e.message); process.exit(1); })
  ' "$REPO_DIR" "$token")" || die "Could not resolve the chat id. Send your bot a message first."
  sed -i.bak "s|^TELEGRAM_CHAT_ID=AUTO$|TELEGRAM_CHAT_ID=$chat|" "$SECRETS" && rm -f "$SECRETS.bak"
  say "chat id resolved: $chat"
fi

# Dry run before scheduling anything. If the watchdog cannot read GitHub or the settings are
# malformed, stop here rather than installing a timer that fails silently every morning.
say "dry run ..."
node "$REPO_DIR/src/cli-watchdog.ts" --dry-run >/dev/null || die "Dry run failed. Not installing."
say "dry run ok"

# Units, with the repository and config paths substituted so both can live anywhere.
mkdir -p "$UNIT_DIR"
for unit in "$REPO_DIR"/systemd/*.service "$REPO_DIR"/systemd/*.timer; do
  sed -e "s|__REPO_DIR__|$REPO_DIR|g" -e "s|__NODE_BIN__|$NODE_BIN|g" -e "s|__CONFIG_DIR__|$CONFIG_DIR|g" "$unit" > "$UNIT_DIR/$(basename "$unit")"
  chmod 0644 "$UNIT_DIR/$(basename "$unit")"
done
systemctl --user daemon-reload
say "units installed to $UNIT_DIR"

# Linger, so the timers run when nobody is logged in and survive a reboot. Without it the whole
# thing only runs while a session happens to be open, which is a silent way to stop working.
if [ "$(loginctl show-user "$USER" --property=Linger --value 2>/dev/null || echo no)" != "yes" ]; then
  loginctl enable-linger "$USER" 2>/dev/null ||
    say "WARNING: could not enable linger; timers will only run while you are logged in"
fi

systemctl --user enable --now dep-watchdog.timer
systemctl --user enable --now dep-recovery.timer
if [ "${ENABLE_PRUNE:-1}" = "1" ]; then
  systemctl --user enable --now dep-prune.timer
  say "both timers enabled"
else
  say "watchdog enabled; prune left disabled (ENABLE_PRUNE=0)"
fi

echo
systemctl --user list-timers 'dep-*' --no-pager || true
echo
say "Now verify the dead man's switch, because an untested one is decoration:"
say "  systemctl --user stop dep-watchdog.timer"
say "  # wait past the healthchecks.io period plus grace, confirm it alerts you"
say "  systemctl --user start dep-watchdog.timer"
