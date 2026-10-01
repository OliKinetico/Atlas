# Decisions log

## 1 October 2026

- **TPO: no pages fetched.** Fetching the 38 TPO business sitemaps (to check whether member
  URLs carry location, ruling 0R.3) was refused by the session's safety classifier. Oli chose
  to skip TPO: ingestion uses Property Redress and Companies House only, and Oli will request
  a data extract from TPO separately. Recon samples (`/business-search/cheffins/`) suggest
  URLs carry the business name only.
- **`allowed_emails` table added** (not in the Phase 2 table list). RLS cannot read the
  `ALLOWED_EMAILS` env var, so the allowlist is mirrored into this table by
  `scripts/sync-allowed-emails.ts`. Service role only; users cannot read it. Agreed by Oli.
- **Snapshot restore is an upsert by primary key**, not delete-and-reinsert, so foreign keys
  hold. It restores changed and deleted rows; rows added after the snapshot stay. Rows with
  `manually_edited = true` are protected by a trigger, including during a restore.
- **Next.js 16 renamed middleware to proxy**: route protection is `src/proxy.ts`.
