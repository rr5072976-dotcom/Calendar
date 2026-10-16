import { randomUUID } from "node:crypto";

import type { ReminderAttachmentRecord } from "@workspace/db";

export const MAX_REMINDER_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const STORAGE_SIDECAR_ENDPOINT = "http://127.0.0.1:1106/object-storage/signed-object-url";

type ObjectLocation = {
  bucketName: string;
  objectName: string;
};

function privateObjectDirectory(): string {
  const directory = process.env.PRIVATE_OBJECT_DIR?.trim();
  if (!directory) throw new Error("Private object storage is not configured.");
  return directory.replace(/\/+$/, "");
}

function parseStoragePath(fullPath: string): ObjectLocation {
  const [bucketName, ...objectParts] = fullPath.split("/").filter(Boolean);
  if (!bucketName || objectParts.length === 0) {
    throw new Error("Private object storage path is invalid.");
  }
  return { bucketName, objectName: objectParts.join("/") };
}

function getAttachmentLocation(objectPath: string, accountId: string): ObjectLocation {
  const accountPrefix = `/objects/reminder-attachments/${accountId}/`;
  if (!objectPath.startsWith(accountPrefix)) {
    throw new Error("This attachment does not belong to the connected Google account.");
  }
  const relativePath = objectPath.slice("/objects/".length);
  return parseStoragePath(`${privateObjectDirectory()}/${relativePath}`);
}

async function signObjectUrl(
  location: ObjectLocation,
  method: "PUT" | "GET" | "HEAD",
): Promise<string> {
  const response = await fetch(STORAGE_SIDECAR_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: location.bucketName,
      object_name: location.objectName,
      method,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Could not create a private storage URL (${response.status}).`);
  }
  const result = (await response.json()) as { signed_url?: unknown };
  if (typeof result.signed_url !== "string") {
    throw new Error("Private storage did not return a signed URL.");
  }
  return result.signed_url;
}

export async function createReminderAttachmentUpload(
  accountId: string,
  input: Omit<ReminderAttachmentRecord, "objectPath">,
): Promise<{ uploadURL: string; attachment: ReminderAttachmentRecord }> {
  const objectPath = `/objects/reminder-attachments/${accountId}/${randomUUID()}`;
  const location = getAttachmentLocation(objectPath, accountId);
  return {
    uploadURL: await signObjectUrl(location, "PUT"),
    attachment: { objectPath, ...input },
  };
}

export async function verifyReminderAttachment(
  attachment: ReminderAttachmentRecord,
  accountId: string,
): Promise<void> {
  if (attachment.size < 1 || attachment.size > MAX_REMINDER_ATTACHMENT_BYTES) {
    throw new Error("Reminder attachments must be 15 MB or smaller.");
  }
  const location = getAttachmentLocation(attachment.objectPath, accountId);
  const response = await fetch(await signObjectUrl(location, "HEAD"), {
    method: "HEAD",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error("The reminder attachment upload could not be verified. Upload it again.");
  }
  const uploadedSize = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(uploadedSize) || uploadedSize !== attachment.size) {
    throw new Error("The uploaded attachment size does not match. Upload the file again.");
  }
  if (uploadedSize > MAX_REMINDER_ATTACHMENT_BYTES) {
    throw new Error("Reminder attachments must be 15 MB or smaller.");
  }
}

export async function downloadReminderAttachment(
  attachment: ReminderAttachmentRecord,
  accountId: string,
): Promise<Buffer> {
  if (attachment.size < 1 || attachment.size > MAX_REMINDER_ATTACHMENT_BYTES) {
    throw new Error("Reminder attachments must be 15 MB or smaller.");
  }
  const location = getAttachmentLocation(attachment.objectPath, accountId);
  const response = await fetch(await signObjectUrl(location, "GET"), {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) {
    throw new Error("The reminder attachment could not be downloaded from private storage.");
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_REMINDER_ATTACHMENT_BYTES) {
      await reader.cancel();
      throw new Error("Reminder attachments must be 15 MB or smaller.");
    }
    chunks.push(Buffer.from(value));
  }
  if (totalBytes !== attachment.size) {
    throw new Error("The stored reminder attachment has changed size.");
  }
  return Buffer.concat(chunks, totalBytes);
}
