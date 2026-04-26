#!/usr/bin/env bun
// Crossbeam CLI. Run: `bun main.ts <command> --user <email> --pass <password>`
// Pure TS, no Playwright. Logs in via Auth0 cross-origin auth and calls the
// internal api.crossbeam.com endpoints directly.

import { randomBytes } from "node:crypto";
import { stdin, stdout, env, argv } from "node:process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AUTH0_DOMAIN = "auth.crossbeam.com";
const AUTH0_CLIENT_ID = "T8XLE1YbNDeGKSw9WrCYpdjLiB2dwZV4";
const AUTH0_AUDIENCE = "https://api.getcrossbeam.com";
const AUTH0_REALM = "Username-Password-Authentication";
const API_BASE = "https://api.crossbeam.com";
const APP_ORIGIN = "https://app.crossbeam.com";
const REDIRECT_URI = `${API_BASE}/v0.1/session/callback`;
const SCOPE = "openid profile email user_metadata";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

// ─────────────────────────── cookie jar ───────────────────────────

type Cookie = { name: string; value: string; domain: string; path: string };

class CookieJar {
  cookies: Cookie[] = [];

  setFromResponse(res: Response, reqUrl: string) {
    const reqHost = new URL(reqUrl).hostname;
    const setCookies = (res.headers as any).getSetCookie
      ? (res.headers as any).getSetCookie()
      : (() => {
          const raw = res.headers.get("set-cookie");
          return raw ? [raw] : [];
        })();
    for (const sc of setCookies) this.set(sc, reqHost);
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
    for (const a of attrs) {
      const [k, v] = a.split("=").map((s) => s?.trim());
      const lk = k.toLowerCase();
      if (lk === "domain" && v) domain = v.replace(/^\./, "");
      else if (lk === "path" && v) path = v;
    }
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain === domain && c.path === path),
    );
    this.cookies.push({ name, value, domain, path });
  }

  headerFor(url: string): string | undefined {
    const host = new URL(url).hostname;
    const matches = this.cookies.filter(
      (c) => host === c.domain || host.endsWith(`.${c.domain}`),
    );
    if (!matches.length) return undefined;
    return matches.map((c) => `${c.name}=${c.value}`).join("; ");
  }
}

// ─────────────────────────── http with redirects ───────────────────────────

function detectBotBlock(res: Response, body: string, url: string): string | null {
  const server = res.headers.get("server")?.toLowerCase() || "";
  const cfRay = res.headers.get("cf-ray");
  const cfMitigated = res.headers.get("cf-mitigated");
  if (cfMitigated) return `Cloudflare mitigation (cf-mitigated: ${cfMitigated}) at ${url}`;
  if (res.status === 403 && (server.includes("cloudflare") || cfRay))
    return `Cloudflare 403 at ${url} (cf-ray: ${cfRay})`;
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
  )
    return `Bot/CAPTCHA challenge detected at ${url}`;
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
        console.error("Bot management software detected. Aborting.");
        process.exit(2);
      }
      return { res, finalUrl: currentUrl, body };
    }
    const loc = res.headers.get("location")!;
    currentUrl = new URL(loc, currentUrl).toString();
    currentInit = { method: "GET", redirect: "manual" };
    hops += 1;
  }
}

// ─────────────────────────── session cache ───────────────────────────

const SESSION_DIR = join(homedir(), ".crossbeam");
const SESSION_FILE = join(SESSION_DIR, "session.json");

type CachedSession = { cookies: Cookie[]; orgId?: string; me?: any; ts: number };

function loadSession(user: string): CachedSession | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const raw = readFileSync(SESSION_FILE, "utf8");
    const obj = JSON.parse(raw) as Record<string, CachedSession>;
    const entry = obj[user];
    if (!entry) return null;
    // Ignore sessions older than 6 hours.
    if (Date.now() - entry.ts > 6 * 60 * 60 * 1000) return null;
    return entry;
  } catch {
    return null;
  }
}

