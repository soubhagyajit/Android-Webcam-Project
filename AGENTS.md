# Project rules

This file is the project layer. The task protocol lives in the installed kit.

## Stack

- Language: Kotlin, JavaScript, Rust
- Framework: Android (Gradle) + Tauri 2 (React, Vite)
- Test runner: unknown

## Verify commands

Run these commands in the Verify step. Report the result of each one. Show the output.

| Command | Gate |
|---------|------|
| `pnpm --dir CLIENT/tauri-client install --frozen-lockfile` | Install succeeds. |
| `pnpm --dir CLIENT/tauri-client tauri build --bundles deb,appimage` | Linux bundles exist under `CLIENT/tauri-client/src-tauri/target/release/bundle`. |

## Integration branches

Do not push directly to a branch in this table.

| Branch | Note |
|--------|------|
| `master` | Default integration branch. |

## Ticket and branch

- Ticket key format: unknown
- Branch name format: `short-description`
- Commit message format: `type: description`

## Task protocol

Follow the `task-protocol` skill for a feature, a bug fix, and a ticket.

Do not wait for plan, branch, commit, or pull-request approval.
Write the plan. Then build, verify, commit, review, push, and open the PR.

Use the `coder` agent for Build and Verify when the harness has that agent.

Use the `reviewer` agent for Review and the pull request draft when the harness has that agent.

## Hard rules

Obey `protocol/HARD-RULES.md` in the task-protocol kit. A rule in this file may add a project constraint. It must not weaken a hard rule about secrets, data, or verify evidence.
