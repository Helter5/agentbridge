# Contributing to AgentBridge

Guidelines and architectural context for contributing to **AgentBridge**.

---

## Architecture: Core Engines

AgentBridge is organized into modular TypeScript engines in `src/core/`:

```
src/
├── constants.ts             # Central path, agent definitions & configuration
├── cli.ts                   # Executable CLI entrypoint (Commander + Clack)
├── index.ts                 # Programmatic TypeScript SDK
├── core/
│   ├── detector.ts          # 1. Agent Detection Engine (finds config & skill paths)
│   ├── skill-linker.ts      # 2. Skill Linker Engine (junctions, merging & collisions)
│   ├── mcp-sync.ts          # 3. MCP Synchronizer (lossless JSON merge & master registry)
│   ├── rules.ts             # 4. Rule Consolidator (AGENTS.md -> CLAUDE.md / GEMINI.md)
│   ├── doctor.ts            # 5. Health Diagnostics Engine (security scan & repair)
│   ├── rollback.ts          # Snapshot backup & restore
│   └── watcher.ts           # Live file watcher daemon
├── types/                   # Shared TypeScript types (client, doctor, mcp, rules, skill)
├── utils/
│   ├── fs.ts                # Cross-platform junction / symlink helpers
│   ├── schema.ts            # Zod validation, secret detection & YAML parser
│   ├── ui.ts                # Terminal tables, badges & spinners
│   └── logger.ts            # Multi-level logger
└── templates/
    └── skill.template.ts    # Standardized SKILL.md boilerplate
```

---

## Risk Hotspots

`src/cli.ts` is the CLI-aggregation layer - it wires every core engine (`detector`, `skill-linker`, `mcp-sync`, `rules`, `doctor`, `rollback`) into commands, owns `try`/`catch` boundaries, exit-code decisions, and confirmation prompts. Several real regressions originated here specifically because a command's error handling or exit-code logic diverged from the others (see `CHANGELOG.md` PR#15, #16 for concrete cases). When touching `cli.ts`:
- Match the existing pattern for the command you're editing (`try`/`catch` around the core call, `process.exitCode = 1` on failure) rather than inventing a new one.
- If a command mutates state across multiple agents, check how partial failure is reported for the other mutating commands before adding your own.

---

## Local Development Workflow

### 1. Prerequisites
- Node.js >= 18.0.0
- npm >= 9.0.0

### 2. Setup
```bash
# Clone the repository
git clone https://github.com/Helter5/agentbridge.git
cd agentbridge

# Install dependencies
npm install

# Run TypeScript typecheck
npm run lint

# Run Vitest test suite
npm test

# Run tests with code coverage
npm run test:coverage

# Build executable bundle
npm run build
```

### 3. Adding Support for a New Agent
1. Add the agent identifier to `AgentId` in [`src/types/client.ts`](src/types/client.ts).
2. Register the default configuration and skill paths in `SUPPORTED_AGENTS` in [`src/constants.ts`](src/constants.ts).
3. Add unit test assertions in [`tests/detector.test.ts`](tests/detector.test.ts).

---

## Testing Guidelines
- All new features or bug fixes must include accompanying tests in `tests/`.
- Tests must be isolated and avoid mutating the actual user home directory (use temporary directories).
- Verify cross-platform symlink and junction behavior across Windows, macOS, and Linux.

---

## Pull Request Guidelines
- Follow conventional commit messages: `feat: ...`, `fix: ...`, `docs: ...`, `refactor: ...`.
- Ensure `npm run lint && npm test && npm run build` passes with zero errors before submitting.
