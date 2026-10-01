---
name: verify
description: Run after any frontend or API change. Typecheck, lint, build, then boot the dev server in the background and check health and key pages.
---
1. Run `pnpm typecheck && pnpm lint && pnpm build`. All must pass.
2. Start the dev server in the background: `pnpm dev > /tmp/dev.log 2>&1 &`
3. Poll http://localhost:3000/api/health every 2s for up to 60s. If it never returns 200: `tail -100 /tmp/dev.log`, stop the server, report, and do not attempt UI checks against a dead server.
4. Request /, /map, /branches and /review. Each must return 200, or a redirect to /login when unauthenticated.
5. Kill the background dev server and report results with evidence (status codes, log excerpts).
This skill may be made stricter, never weaker.
