---
name: Bulk reminder schedules
description: User-approved reminder configuration behavior for bulk imports.
---

Bulk imports must support both a batch-wide default reminder schedule and optional per-event reminder schedules from the import file.

**Why:** The user explicitly chose both configuration styles when asked how bulk imports should assign reminders.

**How to apply:** Preserve both configuration paths when changing bulk-import reminders or their CSV template.