function saveSession(user: string, jar: CookieJar, orgId: string, me: any) {
  let obj: Record<string, CachedSession> = {};
  if (existsSync(SESSION_FILE)) {
    try {
      obj = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    } catch {
      obj = {};
    }
  }
  obj[user] = { cookies: jar.cookies, orgId, me, ts: Date.now() };
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2));
  try {
    chmodSync(SESSION_FILE, 0o600);
  } catch {}
}

function clearSession(user?: string) {
  if (!existsSync(SESSION_FILE)) return;
  if (!user) {
    writeFileSync(SESSION_FILE, "{}");
    return;
  }
  try {
    const obj = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    delete obj[user];
    writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2));
  } catch {}
}

// ─────────────────────────── auth ───────────────────────────

function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
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
  if (res.status === 401 || res.status === 403)
    throw new Error(`Auth failed (${res.status}): ${text}`);
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
  if (!res.ok)
    throw new Error(
      `Auth flow failed: status=${res.status}, finalUrl=${finalUrl}\n${body.slice(0, 500)}`,
    );
  if (!jar.cookies.some((c) => c.name === "cb_session_id"))
    throw new Error("Login completed but no cb_session_id cookie was set");
}

// ─────────────────────────── api client ───────────────────────────

class Client {
  constructor(
    public jar: CookieJar,
    public orgId: string,
  ) {}

  async get<T = any>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    let url = `${API_BASE}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += (path.includes("?") ? "&" : "?") + qs;
    }
    const { res, body } = await request(this.jar, url, {
      method: "GET",
      headers: this.headers(),
      followRedirects: false,
    });
    if (!res.ok)
      throw new Error(`GET ${path} failed: ${res.status} ${body.slice(0, 300)}`);
    if (!body) return null as T;
    try {
      return JSON.parse(body) as T;
    } catch {
      return body as unknown as T;
    }
  }

  async post<T = any>(path: string, body?: unknown): Promise<T> {
    const url = `${API_BASE}${path}`;
    const { res, body: text } = await request(this.jar, url, {
      method: "POST",
      headers: { ...this.headers(), "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      followRedirects: false,
    });
    if (!res.ok)
      throw new Error(`POST ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  private headers(): Record<string, string> {
    return {
      accept: "application/json",
      origin: APP_ORIGIN,
      referer: `${APP_ORIGIN}/`,
      "xbeam-organization": this.orgId,
    };
  }
}

