import { randomBytes, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { CodeChallengeMethod } from "google-auth-library";

import {
  db,
  googleAccountsTable,
} from "@workspace/db";
import {
  GetGoogleSessionResponse,
  GetGoogleSetupResponse,
  SaveGoogleOAuthClientBody,
  SaveGoogleOAuthClientResponse,
} from "@workspace/api-zod";

import { requireGoogleAccount } from "../middlewares/google-account";
import {
  createGoogleOAuthClient,
  decryptOAuthClientCredentials,
  decryptOAuthTokens,
  encryptOAuthClientCredentials,
  encryptOAuthTokens,
  getGoogleRedirectUri,
  getGoogleScopes,
  loadGoogleAccount,
  type OAuthClientCredentials,
} from "../lib/google";

const router: IRouter = Router();
const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
const oauthClientLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

function appRedirect(res: Response, state: string): void {
  res.redirect(`/?auth=${encodeURIComponent(state)}`);
}

function queryValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function safeStateMatches(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

async function sessionOAuthClientCredentials(
  req: Request,
): Promise<OAuthClientCredentials | undefined> {
  if (req.session.encryptedOAuthClientCredentials) {
    return decryptOAuthClientCredentials(req.session.encryptedOAuthClientCredentials);
  }
  if (!req.session.accountId) return undefined;

  const account = await loadGoogleAccount(req.session.accountId);
  if (!account?.encryptedOAuthClientCredentials) return undefined;
  req.session.encryptedOAuthClientCredentials = account.encryptedOAuthClientCredentials;
  return decryptOAuthClientCredentials(account.encryptedOAuthClientCredentials);
}

router.get("/auth/setup", async (req, res): Promise<void> => {
  try {
    const credentials = await sessionOAuthClientCredentials(req);
    res.json(
      GetGoogleSetupResponse.parse({
        credentialsConfigured: Boolean(credentials),
        callbackUrl: getGoogleRedirectUri(req),
        production: process.env.NODE_ENV === "production",
      }),
    );
  } catch (error) {
    req.log.error({ error }, "Could not load Google OAuth setup");
    res.status(500).json({ error: "Google OAuth setup could not be loaded." });
  }
});

router.put("/auth/oauth-client", oauthClientLimiter, async (req, res): Promise<void> => {
  const parsed = SaveGoogleOAuthClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const credentials = {
    clientId: parsed.data.clientId.trim(),
    clientSecret: parsed.data.clientSecret.trim(),
  };
  if (!credentials.clientId || !credentials.clientSecret) {
    res.status(400).json({ error: "Enter both a Google OAuth client ID and client secret." });
    return;
  }

  try {
    req.session.encryptedOAuthClientCredentials = encryptOAuthClientCredentials(credentials);
    await new Promise<void>((resolve, reject) => {
      req.session.save((error) => (error ? reject(error) : resolve()));
    });
    res.json(SaveGoogleOAuthClientResponse.parse({ configured: true }));
  } catch (error) {
    req.log.error({ error }, "Could not save Google OAuth client credentials");
    res.status(500).json({ error: "Google OAuth credentials could not be saved." });
  }
});

router.get("/auth/google", googleAuthLimiter, async (req, res): Promise<void> => {
  try {
    const credentials = await sessionOAuthClientCredentials(req);
    if (!credentials) {
      appRedirect(res, "unconfigured");
      return;
    }
    const oauth = createGoogleOAuthClient(credentials, getGoogleRedirectUri(req));
    const { codeVerifier, codeChallenge } = await oauth.generateCodeVerifierAsync();
    const state = randomBytes(32).toString("base64url");
    req.session.oauthState = state;
    req.session.oauthCodeVerifier = codeVerifier;
    const authUrl = oauth.generateAuthUrl({
      access_type: "offline",
      include_granted_scopes: true,
      prompt: "consent",
      scope: getGoogleScopes(),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    res.redirect(authUrl);
  } catch (error) {
    req.log.error({ error }, "Could not start Google OAuth");
    appRedirect(res, "unconfigured");
  }
});

router.get("/auth/google/callback", googleAuthLimiter, async (req, res): Promise<void> => {
  const code = queryValue(req.query.code);
  const state = queryValue(req.query.state);
  const oauthState = req.session.oauthState;
  const codeVerifier = req.session.oauthCodeVerifier;
  delete req.session.oauthState;
  delete req.session.oauthCodeVerifier;

  if (queryValue(req.query.error)) {
    appRedirect(res, "cancelled");
    return;
  }
  if (!code || !safeStateMatches(oauthState, state) || !codeVerifier) {
    req.log.warn("Rejected invalid Google OAuth callback state");
    appRedirect(res, "failed");
    return;
  }

  try {
    const clientCredentials = await sessionOAuthClientCredentials(req);
    if (!clientCredentials) {
      appRedirect(res, "unconfigured");
      return;
    }
    const encryptedOAuthClientCredentials =
      req.session.encryptedOAuthClientCredentials ??
      encryptOAuthClientCredentials(clientCredentials);
    const oauth = createGoogleOAuthClient(clientCredentials, getGoogleRedirectUri(req));
    const { tokens } = await oauth.getToken({ code, codeVerifier });
    oauth.setCredentials(tokens);
    if (!tokens.id_token) {
      throw new Error("Google did not return a verified identity token.");
    }
    const ticket = await oauth.verifyIdToken({
      idToken: tokens.id_token,
      audience: clientCredentials.clientId,
    });
    const profile = ticket.getPayload();
    if (!profile?.sub || !profile.email || profile.email_verified !== true) {
      throw new Error("Google did not return a verified email address.");
    }

    const [existingAccount] = await db
      .select()
      .from(googleAccountsTable)
      .where(eq(googleAccountsTable.googleSub, profile.sub))
      .limit(1);
    const existingOAuthClientId = existingAccount?.encryptedOAuthClientCredentials
      ? decryptOAuthClientCredentials(existingAccount.encryptedOAuthClientCredentials).clientId
      : undefined;
    const previousTokens =
      existingAccount && existingOAuthClientId === clientCredentials.clientId
        ? JSON.parse(decryptOAuthTokens(existingAccount.encryptedTokens)) as Record<string, unknown>
        : {};
    const storedTokens = {
      ...previousTokens,
      ...tokens,
      refresh_token: tokens.refresh_token ?? previousTokens.refresh_token,
    };
    const scopes = tokens.scope ?? existingAccount?.scopes ?? getGoogleScopes().join(" ");
    const [account] = await db
      .insert(googleAccountsTable)
      .values({
        googleSub: profile.sub,
        email: profile.email,
        displayName: profile.name ?? profile.email,
        avatarUrl: profile.picture ?? null,
        encryptedTokens: encryptOAuthTokens(JSON.stringify(storedTokens)),
        encryptedOAuthClientCredentials,
        scopes,
      })
      .onConflictDoUpdate({
        target: googleAccountsTable.googleSub,
        set: {
          email: profile.email,
          displayName: profile.name ?? profile.email,
          avatarUrl: profile.picture ?? null,
          encryptedTokens: encryptOAuthTokens(JSON.stringify(storedTokens)),
          encryptedOAuthClientCredentials,
          scopes,
          updatedAt: new Date(),
        },
      })
      .returning();

    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((error) => (error ? reject(error) : resolve()));
    });
    req.session.encryptedOAuthClientCredentials = encryptedOAuthClientCredentials;
    req.session.accountId = account.id;
    await new Promise<void>((resolve, reject) => {
      req.session.save((error) => (error ? reject(error) : resolve()));
    });
    appRedirect(res, "connected");
  } catch (error) {
    req.log.error({ error }, "Google OAuth callback failed");
    appRedirect(res, "failed");
  }
});

router.get("/auth/session", async (req, res): Promise<void> => {
  const accountId = req.session.accountId;
  const account = accountId ? await loadGoogleAccount(accountId) : undefined;
  if (!account && accountId) delete req.session.accountId;
  res.json(
    GetGoogleSessionResponse.parse({
      connected: Boolean(account),
      email: account?.email ?? null,
      displayName: account?.displayName ?? null,
      avatarUrl: account?.avatarUrl ?? null,
    }),
  );
});

router.post("/auth/logout", requireGoogleAccount, async (req, res): Promise<void> => {
  delete req.session.accountId;
  delete req.session.oauthState;
  delete req.session.oauthCodeVerifier;
  await new Promise<void>((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });
  res.sendStatus(204);
});

export default router;
