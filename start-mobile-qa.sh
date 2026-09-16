#!/usr/bin/env bash
set -u
WORKSIDEQA="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$WORKSIDEQA" || exit 1

if command -v node >/dev/null 2>&1; then
  exec node packages/qa-core/src/mobile-qa-launcher.js "$@"
fi

printf '%s\n' 'Node.js is required for WorksideQA mobile QA. Install Node or load the documented local toolchain.' >&2
exit 1