// ─────────────────────────── arg parsing ───────────────────────────

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "h",
  "no-cache",
  "fresh-login",
  "inactive",
  "include-deleted",
]);
const VALUE_FLAGS = new Set([
  "user", "u", "username",
  "pass", "p", "password",
  "org",
]);

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") || (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a))) {
      const isLong = a.startsWith("--");
      const stripped = isLong ? a.slice(2) : a.slice(1);
      const eq = stripped.indexOf("=");
      if (eq >= 0) {
        flags[stripped.slice(0, eq)] = stripped.slice(eq + 1);
      } else {
        const name = stripped;
        if (BOOLEAN_FLAGS.has(name)) {
          flags[name] = true;
        } else if (VALUE_FLAGS.has(name)) {
          const next = args[i + 1];
          if (next === undefined) throw new Error(`--${name} requires a value`);
          flags[name] = next;
          i += 1;
        } else {
          // Unknown flag — peek next; if it doesn't start with -, treat as value.
          const next = args[i + 1];
          if (next !== undefined && !next.startsWith("-")) {
            flags[name] = next;
            i += 1;
          } else {
            flags[name] = true;
          }
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flag(args: ParsedArgs, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = args.flags[n];
    if (v !== undefined) return typeof v === "boolean" ? "" : v;
  }
  return undefined;
}

function boolFlag(args: ParsedArgs, ...names: string[]): boolean {
  for (const n of names) if (args.flags[n] !== undefined) return Boolean(args.flags[n]);
  return false;
}

// ─────────────────────────── output ───────────────────────────

function isJsonOutput(args: ParsedArgs): boolean {
  return boolFlag(args, "json");
}

function output(args: ParsedArgs, value: unknown, prettyPrint?: () => void) {
  if (isJsonOutput(args) || !prettyPrint) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  prettyPrint();
}

function table(rows: Array<Record<string, unknown>>, columns?: string[]) {
  if (!rows.length) {
    console.log("(empty)");
    return;
  }
  const cols = columns ?? Object.keys(rows[0]);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ");
  console.log(fmt(cols));
  console.log(fmt(widths.map((w) => "-".repeat(w))));
  for (const r of rows) {
    console.log(
      fmt(
        cols.map((c) => {
          const v = r[c];
          return v === undefined || v === null ? "" : String(v);
        }),
      ),
    );
  }
}

// ─────────────────────────── command handlers ───────────────────────────

type Cmd = {
  name: string;
  args?: string;
  describe: string;
  run: (client: Client, me: any, args: ParsedArgs) => Promise<void>;
};

const commands: Cmd[] = [
  {
    name: "me",
    describe: "Show the current user, organization and roles",
    run: async (c, me, args) => {
      output(args, me, () => {
        const auth = me.authorizations?.[0];
        const org = auth?.organization;
        console.log(`User:         ${me.user?.first_name ?? ""} ${me.user?.last_name ?? ""}  <${me.user?.email}>`);
        console.log(`User ID:      ${me.user?.id}`);
        console.log(`Organization: ${org?.name}  (id ${org?.id}, domain ${org?.domain ?? "-"})`);
        console.log(`Role:         ${auth?.role?.name ?? "-"}`);
      });
    },
  },
  {
    name: "team",
    describe: "List members of your organization",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.1/team");
      const auths = data.authorizations ?? data.items ?? data.users ?? (Array.isArray(data) ? data : []);
      output(args, data, () =>
        table(
          auths.map((a: any) => {
            const u = a.user ?? a;
            return {
              user_id: u.id,
              email: u.email,
              name: [u.first_name, u.last_name].filter(Boolean).join(" "),
              seat: a.seat_type ?? "",
              login: a.login_method ?? "",
              active: u.active ?? "",
            };
          }),
          ["user_id", "email", "name", "seat", "login", "active"],
        ),
      );
    },
  },
  {
    name: "roles",
    describe: "List roles defined for the organization",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.1/roles");
      const items = Array.isArray(data) ? data : data.items ?? [];
      output(args, data, () =>
        table(
          items.map((r: any) => ({
            id: r.id,
            name: r.name,
            type: r.role_type,
            seat: r.seat_type,
          })),
          ["id", "name", "type", "seat"],
        ),
      );
    },
  },
  {
    name: "permissions",
    describe: "List permissions for current user",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.1/permissions");
      output(args, data);
    },
  },
  {
    name: "feature-flags",
    describe: "List feature flags for the organization",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.1/feature-flags");
      output(args, data);
    },
  },
  {
    name: "partners",
    args: "list | get <id> | users <id> | tags <id> | team-access <id> | pending | suggestions | overlap-counts | favorites",
    describe: "Partner-related queries",
    run: async (c, _me, args) => {
      const sub = args.positional[1];
      if (!sub || sub === "list") {
        const data = await c.get<any>("/v0.2/partners");
        const items = data.items ?? data;
        output(args, data, () =>
          table(
            items.map((p: any) => ({
              id: p.id,
              uuid: p.uuid ?? "",
              name: p.name,
              domain: p.domain ?? p.clearbit_domain ?? "",
              partnered: p.partnership_created_at?.slice(0, 10) ?? "",
            })),
            ["id", "uuid", "name", "domain", "partnered"],
          ),
        );
        return;
      }
      const resolveUuid = async (idOrUuid: string): Promise<string> => {
        if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(idOrUuid)) return idOrUuid;
        const partners = await c.get<any>("/v0.2/partners");
        const items = partners.items ?? partners;
        const p = items.find((x: any) => String(x.id) === idOrUuid || x.uuid === idOrUuid);
        if (!p?.uuid) throw new Error(`No partner found with id/uuid ${idOrUuid}`);
        return p.uuid;
      };
      if (sub === "get") {
        const id = args.positional[2];
        if (!id) throw new Error("partners get <id|uuid>");
        const uuid = await resolveUuid(id);
        const data = await c.get<any>(`/v0.1/partners/${uuid}`);
        output(args, data);
        return;
      }
      if (sub === "users") {
        const id = args.positional[2];
        if (!id) throw new Error("partners users <id|uuid>");
        const uuid = await resolveUuid(id);
        const data = await c.get<any>(`/v0.1/partners/${uuid}/users`);
        const items = Array.isArray(data) ? data : data.items ?? data.users ?? [];
        output(args, data, () =>
          table(
            items.map((u: any) => ({
              id: u.id,
              email: u.email,
              name: [u.first_name, u.last_name].filter(Boolean).join(" "),
              title: u.job_title ?? "",
            })),
            ["id", "email", "name", "title"],
          ),
        );
        return;
      }
      if (sub === "tags") {
        const id = args.positional[2];
        if (!id) throw new Error("partners tags <id|uuid>");
        const uuid = await resolveUuid(id);
        const data = await c.get<any>(`/v0.1/partners/${uuid}/tags`);
        output(args, data);
        return;
      }
      if (sub === "team-access") {
        const id = args.positional[2];
        if (!id) throw new Error("partners team-access <id|uuid>");
        const uuid = await resolveUuid(id);
        const data = await c.get<any>(`/v0.1/partners/${uuid}/team-access`);
        output(args, data);
        return;
      }
      if (sub === "pending") {
        const [inbound, outbound] = await Promise.all([
          c.get<any>("/v0.1/inbound-share-requests"),
          c.get<any>("/v0.1/outbound-share-requests"),
        ]);
        output(args, { inbound, outbound }, () => {
          const inItems = Array.isArray(inbound) ? inbound : inbound.items ?? [];
          const outItems = Array.isArray(outbound) ? outbound : outbound.items ?? [];
          console.log(`Inbound (${inItems.length}):`);
          table(
            inItems.map((r: any) => ({
              id: r.id,
              from: r.requesting_organization?.name ?? r.organization?.name ?? "",
              status: r.status,
              created: r.created_at?.slice(0, 10) ?? "",
            })),
            ["id", "from", "status", "created"],
          );
          console.log(`\nOutbound (${outItems.length}):`);
          table(
            outItems.map((r: any) => ({
              id: r.id,
              to: r.target_organization?.name ?? r.organization?.name ?? "",
              status: r.status,
              created: r.created_at?.slice(0, 10) ?? "",
            })),
            ["id", "to", "status", "created"],
          );
        });
        return;
      }
      if (sub === "suggestions") {
        const data = await c.get<any>("/v0.3/partner-suggestions");
        const items = Array.isArray(data) ? data : data.items ?? [];
        output(args, data, () =>
          table(
            items.map((s: any) => ({
              name: s.name,
              domain: s.domain ?? s.clearbit_domain ?? "",
              source: s.suggestion_source ?? s.source ?? "",
            })),
            ["name", "domain", "source"],
          ),
        );
        return;
      }
      if (sub === "overlap-counts") {
        const data = await c.get<any>("/v0.1/partners/global/overlap-counts");
        output(args, data);
        return;
      }
      if (sub === "favorites") {
        const data = await c.get<any>("/v0.1/users/favorites");
        output(args, data);
        return;
      }
      throw new Error(`Unknown partners subcommand: ${sub}`);
    },
  },
  {
    name: "partner-tags",
    describe: "List partner tags defined for the organization",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.1/partner-tags");
      const items = Array.isArray(data) ? data : data.items ?? [];
      output(args, data, () =>
        table(
          items.map((t: any) => ({ id: t.id, name: t.name, color: t.color ?? "" })),
          ["id", "name", "color"],
        ),
      );
    },
  },
  {
    name: "partner-populations",
    describe: "List partner-shared populations",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.1/partner-populations");
      output(args, data);
    },
  },
  {
    name: "populations",
    args: "list [--inactive] | stats | record-stats",
    describe: "Population data",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "list";
      if (sub === "list") {
        const inactive = boolFlag(args, "inactive");
        const data = await c.get<any>("/v0.3/populations", {
          only_inactive: inactive ? "true" : "false",
        });
        const items = Array.isArray(data) ? data : data.items ?? [];
        output(args, data, () =>
          table(
            items.map((p: any) => ({
              id: p.id,
              name: p.name,
              standard: p.standard_type ?? "",
              source: p.source_id ?? "",
              records: p.record_count ?? "",
            })),
            ["id", "name", "standard", "source", "records"],
          ),
        );
        return;
      }
      if (sub === "stats") {
        const data = await c.get<any>("/alpha/population-stats");
        output(args, data);
        return;
      }
      if (sub === "record-stats") {
        const data = await c.get<any>("/v0.1/population-record-stats");
        output(args, data);
        return;
      }
      throw new Error(`Unknown populations subcommand: ${sub}`);
    },
  },
  {
    name: "lists",
    args: "list",
    describe: "User-saved lists/reports",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.2/lists");
      const items = Array.isArray(data) ? data : data.lists ?? data.items ?? [];
      output(args, data, () =>
        table(
          items.map((l: any) => ({
            id: l.id,
            name: l.name,
            type: l.type ?? l.list_type ?? "",
            updated: l.updated_at?.slice(0, 10) ?? "",
          })),
          ["id", "name", "type", "updated"],
        ),
      );
    },
  },
  {
    name: "report-folders",
    describe: "List report folders",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.1/report-folders");
      output(args, data);
    },
  },
  {
    name: "reports",
    describe: "List reports / saved Account-Mapping views",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.4/reports");
      const items = data.items ?? data;
      output(args, data, () =>
        table(
          (items as any[]).map((r: any) => ({
            id: r.id,
            name: r.name,
            folder: r.folder_id ?? "",
            created: r.created_at?.slice(0, 10) ?? "",
            updated: r.updated_at?.slice(0, 10) ?? "",
          })),
          ["id", "name", "folder", "created", "updated"],
        ),
      );
    },
  },
  {
    name: "sources",
    args: "list [--include-deleted] | get <id>",
    describe: "Data sources",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "list";
      if (sub === "list") {
        const includeDeleted = boolFlag(args, "include-deleted");
        const data = await c.get<any>("/v0.1/sources", {
          include_deleted: includeDeleted ? "true" : "false",
        });
        const items = Array.isArray(data) ? data : data.items ?? [];
        output(args, data, () =>
          table(
            items.map((s: any) => ({
              id: s.id,
              type: s.source_type ?? s.type ?? "",
              name: s.display_name ?? s.name ?? "",
              status: s.status ?? "",
            })),
            ["id", "type", "name", "status"],
          ),
        );
        return;
      }
      if (sub === "get") {
        const id = args.positional[2];
        if (!id) throw new Error("sources get <id>");
        const data = await c.get<any>(`/v0.1/sources/${id}`);
        output(args, data);
        return;
      }
      throw new Error(`Unknown sources subcommand: ${sub}`);
    },
  },
  {
    name: "feeds",
    args: "list | get <id>",
    describe: "Data feeds (sync jobs)",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "list";
      if (sub === "list") {
        const data = await c.get<any>("/v0.1/feeds");
        output(args, data);
        return;
      }
      if (sub === "get") {
        const id = args.positional[2];
        if (!id) throw new Error("feeds get <id>");
        const data = await c.get<any>(`/v0.1/feeds/${id}`);
        output(args, data);
        return;
      }
      throw new Error(`Unknown feeds subcommand: ${sub}`);
    },
  },
  {
    name: "connections",
    describe: "Data warehouse / partner connections",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.1/connections");
      output(args, data);
    },
  },
  {
    name: "integrations",
    args: "list | slack | partnerstack | tray",
    describe: "Connected integrations",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "list";
      if (sub === "list") {
        const data = await c.get<any>("/v0.1/integrations");
        output(args, data);
        return;
      }
      if (sub === "slack") {
        const data = await c.get<any>("/v0.1/slack-app/slack-integration");
        output(args, data);
        return;
      }
      if (sub === "partnerstack") {
        const data = await c.get<any>("/v0.1/partnerstack/integration");
        output(args, data);
        return;
      }
      if (sub === "tray") {
        const data = await c.get<any>("/v0.1/tray-integrations");
        output(args, data);
        return;
      }
      throw new Error(`Unknown integrations subcommand: ${sub}`);
    },
  },
  {
    name: "share-requests",
    args: "inbound | outbound",
    describe: "Sharing requests inbound/outbound",
    run: async (c, _me, args) => {
      const sub = args.positional[1];
      if (!sub) throw new Error("share-requests inbound|outbound");
      const path =
        sub === "inbound" ? "/v0.1/inbound-share-requests" : "/v0.1/outbound-share-requests";
      const data = await c.get<any>(path);
      output(args, data);
    },
  },
  {
    name: "share-rules",
    args: "incoming | outgoing",
    describe: "Sharing rules",
    run: async (c, _me, args) => {
      const sub = args.positional[1];
      if (!sub) throw new Error("share-rules incoming|outgoing");
      const path =
        sub === "outgoing" ? "/v0.1/outgoing-sharing-rules" : "/v0.1/incoming-sharing-rules";
      const data = await c.get<any>(path);
      output(args, data);
    },
  },
  {
    name: "data-shares",
    args: "incoming | outgoing",
    describe: "Active data shares",
    run: async (c, _me, args) => {
      const sub = args.positional[1];
      if (!sub) throw new Error("data-shares incoming|outgoing");
      const path =
        sub === "outgoing" ? "/v0.1/outgoing-data-shares" : "/v0.1/incoming-data-shares";
      const data = await c.get<any>(path);
      output(args, data);
    },
  },
  {
    name: "share-presets",
    describe: "Data share presets",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.1/data-share-presets");
      output(args, data);
    },
  },
  {
    name: "proposals",
    args: "sent | received",
    describe: "Partnership proposals",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "sent";
      const path = sub === "received" ? "/v0.1/proposals-received" : "/v0.1/proposals";
      const data = await c.get<any>(path);
      output(args, data);
    },
  },
  {
    name: "notifications",
    args: "list | settings",
    describe: "Notifications",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "list";
      if (sub === "list") {
        const data = await c.get<any>("/v0.1/notifications");
        const items = Array.isArray(data) ? data : data.items ?? [];
        output(args, data, () =>
          table(
            items.map((n: any) => ({
              id: n.id,
              type: n.type ?? n.event_type ?? "",
              read: n.read,
              created: n.created_at?.slice(0, 19).replace("T", " ") ?? "",
              text: (n.body ?? n.message ?? n.title ?? "").slice(0, 60),
            })),
            ["id", "type", "read", "created", "text"],
          ),
        );
        return;
      }
      if (sub === "settings") {
        const data = await c.get<any>("/v0.1/notification-settings");
        output(args, data);
        return;
      }
      throw new Error(`Unknown notifications subcommand: ${sub}`);
    },
  },
  {
    name: "seat-requests",
    describe: "Seat requests for the org",
    run: async (c, _me, args) => {
      const data = await c.get<any>("/v0.1/seat-requests");
      output(args, data);
    },
  },
  {
    name: "file-uploads",
    args: "list | tables",
    describe: "Uploaded files / tables",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "list";
      if (sub === "list") {
        const data = await c.get<any>("/v0.2/file-uploads");
        output(args, data);
        return;
      }
      if (sub === "tables") {
        const data = await c.get<any>("/v0.3/file-uploads/tables");
        output(args, data);
        return;
      }
      throw new Error(`Unknown file-uploads subcommand: ${sub}`);
    },
  },
  {
    name: "discover",
    args: "search <query>",
    describe: "Discover organizations on Crossbeam",
    run: async (c, _me, args) => {
      const sub = args.positional[1];
      const q = args.positional[2];
      if (sub !== "search" || !q) throw new Error("discover search <query>");
      const data = await c.get<any>("/v0.1/discoverable-org-search", { query: q });
      output(args, data);
    },
  },
  {
    name: "clearbit",
    args: "<query>",
    describe: "Clearbit autocomplete (company lookup)",
    run: async (c, _me, args) => {
      const q = args.positional[1];
      if (!q) throw new Error("clearbit <query>");
      const data = await c.get<any>("/v0.1/clearbit-autocomplete", { query: q });
      output(args, data);
    },
  },
  {
    name: "mop",
    args: "organizations | partnerships",
    describe: "Manager-of-Partners (MoP) data",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "organizations";
      const path =
        sub === "partnerships" ? "/v0.1/mop/partnerships" : "/v0.1/mop/organizations";
      const data = await c.get<any>(path);
      output(args, data);
    },
  },
  {
    name: "overlap",
    args: "<partner-id>",
    describe: "Overlap accounts for a specific partner",
    run: async (c, _me, args) => {
      const id = args.positional[1];
      if (!id) throw new Error("overlap <partner-id>");
      const data = await c.post<any>(`/v0.4/overlaps/${id}`, {});
      output(args, data);
    },
  },
  {
    name: "overlap-total",
    args: "<partner-id> [population-id...]",
    describe: "Get total overlap count with a partner",
    run: async (c, _me, args) => {
      const id = args.positional[1];
      if (!id) throw new Error("overlap-total <partner-id> [population-id...]");
      const populationIds = args.positional.slice(2).map((s) => Number(s)).filter(Boolean);
      const data = await c.post<any>("/v0.3/overlaps/total", {
        partner_organization_id: Number(id),
        population_ids: populationIds,
      });
      output(args, data);
    },
  },
  {
    name: "attribution",
    args: "opportunities | metrics | won-pipeline",
    describe: "Attribution / influenced pipeline",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "opportunities";
      const map: Record<string, string> = {
        opportunities: "/v0.1/attribution/opportunities",
        metrics: "/v0.1/attribution/opportunities/metrics",
        "won-pipeline": "/v0.1/attribution/won-pipeline/opportunities",
      };
      const path = map[sub];
      if (!path) throw new Error(`Unknown attribution subcommand: ${sub}`);
      const data = await c.get<any>(path);
      output(args, data);
    },
  },
  {
    name: "search",
    args: "<query>",
    describe: "Global Crossbeam search (companies, people, populations, partners)",
    run: async (c, _me, args) => {
      const q = args.positional[1];
      if (!q) throw new Error("search <query>");
      const data = await c.get<any>("/v0.1/search", { search: q });
      output(args, data);
    },
  },
  {
    name: "raw",
    args: "<METHOD> <path> [json-body]",
    describe: "Call any API endpoint manually (for poking around)",
    run: async (c, _me, args) => {
      const method = (args.positional[1] || "").toUpperCase();
      const path = args.positional[2];
      const bodyStr = args.positional[3];
      if (!method || !path) throw new Error("raw <METHOD> <path> [json-body]");
      if (method === "GET") {
        const data = await c.get<any>(path);
        output(args, data);
        return;
      }
      if (method === "POST") {
        const body = bodyStr ? JSON.parse(bodyStr) : undefined;
        const data = await c.post<any>(path, body);
        output(args, data);
        return;
      }
      throw new Error(`Unsupported method: ${method}`);
    },
  },
  {
    name: "logout",
    describe: "Clear cached session (~/.crossbeam/session.json)",
    run: async () => {
      // handled in main() before auth, this is just for help display
    },
  },
  {
    name: "endpoints",
    describe: "List all known API endpoints (offline)",
    run: async (_c, _me, args) => {
      output(
        args,
        commands.map((c) => ({ command: c.name, args: c.args ?? "", description: c.describe })),
        () =>
          table(
            commands.map((c) => ({
              command: c.name + (c.args ? " " + c.args : ""),
              description: c.describe,
            })),
            ["command", "description"],
          ),
      );
    },
  },
];

