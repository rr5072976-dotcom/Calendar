import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import { eq } from "drizzle-orm";
import { google } from "googleapis";

import { db, googleAccountsTable, type GoogleAccount } from "@workspace/db";

const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

export type OAuthClientCredentials = {
  clientId: string;
  clientSecret: string;
};

export function getGoogleRedirectUri(request?: {
  protocol: string;
  get(name: string): string | undefined;
}): string {
  if (!request) {
    throw new Error("The request host is required to build the Google callback URL.");
  }
  const host = request.get("host");
  if (!host) throw new Error("The request host is unavailable");
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)) {
    throw new Error("The request host is invalid.");
  }
  const protocol = process.env.NODE_ENV === "production" ? "https" : request.protocol;
  return new URL("/api/auth/google/callback", `${protocol}://${host}`).toString();
}

export function createGoogleOAuthClient(
  credentials: OAuthClientCredentials,
  redirectUri?: string,
) {
  return new google.auth.OAuth2(credentials.clientId, credentials.clientSecret, redirectUri);
}

export function getGoogleScopes(): string[] {
  return [...SCOPES];
}

function encryptionKey(): Buffer {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) throw new Error("SESSION_SECRET must be configured to protect OAuth tokens.");
  return createHash("sha256").update(`smart-calendar-token-v1:${sessionSecret}`).digest();
}

function oauthClientEncryptionKey(): Buffer {
  const sessionSecret = process.env.SESSION_SECRET;
  if (!sessionSecret) throw new Error("SESSION_SECRET must be configured to protect OAuth credentials.");
  return createHash("sha256").update(`smart-calendar-oauth-client-v1:${sessionSecret}`).digest();
}

export function encryptOAuthTokens(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), authTag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptOAuthTokens(payload: string): string {
  const [version, ivText, authTagText, encryptedText] = payload.split(".");
  if (version !== "v1" || !ivText || !authTagText || !encryptedText) {
    throw new Error("Stored Google credentials are unreadable.");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(authTagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function encryptOAuthClientCredentials(credentials: OAuthClientCredentials): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", oauthClientEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(credentials), "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), authTag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptOAuthClientCredentials(payload: string): OAuthClientCredentials {
  const [version, ivText, authTagText, encryptedText] = payload.split(".");
  if (version !== "v1" || !ivText || !authTagText || !encryptedText) {
    throw new Error("Stored Google OAuth client credentials are unreadable.");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    oauthClientEncryptionKey(),
    Buffer.from(ivText, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(authTagText, "base64url"));
  const decoded = Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const credentials = JSON.parse(decoded) as Partial<OAuthClientCredentials>;
  if (
    typeof credentials.clientId !== "string" ||
    typeof credentials.clientSecret !== "string" ||
    !credentials.clientId ||
    !credentials.clientSecret
  ) {
    throw new Error("Stored Google OAuth client credentials are incomplete.");
  }
  return { clientId: credentials.clientId, clientSecret: credentials.clientSecret };
}

export async function loadGoogleAccount(accountId: string): Promise<GoogleAccount | undefined> {
  const [account] = await db
    .select()
    .from(googleAccountsTable)
    .where(eq(googleAccountsTable.id, accountId))
    .limit(1);
  return account;
}

export async function getGoogleClient(account: GoogleAccount) {
  if (!account.encryptedOAuthClientCredentials) {
    throw new Error("Google OAuth credentials are missing for this account. Reconnect it from Settings.");
  }
  const oauthCredentials = decryptOAuthClientCredentials(account.encryptedOAuthClientCredentials);
  const client = createGoogleOAuthClient(oauthCredentials);
  const credentials = JSON.parse(decryptOAuthTokens(account.encryptedTokens)) as Record<string, unknown>;
  client.setCredentials(credentials);
  await client.getAccessToken();
  const refreshedCredentials = client.credentials;
  if (refreshedCredentials.access_token) {
    await db
      .update(googleAccountsTable)
      .set({
        encryptedTokens: encryptOAuthTokens(JSON.stringify(refreshedCredentials)),
        updatedAt: new Date(),
      })
      .where(eq(googleAccountsTable.id, account.id));
  }
  return client;
}

export async function refreshGoogleAccountTokens(accountId: string): Promise<GoogleAccount> {
  const account = await loadGoogleAccount(accountId);
  if (!account) throw new Error("The connected Google account no longer exists.");
  const client = await getGoogleClient(account);
  const encryptedTokens = encryptOAuthTokens(JSON.stringify(client.credentials));
  const [updated] = await db
    .update(googleAccountsTable)
    .set({ encryptedTokens, updatedAt: new Date() })
    .where(eq(googleAccountsTable.id, account.id))
    .returning();
  return updated ?? account;
}
