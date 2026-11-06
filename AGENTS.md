# Working on jXRvis

This file is for agents changing this repo. The text for agents *using* jXRvis in another project is [agents/snippet.md](agents/snippet.md) (and the same text as a skill in [agents/skills/jxrvis/SKILL.md](agents/skills/jxrvis/SKILL.md); a test keeps them identical).

- [SPEC.md](SPEC.md) is the contract. Change it first, then the code; keep it implementable without this code (a Unity client, a Python server).
- `src/spec.ts` holds the contract's constants; every part imports from it. `src/client/**` must stay browser-safe (no `node:` imports).
- Sources are TypeScript run directly by Node (`--experimental-strip-types`): erasable syntax only (no enums, namespaces or parameter properties), relative imports end in `.ts`.
- `npm run verify` before committing: typecheck, tests, package build, example build.
- Never commit feedback data (`feedback/`, any `inbox/`), certificates or keys. Tests make their own temporary folders and certificates.
