#!/bin/zsh
set -eu
cd "${0:A:h:h}"
if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  print 'Node.js 22.12 or newer is required. Install Node, then launch again.'
  exit 1
fi
npm run build
exec npm start
