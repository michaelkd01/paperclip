#!/bin/bash
# Wrapper script for launchd to run the trace parser.
# Sources R2 credentials from Keychain via paperclip-secrets.sh,
# sets DATABASE_URL for the local embedded Postgres, then runs the parser.

set -euo pipefail

# Source R2 credentials
if [ -f "$HOME/.paperclip-secrets.sh" ]; then
  source "$HOME/.paperclip-secrets.sh" all 2>/dev/null
fi

# Set R2 bucket name (not in secrets script; matches dashboard plist)
export PAPERCLIP_TRACES_R2_BUCKET="${PAPERCLIP_TRACES_R2_BUCKET:-paperclip-traces}"

# Set DATABASE_URL for local embedded Postgres
export DATABASE_URL="${DATABASE_URL:-postgres://paperclip:paperclip@127.0.0.1:54329/paperclip}"

# Run the parser
exec /opt/homebrew/bin/node /Users/michaeldavidson/Developer/paperclip/apps/trace-parser/dist/bundle.mjs
