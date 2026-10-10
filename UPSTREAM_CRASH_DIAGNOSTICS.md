# Crash diagnostics, local compatibility review (2026-10-10)

Status: compatible API prerequisite finalized and locally tested for a separate local commit. Full report collection is outside the authorized repository scope and is stopped here.

Inspected upstream game-server commits:

- https://github.com/5stackgg/game-server/commit/195f4e750ca6da9b2463b0b159b4384dc6a08d29
- https://github.com/5stackgg/game-server/commit/81137cd9f06bb8245a94646eb59cc68df3882f81
- Later Swiftly dump support: https://github.com/5stackgg/game-server/commit/365b2f0677df7646354a223f809aad32acf0d822

The first two changes wrap the server process in shared/scripts/crash-report.sh, save a bounded console tail and engine minidumps under /opt/demos/.crash-reports, record server/match/build/plugin context and redact launch passwords. The follow-up fixes process groups, console flushing, SIGUSR1 handling, startup game version, image identity and missing-console reporting. The later fix additionally saves SwiftlyS2's own dump/crashinfo files. These require game-server scripts/images and cannot be reproduced by WEB/API code, which cannot access a dying container's local files.

The latest 30 commits of upstream 5stackgg/game-server-node-connector were inspected through GitHub, including current 4e48b0a7. No crash-report-specific commit was found in that history or its crash commit search. No connector repository was modified. Neither requested SHA belongs to the connector; both belong to game-server. Moving server files/image pruning changes are separate and were not ported.

## Compatible API change

https://github.com/5stackgg/api/commit/ae113b1e66c48485bf72a24a6489d06d45dc2450 adds MATCH_ID to the on-demand Job container environment. That one-line addition and its upstream assertion are ported in:

- src/matches/match-assistant/match-assistant.service.ts
- src/matches/match-assistant/match-assistant.on-demand-teardown.spec.ts

Local commit title: fix(matches): pass match id for upstream crash diagnostics.

The environment field only affects future local/otherwise authorized server provisioning after a future release. No Job was created, no existing server was changed and no infrastructure command was run. No WEB/API report endpoint, storage migration or fake diagnostic report was added.

## Preservation and checks

The protected base commit is f3b9b7e907837ee2a7eaaef122509fbbc5f19089. This commit is not amended, replaced, rebased or otherwise modified. Its teardown/reaper implementation is untouched; the service diff contains only MATCH_ID and its test diff contains only the added assertion. All other orphan-fix files remain unchanged against HEAD. Existing orphaned-server regressions pass in the 474-test local API run; API TypeScript compilation and git diff --check pass.

WEB remains at 16008980 on main. Its pre-existing TournamentPrizes.vue formatting change and untracked .claude/launch.json remain untouched. Both repositories fetched origin/main. Before finalization, API was one commit ahead of origin/main at the protected orphaned-server commit. The three improvements are finalized separately on top of that commit. No dependencies, schema, metadata or migrations were changed.

## Required separate work

Actual saved crash reports require explicit authorization for game-server changes, porting the script/Dockerfile/runtime hunks and testing clean stops versus crashes, console flush, signal races, retention, password redaction and Swiftly dump capture. A later separately authorized release would be needed. Do not claim diagnostics or server performance is fixed from this API prerequisite alone.

GitHub issue context was read without modifying issues. The existing chat-freeze issue 105 and CS2 outage summary 122 are separate; this preparation does not justify closing them. No matching upstream-safety checklist was identified and no checklist item was marked complete.

## Exact local commit file manifest

- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/UPSTREAM_CRASH_DIAGNOSTICS.md`
- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/src/matches/match-assistant/match-assistant.service.ts`
- `C:/Users/TricoN/Desktop/DEAFCS/api-deafcs/src/matches/match-assistant/match-assistant.on-demand-teardown.spec.ts`