// ─────────────────────────── help ───────────────────────────

function printHelp() {
  console.log(`crossbeam — Bun CLI for the Crossbeam internal API

Usage:
  bun main.ts <command> [subcommand] [args] [options]

Auth (one of):
  --user <email>          Crossbeam username  (env: CROSSBEAM_USER)
  --pass <password>       Crossbeam password  (env: CROSSBEAM_PASS)
  --org <id>              Override organization id (defaults to first authorized org)

Output:
  --json                  Print raw JSON instead of a pretty table

Caching:
  Sessions are cached at ~/.crossbeam/session.json (mode 0600) for 6 hours.
  --no-cache              Don't read or write the session cache
  --fresh-login           Force a fresh Auth0 login this run
  logout                  Forget cached session(s)

Commands:`);
  const nameWidth = Math.max(...commands.map((c) => c.name.length));
  for (const c of commands) {
    console.log(`  ${c.name.padEnd(nameWidth)}    ${c.describe}`);
    if (c.args) console.log(`  ${" ".repeat(nameWidth)}      args: ${c.args}`);
  }
  console.log(`
Examples:
  bun main.ts me --user you@x.com --pass secret
  bun main.ts partners list --json
  bun main.ts partners users 1094
  bun main.ts populations list --inactive
  bun main.ts clearbit "Snowflake"
  bun main.ts raw GET /v0.1/team
`);
}

