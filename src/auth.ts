import { randomBytes } from "node:crypto";
import { CookieJar } from "./cookie-jar.js";
import { request } from "./http.js";

export const AUTH0_DOMAIN = "auth.crossbeam.com";
export const AUTH0_CLIENT_ID = "T8XLE1YbNDeGKSw9WrCYpdjLiB2dwZV4";
export const AUTH0_AUDIENCE = "https://api.getcrossbeam.com";
export const AUTH0_REALM = "Username-Password-Authentication";
export const API_BASE = "https://api.crossbeam.com";
export const APP_ORIGIN = "https://app.crossbeam.com";
export const REDIRECT_URI = `${API_BASE}/v0.1/session/callback`;
export const SCOPE = "openid profile email user_metadata";

export class AuthError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export async function coAuthenticate(
  jar: CookieJar,
  username: string,
  password: string,
): Promise<string> {
  const url = `https://${AUTH0_DOMAIN}/co/authenticate`;
  const body = {
    client_id: AUTH0_CLIENT_ID,
    username,
    password,
    realm: AUTH0_REALM,
    credential_type: "http://auth0.com/oauth/grant-type/password-realm",
  };
  const { res, body: text } = await request(jar, url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "auth0-client": Buffer.from(
        JSON.stringify({ name: "auth0.js", version: "9.28.0" }),
      ).toString("base64"),
      origin: APP_ORIGIN,
      referer: `${APP_ORIGIN}/`,
    },
    body: JSON.stringify(body),
    followRedirects: false,
  });
  if (res.status === 401 || res.status === 403)
    throw new AuthError(`Auth failed (${res.status}): ${text}`, res.status);
  if (!res.ok) throw new AuthError(`co/authenticate error ${res.status}: ${text}`, res.status);
  const json = JSON.parse(text);
  if (!json.login_ticket) throw new AuthError(`No login_ticket in response: ${text}`);
  return json.login_ticket as string;
}

export async function exchangeLoginTicket(jar: CookieJar, loginTicket: string): Promise<void> {
  const state = randomBase64Url(24);
  const nonce = randomBase64Url(24);
  const authorizeUrl =
    `https://${AUTH0_DOMAIN}/authorize?` +
    new URLSearchParams({
      client_id: AUTH0_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      audience: AUTH0_AUDIENCE,
      scope: SCOPE,
      state,
      nonce,
      login_ticket: loginTicket,
      realm: AUTH0_REALM,
      response_mode: "query",
      auth0Client: Buffer.from(
        JSON.stringify({ name: "auth0.js", version: "9.28.0" }),
      ).toString("base64"),
    }).toString();
  const { res, finalUrl, body } = await request(jar, authorizeUrl, {
    method: "GET",
    headers: { referer: `${APP_ORIGIN}/` },
  });
  if (!res.ok)
    throw new AuthError(
      `Auth flow failed: status=${res.status}, finalUrl=${finalUrl}\n${body.slice(0, 500)}`,
      res.status,
    );
  if (!jar.cookies.some((c) => c.name === "cb_session_id"))
    throw new AuthError("Login completed but no cb_session_id cookie was set");
}
