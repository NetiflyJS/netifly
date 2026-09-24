#!/usr/bin/env bash
set -euo pipefail

# npm publish (unlike pnpm publish) doesn't rewrite the workspace:* protocol,
# so resolve @notiflyjs/core to its real published version just for this
# publish — the committed package.json keeps workspace:* for local dev.
core_version=$(node -p "require('../core/package.json').version")
npm pkg set "dependencies.@notiflyjs/core=^${core_version}"
npm publish
