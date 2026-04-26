#!/usr/bin/env bun
// Crossbeam partner scraper. Run: `bun main.ts`
// Pure TS — no Playwright. Replicates the Auth0 cross-origin auth flow.

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomBytes } from "node:crypto";

const AUTH0_DOMAIN = "auth.crossbeam.com";
const AUTH0_CLIENT_ID = "T8XLE1YbNDeGKSw9WrCYpdjLiB2dwZV4";
const AUTH0_AUDIENCE = "https://api.getcrossbeam.com";
const AUTH0_REALM = "Username-Password-Authentication";
const API_BASE = "https://api.crossbeam.com";
const APP_ORIGIN = "https://app.crossbeam.com";
const REDIRECT_URI = `${API_BASE}/v0.1/session/callback`;
const SCOPE = "openid profile email user_metadata";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
};

class CookieJar {
  cookies: Cookie[] = [];

  setFromResponse(res: Response, reqUrl: string) {
    const host = new URL(reqUrl).hostname;
    // Use getSetCookie if available (Bun supports it); fall back to raw header split.
    const setCookies = (res.headers as any).getSetCookie
      ? (res.headers as any).getSetCookie()
      : (() => {
          const raw = res.headers.get("set-cookie");
          return raw ? [raw] : [];
        })();
    for (const sc of setCookies) this.set(sc, host);
  }

  private set(setCookie: string, reqHost: string) {
    const parts = setCookie.split(";").map((p) => p.trim());
    const [nameValue, ...attrs] = parts;
    const eq = nameValue.indexOf("=");
    if (eq < 0) return;
    const name = nameValue.slice(0, eq);
    const value = nameValue.slice(eq + 1);
    let domain = reqHost;
    let path = "/";
    let secure = false;
    for (const a of attrs) {
      const [k, v] = a.split("=").map((s) => s?.trim());
      const lk = k.toLowerCase();
      if (lk === "domain" && v) domain = v.replace(/^\./, "");
      else if (lk === "path" && v) path = v;
      else if (lk === "secure") secure = true;
    }
    // Drop existing matching cookie.
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain === domain && c.path === path),
    );
    this.cookies.push({ name, value, domain, path, secure });
  }

  headerFor(url: string): string | undefined {
    const u = new URL(url);
    const host = u.hostname;
    const matches = this.cookies.filter((c) => {
      // Match if host ends with cookie domain (handles .crossbeam.com vs app.crossbeam.com).
      return host === c.domain || host.endsWith(`.${c.domain}`);
    });
    if (!matches.length) return undefined;
    return matches.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}

function detectBotBlock(res: Response, body: string, url: string): string | null {
  const server = res.headers.get("server")?.toLowerCase() || "";
  const cfRay = res.headers.get("cf-ray");
  const cfMitigated = res.headers.get("cf-mitigated");
  if (cfMitigated) return `Cloudflare mitigation triggered (cf-mitigated: ${cfMitigated}) at ${url}`;
  if (res.status === 403 && (server.includes("cloudflare") || cfRay)) {
    return `Cloudflare 403 at ${url} (cf-ray: ${cfRay})`;
  }
  if (res.status === 429) return `Rate limited (429) at ${url}`;
  const lower = body.toLowerCase();
  if (
    lower.includes("just a moment...") ||
    lower.includes("challenge-platform") ||
    lower.includes("cf-challenge") ||
    lower.includes("captcha") ||
    lower.includes("recaptcha") ||
    lower.includes("hcaptcha") ||
    lower.includes("please verify you are human")
  ) {
    return `Bot/CAPTCHA challenge detected at ${url}`;
  }
  return null;
}

async function request(
  jar: CookieJar,
  url: string,
  init: RequestInit & { followRedirects?: boolean } = {},
): Promise<{ res: Response; finalUrl: string; body: string }> {
  const follow = init.followRedirects !== false;
  let currentUrl = url;
  let currentInit: RequestInit = { ...init, redirect: "manual" };
  let hops = 0;
  while (true) {
    if (hops > 15) throw new Error(`Too many redirects starting from ${url}`);
    const headers = new Headers(currentInit.headers || {});
    if (!headers.has("user-agent")) headers.set("user-agent", UA);
    if (!headers.has("accept")) headers.set("accept", "*/*");
    const cookieHeader = jar.headerFor(currentUrl);
    if (cookieHeader) headers.set("cookie", cookieHeader);
    const res = await fetch(currentUrl, { ...currentInit, headers, redirect: "manual" });
    jar.setFromResponse(res, currentUrl);
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.get("location");
    if (!isRedirect || !follow) {
      const body = await res.text();
      const block = detectBotBlock(res, body, currentUrl);
      if (block) {
        console.error(`\nStopping: ${block}`);
        console.error("Bot management software detected. Retry via a browser or with different credentials/IP.");
        process.exit(2);
      }
      return { res, finalUrl: currentUrl, body };
    }
    const loc = res.headers.get("location")!;
    currentUrl = new URL(loc, currentUrl).toString();
    // After first redirect, don't re-send the body; switch to GET per browser convention on 303 etc.
    currentInit = { method: "GET", redirect: "manual" };
    hops += 1;
  }
}

