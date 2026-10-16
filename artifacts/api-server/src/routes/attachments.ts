import { Router, type IRouter, type Request } from "express";

import {
  RequestReminderAttachmentUploadBody,
  RequestReminderAttachmentUploadResponse,
} from "@workspace/api-zod";

import { requireGoogleAccount } from "../middlewares/google-account";
import {
  createReminderAttachmentUpload,
  MAX_REMINDER_ATTACHMENT_BYTES,
} from "../lib/reminder-attachment-storage";

const router: IRouter = Router();
router.use(requireGoogleAccount);

function accountIdFrom(req: Request): string {
  if (!req.googleAccount) throw new Error("Google account was not loaded.");
  return req.googleAccount.id;
}

router.post("/storage/uploads/request-url", async (req, res): Promise<void> => {
  const parsed = RequestReminderAttachmentUploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const input = parsed.data;
  if (input.size > MAX_REMINDER_ATTACHMENT_BYTES) {
    res.status(413).json({ error: "Reminder attachments must be 15 MB or smaller." });
    return;
  }

  const fileName = input.fileName
    .trim()
    .replace(/[\u0000-\u001f\u007f\r\n/\\:]/g, "_")
    .slice(0, 255);
  const contentType = /^[\w.+-]+\/[\w.+-]+$/.test(input.contentType)
    ? input.contentType
    : "application/octet-stream";
  if (!fileName) {
    res.status(400).json({ error: "Choose a file with a valid name." });
    return;
  }

  try {
    const result = await createReminderAttachmentUpload(accountIdFrom(req), {
      fileName,
      contentType,
      size: input.size,
    });
    res.json(RequestReminderAttachmentUploadResponse.parse(result));
  } catch (error) {
    req.log.error({ error }, "Could not create reminder attachment upload URL");
    res.status(500).json({ error: "The attachment upload could not be started." });
  }
});

export default router;
