import { and, desc, eq } from "drizzle-orm";
import { Router, type IRouter, type Request } from "express";

import {
  activityEntriesTable,
  calendarEventsTable,
  db,
  importBatchesTable,
  importRowsTable,
  type GoogleAccount,
} from "@workspace/db";
import {
  CreateEventBody,
  ExecuteImportBody,
  ExecuteImportParams,
  ExecuteImportResponse,
  ListImportsResponse,
  PreviewImportBody,
  PreviewImportResponse,
} from "@workspace/api-zod";

import { requireGoogleAccount } from "../middlewares/google-account";
import {
  buildGoogleEventPayload,
  calendarApi,
  prepareReminders,
  validateEventInput,
  type EventInput,
} from "../lib/calendar-service";
import {
  deterministicGoogleEventId,
  persistGoogleEvent,
} from "../lib/event-persistence";

const router: IRouter = Router();
router.use(requireGoogleAccount);
type InvitationStatus = "requested" | "not_requested" | "already_exists" | "not_sent" | "unknown";

function accountFrom(req: Request): GoogleAccount {
  if (!req.googleAccount) throw new Error("Google account was not loaded.");
  return req.googleAccount;
}

function safeError(error: unknown): { status?: number; message: string } {
  const candidate = error as {
    code?: number | string;
    status?: number;
    response?: { status?: number };
    message?: string;
  };
  const status =
    typeof candidate?.response?.status === "number"
      ? candidate.response.status
      : typeof candidate?.status === "number"
        ? candidate.status
        : typeof candidate?.code === "number"
          ? candidate.code
          : undefined;
  return {
    status,
    message:
      status === 403
        ? "Google did not grant the permissions needed for this event."
        : status === 401
          ? "Google authorization expired. Reconnect your account."
          : candidate?.message ?? "Google Calendar could not create this event.",
  };
}

function isInvitationStatus(value: string | null): value is InvitationStatus {
  return (
    value === "requested" ||
    value === "not_requested" ||
    value === "already_exists" ||
    value === "not_sent" ||
    value === "unknown"
  );
}

router.get("/imports", async (req, res): Promise<void> => {
  try {
    const account = accountFrom(req);
    const batches = await db
      .select()
      .from(importBatchesTable)
      .where(eq(importBatchesTable.googleAccountId, account.id))
      .orderBy(desc(importBatchesTable.createdAt))
      .limit(50);
    res.json(
      ListImportsResponse.parse(
        batches.map((batch) => ({
          id: batch.id,
          createdAt: batch.createdAt.toISOString(),
          status: batch.status,
          totalRows: batch.totalRows,
          successfulRows: batch.successfulRows,
          failedRows: batch.failedRows,
          skippedRows: batch.skippedRows,
        })),
      ),
    );
  } catch (error) {
    req.log.error({ message: safeError(error).message }, "Could not load import history");
    res.status(500).json({ error: "Import history could not be loaded." });
  }
});

router.post("/imports/preview", async (req, res): Promise<void> => {
  const parsed = PreviewImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const account = accountFrom(req);
  try {
    const checked = parsed.data.rows.map((row) => {
      const { rowNumber, idempotencyKey, ...rawEvent } = row;
      const event = CreateEventBody.safeParse(rawEvent);
      const errors = event.success ? [] : event.error.issues.map((issue) => issue.message);
      if (event.success) {
        const invalid = validateEventInput(event.data);
        if (invalid) errors.push(invalid);
      }
      return {
        rowNumber,
        idempotencyKey,
        payload: event.success ? event.data : rawEvent,
        valid: event.success && errors.length === 0,
        errors,
        title: typeof rawEvent.title === "string" ? rawEvent.title : "",
        startAt: typeof rawEvent.startAt === "string" ? rawEvent.startAt : "",
      };
    });
    const [batch] = await db
      .insert(importBatchesTable)
      .values({
        googleAccountId: account.id,
        status: "previewed",
        totalRows: checked.length,
        skippedRows: checked.filter((row) => !row.valid).length,
      })
      .returning();
    await db.insert(importRowsTable).values(
      checked.map((row) => ({
        batchId: batch.id,
        googleAccountId: account.id,
        rowNumber: row.rowNumber,
        idempotencyKey: row.idempotencyKey,
        payload: row.payload as Record<string, unknown>,
        status: row.valid ? "valid" : "invalid",
        errors: row.errors,
        lastError: row.errors.length ? row.errors.join(" ") : null,
      })),
    );
    res.json(
      PreviewImportResponse.parse({
        batchId: batch.id,
        totalRows: checked.length,
        validRows: checked.filter((row) => row.valid).length,
        invalidRows: checked.filter((row) => !row.valid).length,
        rows: checked.map((row) => ({
          rowNumber: row.rowNumber,
          valid: row.valid,
          errors: row.errors,
          title: row.title,
          startAt: row.startAt,
        })),
      }),
    );
  } catch (error) {
    req.log.error({ message: safeError(error).message }, "Could not preview event import");
    res.status(500).json({ error: "The import preview could not be saved." });
  }
});