function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

let pipedLines: string[] | null = null;
let pipedIdx = 0;
async function readPipedLines(): Promise<string[]> {
  if (pipedLines) return pipedLines;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  pipedLines = text.split(/\r?\n/);
  return pipedLines;
}

let sharedRl: ReturnType<typeof createInterface> | null = null;
function getRl() {
  if (!sharedRl) sharedRl = createInterface({ input: stdin, output: stdout });
  return sharedRl;
}

async function prompt(question: string, mask = false): Promise<string> {
  const isTTY = (stdin as any).isTTY === true;
  if (!isTTY) {
    const lines = await readPipedLines();
    stdout.write(question);
    const line = lines[pipedIdx++] ?? "";
    stdout.write(mask ? "\n" : line + "\n");
    return line.trim();
  }
  if (!mask) {
    const rl = getRl();
    const answer = await rl.question(question);
    return answer.trim();
  }
  // Masked password entry: write prompt, disable echo, read until newline.
  return new Promise<string>((resolve) => {
    stdout.write(question);
    const isTTY = (stdin as any).isTTY === true;
    if (isTTY) (stdin as any).setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          if (isTTY) (stdin as any).setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          resolve(buf);
          return;
        } else if (ch === "") {
          // Ctrl-C
          process.exit(130);
        } else if (ch === "" || ch === "\b") {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

async function coAuthenticate(jar: CookieJar, username: string, password: string): Promise<string> {
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
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Auth failed (${res.status}): ${text}`);
  }
  if (!res.ok) throw new Error(`co/authenticate error ${res.status}: ${text}`);
  const json = JSON.parse(text);
  if (!json.login_ticket) throw new Error(`No login_ticket in response: ${text}`);
  return json.login_ticket;
}

async function exchangeLoginTicket(jar: CookieJar, loginTicket: string): Promise<void> {
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
  if (!res.ok) {
    throw new Error(
      `Auth flow failed after /authorize: status=${res.status}, finalUrl=${finalUrl}\n${body.slice(0, 500)}`,
    );
  }
  const sessionCookie = jar.cookies.find((c) => c.name === "cb_session_id");
  if (!sessionCookie) {
    throw new Error(
      `Login flow completed but no cb_session_id cookie was set. finalUrl=${finalUrl}`,
    );
  }
}

async function apiGet<T>(jar: CookieJar, path: string, orgId?: string): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    origin: APP_ORIGIN,
    referer: `${APP_ORIGIN}/`,
  };
  if (orgId) headers["xbeam-organization"] = orgId;
  const { res, body } = await request(jar, `${API_BASE}${path}`, {
    method: "GET",
    headers,
    followRedirects: false,
  });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

type WebMe = {
  user: { id: number; email: string; first_name?: string; last_name?: string };
  authorizations: Array<{
    organization: { id: number; name: string; domain?: string | null };
  }>;
};

type Partner = {
  id: number;
  name: string;
  domain: string | null;
  clearbit_domain?: string | null;
  partnership_created_at?: string;
};

type PartnersResponse = { items: Partner[] };

async function main() {
  console.log("Crossbeam partner scraper\n");
  const email = await prompt("Email: ");
  const password = await prompt("Password: ", true);
  if (!email || !password) {
    console.error("Email and password are required.");
    process.exit(1);
  }

  const jar = new CookieJar();
  console.log("\nAuthenticating...");
  const loginTicket = await coAuthenticate(jar, email, password);
  await exchangeLoginTicket(jar, loginTicket);

  console.log("\nFetching account info...");
  const me = await apiGet<WebMe>(jar, "/v0.1/users/web-me");
  const org = me.authorizations?.[0]?.organization;
  if (!org) {
    console.error("No organizations found on this account.");
    process.exit(1);
  }
  console.log(`Logged in as ${me.user.email} — organization: ${org.name} (id ${org.id})`);

  console.log("Fetching partners...");
  const partners = await apiGet<PartnersResponse>(jar, "/v0.2/partners", String(org.id));

  console.log(`\nConnected partners (${partners.items.length}):`);
  for (const p of partners.items) {
    const domain = p.domain || p.clearbit_domain || "";
    console.log(domain ? `  - ${p.name}  (${domain})` : `  - ${p.name}`);
  }
}

main()
  .then(() => {
    sharedRl?.close();
    process.exit(0);
  })
  .catch((err) => {
    console.error("\nError:", err instanceof Error ? err.message : err);
    sharedRl?.close();
    process.exit(1);
  });
