# Changelog

All notable changes to `agentsync` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-25

### Added
- **Core Detection Engine** (`src/core/detector.ts`):
  - Support for 4 core AI coding agents: Google Antigravity, Claude Code, OpenAI Codex, and Cursor.
  - Automatic detection of custom command directories (e.g. `~/.claude/commands`) and system containers (e.g. `~/.codex/skills/.system`).
- **Skill Linking & Discovery** (`src/core/skill-linker.ts`):
  - Cross-platform zero-privilege NTFS Directory Junctions on Windows and POSIX symlinks on macOS/Linux.
  - Zero-loss skill merging into single source of truth at `~/.agentsync/skills/`.
  - Skill collision detection across agents.
  - Clean unlinking with `agentsync unlink`.
- **MCP Synchronizer** (`src/core/mcp-sync.ts`):
  - Deep-merging of environment variables, arguments, and servers across `mcpServers` dicts.
  - Automatic persistence to master registry `~/.agentsync/mcp_servers.json`.
  - Support for environment variable interpolation (`${VAR}`).
- **Rule Consolidator** (`src/core/rules.ts`):
  - Single source-of-truth `AGENTS.md` consolidated to `CLAUDE.md`, `GEMINI.md`, and `.cursorrules`.
- **Doctor & Security Diagnostics** (`src/core/doctor.ts`):
  - Secret scanning for plaintext API tokens (`ghp_`, `sk-`, embedded DB passwords).
  - Cross-platform junction capability tests.
  - Automatic repair with `agentsync doctor --fix`.
- **Backup & Rollback** (`src/core/rollback.ts`):
  - Timestamped snapshot creation and restoration via `agentsync rollback`.
- **Real-Time Watcher** (`src/core/watcher.ts`):
  - Live auto-sync daemon with `agentsync watch`.
- **Antigravity Skill**:
  - Native Antigravity Skill integration at `~/.gemini/config/skills/agentsync/SKILL.md`.
- **CI/CD**:
  - Multi-OS matrix testing (Ubuntu, macOS, Windows on Node.js 18, 20, 22).

