import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cookie } from "./cookie-jar.js";

export const SESSION_DIR = join(homedir(), ".crossbeam");
export const SESSION_FILE = join(SESSION_DIR, "session.json");
export const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

export type CachedSession = {
  cookies: Cookie[];
  orgId?: string;
  me?: unknown;
  ts: number;
};

export function loadSession(user: string): CachedSession | null {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    const raw = readFileSync(SESSION_FILE, "utf8");
    const obj = JSON.parse(raw) as Record<string, CachedSession>;
    const entry = obj[user];
    if (!entry) return null;
    if (Date.now() - entry.ts > SESSION_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

export function saveSession(
  user: string,
  cookies: Cookie[],
  orgId: string,
  me: unknown,
): void {
  let obj: Record<string, CachedSession> = {};
  if (existsSync(SESSION_FILE)) {
    try {
      obj = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    } catch {
      obj = {};
    }
  }
  obj[user] = { cookies, orgId, me, ts: Date.now() };
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2));
  try {
    chmodSync(SESSION_FILE, 0o600);
  } catch {
    /* best-effort */
  }
}

export function clearSession(user?: string): void {
  if (!existsSync(SESSION_FILE)) return;
  if (!user) {
    writeFileSync(SESSION_FILE, "{}");
    return;
  }
  try {
    const obj = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    delete obj[user];
    writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2));
  } catch {
    /* ignore */
  }
}
