#!/bin/zsh
set -eu
cd "${0:A:h:h}"
if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  print 'Node.js 24 or newer is required. Install Node, then launch again.'
  exit 1
fi
npm run build
# Run node directly: with npm in between, Ctrl+C reaches the bot twice and npm outlives it.
exec node dist/index.js
