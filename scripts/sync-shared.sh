#!/bin/sh
# Refresh vendor/ from the daemonitor monorepo checkout beside this one. The
# tenant shares these pure modules (cluster evaluation, the fleet adapter,
# Slack and webhook delivery, ...) with the app at daemonitor.com, and vendors
# them so this repo builds on its own when forked.
#   sh scripts/sync-shared.sh [path to the monorepo root, default ..]
set -e
root=${1:-..}
cd "$(dirname "$0")/.."
for f in \
  frontend/server/utils/cloudflareWorkers.ts frontend/server/utils/enrollment.ts frontend/server/utils/mcp.ts \
  frontend/server/utils/metrics.ts frontend/server/utils/slack.ts frontend/server/utils/supabase.ts \
  frontend/server/utils/webhook.ts frontend/types/fleet.ts frontend/utils/clusterEval.ts \
  frontend/utils/deviceAlert.ts frontend/utils/fleet.ts frontend/utils/fleetAdapter.ts \
  frontend/utils/groupTree.ts frontend/utils/suspectNetworks.ts common/types/fleet.ts
do
  mkdir -p "vendor/$(dirname "$f")"
  cp "$root/$f" "vendor/$f"
done
echo "vendor/ refreshed from $root"
