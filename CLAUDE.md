# CLAUDE.md

This repository's authoritative instructions are in `AGENTS.md` and
`.agents/skills/letletme-graphql-read-path/SKILL.md`. Generic skills are not
vendored here; Codex loads them from the versioned global/plugin environment
listed in `.codex/global-skills.json`.

## Review and cleanup governance

Use `$gh-codex-review-loop` for PR work. A review may be skipped only after two
consecutive explicit quota-limit responses for the unchanged head; record both
responses and the exact SHA. This never waives CI, findings, or cleanup.

Every P0-P3 finding must be dispositioned and its thread resolved. Only a
finding confined to tests/scripts gets the time exception: implement P0/P1,
and explain plus resolve P2/P3 without implementation time. P2/P3 anywhere
else must be actually fixed and verified.

Keep a complete finding ledger for the exact head; merge is prohibited while
any finding is undispositioned or any review thread is unresolved. A quota
override can skip only a new review request and never finding resolution.
After merge, clean only the exact corresponding worktree, local branch, and
remote branch after verifying identity; leave unrelated WIP untouched.
