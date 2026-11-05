---
description: Show active tasks, predicted remaining time and today's cost from Claude Command Center
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/bin/ccc.js" summary`

Relay the Claude Command Center summary above to the user as a short list. Keep the labels exactly as given: "prediction", "measured", "estimated", "subscription-equivalent". Do not add numbers that are not in the output.
