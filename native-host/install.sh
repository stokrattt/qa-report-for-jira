#!/bin/sh
# Connects QA Report for Jira to the claude / codex CLI on this computer, for "Fill with AI".
# Usage (the extension shows this line with your extension id filled in):
#   curl -fsSL https://raw.githubusercontent.com/stokrattt/qa-report-for-jira/main/native-host/install.sh | sh -s <extension-id>
set -e

EXT_ID="$1"
if [ -z "$EXT_ID" ]; then
    echo "Usage: sh install.sh <extension-id>. Copy the full command from the extension's Fill with AI message." >&2
    exit 1
fi

NAME=com.stokrattt.qa_report_for_jira
HOST_URL=https://raw.githubusercontent.com/stokrattt/qa-report-for-jira/main/native-host/host.mjs
APP_DIR="$HOME/.qa-report-for-jira"

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
    echo "Node.js is not installed. Install it from https://nodejs.org, then run this command again." >&2
    exit 1
fi

case "$(uname)" in
    Darwin) HOST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
    Linux) HOST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts" ;;
    *) echo "On Windows use install.ps1 in PowerShell: the extension shows the command." >&2; exit 1 ;;
esac
mkdir -p "$HOST_DIR" "$APP_DIR"

# Run from a checkout: use the local host.mjs. Piped from curl: download it.
HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if [ -f "$HERE/host.mjs" ] && [ -f "$HERE/install.sh" ]; then
    cp "$HERE/host.mjs" "$APP_DIR/host.mjs"
else
    curl -fsSL "$HOST_URL" -o "$APP_DIR/host.mjs"
fi

# Chrome starts the host with a bare PATH, so the wrapper carries the PATH of this shell,
# where claude / codex are found.
cat > "$APP_DIR/host.sh" <<EOF
#!/bin/sh
export PATH="$PATH"
exec "$NODE" "$APP_DIR/host.mjs"
EOF
chmod +x "$APP_DIR/host.sh"

cat > "$HOST_DIR/$NAME.json" <<EOF
{
    "name": "$NAME",
    "description": "QA Report for Jira: local claude / codex CLI bridge",
    "path": "$APP_DIR/host.sh",
    "type": "stdio",
    "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

# Chromium on Linux reads its own folder; register there too when it is installed.
CHROMIUM_DIR="$HOME/.config/chromium"
if [ "$(uname)" = Linux ] && [ -d "$CHROMIUM_DIR" ]; then
    mkdir -p "$CHROMIUM_DIR/NativeMessagingHosts"
    cp "$HOST_DIR/$NAME.json" "$CHROMIUM_DIR/NativeMessagingHosts/$NAME.json"
fi

echo "Connected. Files: $APP_DIR and $HOST_DIR/$NAME.json"
for bin in claude codex; do
    if command -v "$bin" >/dev/null 2>&1; then echo "  found $bin: $(command -v "$bin")"; else echo "  $bin: not found"; fi
done
command -v claude >/dev/null 2>&1 || command -v codex >/dev/null 2>&1 || {
    echo "Neither claude nor codex is installed. Install one, log in once, then run this command again:" >&2
    echo "  Claude Code: npm i -g @anthropic-ai/claude-code && claude" >&2
    echo "  Codex:       npm i -g @openai/codex && codex login" >&2
}
echo "Go back to the report and click Fill with AI again."
