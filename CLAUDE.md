@AGENTS.md

## Bun

Default to Bun instead of Node.js: `bun <file>`, `bun test`, `bun check`, `bun install`, `bun run <script>`, `bunx <pkg>`. Bun loads `.env` automatically, so don't add dotenv. Prefer `Bun.file`, `Bun.spawn` and `Bun.$` over `node:fs`/execa.