router.post("/imports/:batchId/execute", async (req, res): Promise<void> => {
  const params = ExecuteImportParams.safeParse(req.params);
  const body = ExecuteImportBody.safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (body.data.confirmed !== true) {
    res.status(400).json({ error: "Confirm the import before creating events or sending invitations." });
    return;
  }

  const account = accountFrom(req);
  try {
    const [batch] = await db
      .select()
      .from(importBatchesTable)
      .where(
        and(
          eq(importBatchesTable.id, params.data.batchId),
          eq(importBatchesTable.googleAccountId, account.id),
        ),
      )
      .limit(1);
    if (!batch) {
      res.status(404).json({ error: "Import preview not found." });
      return;
    }
    const rows = await db
      .select()
      .from(importRowsTable)
      .where(eq(importRowsTable.batchId, batch.id))
      .orderBy(importRowsTable.rowNumber);
    const api = await calendarApi(account);
    const invitationStatuses = new Map<string, InvitationStatus>();

    for (const row of rows) {
      if (row.status === "success") {
        const previous = CreateEventBody.safeParse(row.payload);
        invitationStatuses.set(
          row.id,
          isInvitationStatus(row.invitationStatus)
            ? row.invitationStatus
            : previous.success && previous.data.guestEmails.length > 0
              ? "requested"
              : "not_requested",
        );
        continue;
      }
      if (row.status === "invalid") {
        invitationStatuses.set(row.id, "not_sent");
        continue;
      }
      const eventInput = CreateEventBody.safeParse(row.payload);
      if (!eventInput.success) {
        invitationStatuses.set(row.id, "not_sent");
        await db
          .update(importRowsTable)
          .set({
            status: "invalid",
            invitationStatus: "not_sent",
            errors: eventInput.error.issues.map((issue) => issue.message),
            lastError: "The row changed or could not be validated.",
            updatedAt: new Date(),
          })
          .where(eq(importRowsTable.id, row.id));
        continue;
      }
      const invalid = validateEventInput(eventInput.data);
      if (invalid) {
        invitationStatuses.set(row.id, "not_sent");
        await db
          .update(importRowsTable)
          .set({
            status: "invalid",
            invitationStatus: "not_sent",
            errors: [invalid],
            lastError: invalid,
            updatedAt: new Date(),
          })
          .where(eq(importRowsTable.id, row.id));
        continue;
      }

      let invitationStatus: InvitationStatus =
        eventInput.data.guestEmails.length > 0 ? "not_sent" : "not_requested";
      try {
        const prepared = prepareReminders(
          new Date(eventInput.data.startAt),
          eventInput.data.timeZone,
          eventInput.data.reminders,
        );
        let googleEvent: import("googleapis").calendar_v3.Schema$Event;
        let insertedNow = true;
        const googleEventId = deterministicGoogleEventId(account.id, row.idempotencyKey);
        try {
          // Keep one awaited Google Calendar insert per row. sendUpdates=all asks
          // Calendar to email this event's guest list before processing the next row.
          const response = await api.events.insert({
            calendarId: eventInput.data.calendarId,
            sendUpdates: "all",
            conferenceDataVersion: eventInput.data.createMeet ? 1 : 0,
            requestBody: buildGoogleEventPayload(eventInput.data, {
              googleOverrides: prepared.googleOverrides,
              deterministicId: googleEventId,
            }),
          });
          googleEvent = response.data;
          if (eventInput.data.guestEmails.length > 0) invitationStatus = "requested";
        } catch (error) {
          if (safeError(error).status !== 409) throw error;
          insertedNow = false;
          invitationStatus =
            eventInput.data.guestEmails.length > 0 ? "already_exists" : "not_requested";
          const existing = await api.events.get({
            calendarId: eventInput.data.calendarId,
            eventId: googleEventId,
          });
          googleEvent = existing.data;
        }
        const saved = await persistGoogleEvent({
          accountId: account.id,
          eventInput: eventInput.data,
          googleEvent,
          preparedReminders: prepared.rows,
          importIdempotencyKey: row.idempotencyKey,
        });
        if (insertedNow && eventInput.data.guestEmails.length > 0) {
          invitationStatus = "requested";
        }
        await db
          .update(importRowsTable)
          .set({
            status: "success",
            eventId: saved.event.id,
            invitationStatus,
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(importRowsTable.id, row.id));
        invitationStatuses.set(row.id, invitationStatus);
      } catch (error) {
        const details = safeError(error);
        if (
          invitationStatus === "not_sent" &&
          (details.status === undefined || details.status >= 500)
        ) {
          invitationStatus = "unknown";
        }
        invitationStatuses.set(row.id, invitationStatus);
        req.log.warn(
          { rowNumber: row.rowNumber, googleStatus: details.status, message: details.message },
          "Bulk event row failed",
        );
        await db
          .update(importRowsTable)
          .set({
            status: "failed",
            invitationStatus,
            lastError: details.message,
            updatedAt: new Date(),
          })
          .where(eq(importRowsTable.id, row.id));
      }
    }

    const finalRows = await db
      .select()
      .from(importRowsTable)
      .where(eq(importRowsTable.batchId, batch.id))
      .orderBy(importRowsTable.rowNumber);
    const successfulRows = finalRows.filter((row) => row.status === "success").length;
    const failedRows = finalRows.filter((row) => row.status === "failed").length;
    const skippedRows = finalRows.filter((row) => row.status === "invalid" || row.status === "skipped").length;
    const status =
      failedRows === 0
        ? "completed"
        : successfulRows > 0
          ? "partial"
          : "failed";
    await db
      .update(importBatchesTable)
      .set({
        status,
        successfulRows,
        failedRows,
        skippedRows,
        executedAt: new Date(),
      })
      .where(eq(importBatchesTable.id, batch.id));
    await db.insert(activityEntriesTable).values({
      googleAccountId: account.id,
      kind: "import_completed",
      message: `Bulk event import finished: ${successfulRows} created, ${failedRows} failed, ${skippedRows} skipped.`,
      status: failedRows > 0 ? "warning" : "success",
    });
    res.json(
      ExecuteImportResponse.parse({
        batchId: batch.id,
        successfulRows,
        failedRows,
        skippedRows,
        rows: finalRows.map((row) => ({
          rowNumber: row.rowNumber,
          status: row.status === "success" ? "success" : row.status === "failed" ? "failed" : "skipped",
          eventId: row.eventId,
          error: row.lastError,
          invitationStatus:
            invitationStatuses.get(row.id) ??
            (row.status === "success" ? "requested" : "not_sent"),
        })),
      }),
    );
  } catch (error) {
    const details = safeError(error);
    req.log.error(
      { googleStatus: details.status, message: details.message },
      "Could not execute bulk event import",
    );
    res.status(details.status === 401 || details.status === 403 ? details.status : 500).json({
      error: details.message,
    });
  }
});

export default router;
