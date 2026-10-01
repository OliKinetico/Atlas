# Project directives (binding)
- This project is separate from Kinetico. Never read, copy or reference kinetico-crm code, data, env vars or credentials.
- Additive-only migrations. No renames or drops without Oli's explicit decision.
- Snapshot affected tables before any mass write; record the restore command in the run log.
- Never overwrite a row or field where manually_edited = true.
- Fuzzy matches never auto-apply; they go to match_proposals for human review.
- Never guess identifying data (company numbers, postcodes, addresses). Sourced or absent.
- Secrets live only in env vars; never commit, print or log them.
- Run the verify skill (.claude/skills/verify/SKILL.md) after any frontend or API change. Never run `pnpm dev` in the foreground.
- One PR at a time: push branch → manual Vercel deploy of the branch → verify live with evidence → merge.
