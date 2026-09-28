# Plan: pnpm Linux client build and GitHub Action

## Objective

Build the Tauri desktop client on Linux with pnpm, then add a GitHub Action that repeats that Linux build.

## Context

- Repository: `Android-Webcam-Project`
- Branch: `master` (ticket branch to open)
- Ticket key: none
- Client path: `CLIENT/tauri-client`
- Current package manager: Yarn (`yarn.lock`, `beforeBuildCommand: yarn build`)
- Local tools: Node 24, pnpm 10.33.2, Rust 1.93, FFmpeg 6.1.1 at `/usr/bin/ffmpeg`

## Impact

- `CLIENT/tauri-client/package.json` — declare pnpm
- `CLIENT/tauri-client/src-tauri/tauri.conf.json` — pnpm commands; drop missing Windows FFmpeg DLL resource names so the Linux bundle can run
- `CLIENT/tauri-client/yarn.lock` — remove
- `CLIENT/tauri-client/pnpm-lock.yaml` — add
- `.github/workflows/linux-client.yml` — add after a successful local Linux build
- `AGENTS.md` — add project verify commands

Callers: Tauri `beforeDevCommand` / `beforeBuildCommand` only.

## Contract impact

No API key change. No background job. No database change.

## Size

- `package.json`: ~5 lines
- `tauri.conf.json`: ~15 lines
- lockfile: replace Yarn with pnpm
- workflow: ~80 lines
- `AGENTS.md`: ~60 lines

## Pattern

Copy style from:

- `CLIENT/tauri-client/src-tauri/tauri.conf.json`
- official Tauri 2 GitHub Action example (`tauri-apps/tauri-action`)
- `CLIENT/tauri-client/package.json`

## Tests

No unit test runner exists for this client. The failing check is a Linux `pnpm tauri build` before the workflow is added.

## Steps

1. Open branch `linux-pnpm-client-build`.
2. Switch the client to pnpm and generate `pnpm-lock.yaml`.
3. Point Tauri build hooks at pnpm.
4. Remove missing `avcodec-62.dll` resource names from the shared bundle list.
5. Run the Linux client build with pnpm.
6. If the build passes, add a GitHub Action that installs Linux build packages, uses pnpm, and uploads the Linux artifacts.

## Risk

- Host GTK/WebKit `-dev` packages are missing; `sudo` needs a password. Docker can supply those packages.
- `ffmpeg-next` 8.1.0 tracks FFmpeg 8. Host FFmpeg is 6.1.1 and has no headers. The build may need FFmpeg 8 libraries.
- `adb.rs` still calls `adb.exe` on Linux. That is a runtime issue. This task does not change it.

## Verification

| Command | Gate |
|---------|------|
| `pnpm --dir CLIENT/tauri-client install --frozen-lockfile` | Install succeeds. |
| `pnpm --dir CLIENT/tauri-client tauri build --bundles deb,appimage` | Linux bundles exist under `src-tauri/target/release/bundle`. |