// ─────────────────────────── prompt fallback ───────────────────────────

async function promptHidden(question: string): Promise<string> {
  const isTTY = (stdin as any).isTTY === true;
  if (!isTTY) {
    // Read one line from stdin (piped input)
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0]?.trim() ?? "";
  }
  return new Promise<string>((resolve) => {
    stdout.write(question);
    (stdin as any).setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          (stdin as any).setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          resolve(buf);
          return;
        } else if (ch === "") {
          process.exit(130);
        } else if (ch === "" || ch === "\b") {
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
}

// ─────────────────────────── main ───────────────────────────

async function main() {
  const args = parseArgs(argv.slice(2));

  if (boolFlag(args, "help", "h") || args.positional.length === 0) {
    printHelp();
    return;
  }
  const cmdName = args.positional[0];
  const cmd = commands.find((c) => c.name === cmdName);
  if (!cmd) {
    console.error(`Unknown command: ${cmdName}`);
    printHelp();
    process.exit(1);
  }

  if (cmd.name === "endpoints") {
    await cmd.run(null as any, null, args);
    return;
  }

  const username = flag(args, "user", "u", "username") ?? env.CROSSBEAM_USER;
  let password = flag(args, "pass", "p", "password") ?? env.CROSSBEAM_PASS;
  const orgFlag = flag(args, "org");
  const noCache = boolFlag(args, "no-cache");
  const forceLogin = boolFlag(args, "fresh-login");

  if (cmd.name === "logout") {
    if (username) clearSession(username);
    else clearSession();
    console.log("Cleared session cache.");
    return;
  }

  if (!username) {
    console.error("Missing --user (or CROSSBEAM_USER env)");
    process.exit(1);
  }

  const jar = new CookieJar();
  let me: any | undefined;
  let orgId: string | undefined;

  if (!noCache && !forceLogin) {
    const cached = loadSession(username);
    if (cached) {
      jar.cookies = cached.cookies;
      orgId = cached.orgId;
      me = cached.me;
    }
  }

  if (!jar.cookies.length || !orgId) {
    if (!password) {
      password = await promptHidden("Password: ");
      if (!password) {
        console.error("Missing --pass (or CROSSBEAM_PASS env)");
        process.exit(1);
      }
    }
    const ticket = await coAuthenticate(jar, username, password);
    await exchangeLoginTicket(jar, ticket);
    const tmp = new Client(jar, "0");
    me = await tmp.get<any>("/v0.1/users/web-me");
    const defaultOrg = me.authorizations?.[0]?.organization;
    orgId = orgFlag ?? (defaultOrg?.id != null ? String(defaultOrg.id) : "");
    if (!orgId) throw new Error("Could not determine organization id from web-me");
    if (!noCache) saveSession(username, jar, orgId, me);
  } else if (orgFlag) {
    orgId = orgFlag;
  }

  const client = new Client(jar, orgId);

  try {
    await cmd.run(client, me, args);
  } catch (err: any) {
    // If the cached session has expired, clear it and retry once with fresh login.
    if (
      !noCache &&
      !forceLogin &&
      typeof err?.message === "string" &&
      /401|403|Unauthorized|forbidden/i.test(err.message)
    ) {
      clearSession(username);
      console.error("Session expired — re-running with fresh login.");
      // Re-exec by recursive call with fresh-login flag.
      argv.push("--fresh-login");
      await main();
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
