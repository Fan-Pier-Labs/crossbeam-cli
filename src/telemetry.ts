/**
 * Lightweight usage monitoring via PostHog.
 *
 * The only purpose of this module is to answer "who is using the tool" — it
 * sends the operator's own login email and the name of the command/MCP tool
 * they invoked. It deliberately never forwards Crossbeam API responses, command
 * arguments, passwords, session cookies, or anything else that could be
 * customer data.
 *
 * Monitoring must never affect CLI/MCP behaviour: every call is wrapped so that
 * a failure is swallowed silently. Because the CLI is a short-lived process,
 * call `flushTelemetry()` before exit so queued events are actually delivered.
 *
 * Opt out by setting CROSSBEAM_NO_TELEMETRY=1 or DO_NOT_TRACK=1.
 */
import { PostHog } from "posthog-node";

// PostHog project API keys are write-only (ingest-only) and safe to ship in
// client code, exactly like an analytics key in a web bundle. Override either
// value with an env var if you fork this tool.
const POSTHOG_KEY =
  process.env.CROSSBEAM_POSTHOG_KEY ||
  "phc_tpwZrAKRT2uRr6Bf4hjMvRGEAECKpuhxjEhvozvTeUPT";
const POSTHOG_HOST =
  process.env.CROSSBEAM_POSTHOG_HOST || "https://us.i.posthog.com";

let client: PostHog | null = null;
let distinctId = "anonymous";

function disabled(): boolean {
  const off = (v: string | undefined) =>
    v === "1" || v === "true" || v === "yes";
  return off(process.env.CROSSBEAM_NO_TELEMETRY) || off(process.env.DO_NOT_TRACK);
}

/** Initialise PostHog once. Safe to call multiple times. */
export function initTelemetry(): void {
  if (client || disabled() || !POSTHOG_KEY) return;
  try {
    client = new PostHog(POSTHOG_KEY, {
      host: POSTHOG_HOST,
      // Send promptly — this is a CLI, not a long-lived web session.
      flushAt: 1,
      flushInterval: 0,
    });
  } catch {
    /* monitoring must never break the tool */
    client = null;
  }
}

/**
 * Associate subsequent events with the operator's email. No other PII or
 * customer data is sent — just the email used to log in to Crossbeam.
 */
export function identifyUser(email: string | undefined): void {
  if (!client || !email) return;
  distinctId = email;
  try {
    client.identify({ distinctId: email, properties: { email } });
  } catch {
    /* ignore */
  }
}

/**
 * Record that a command / MCP tool was used. Only the command name (plus the
 * surface and tool version) is sent — never its arguments, which may reference
 * partners, populations, or accounts.
 */
export function trackUsage(
  command: string,
  props: { surface: "cli" | "mcp"; version?: string } = { surface: "cli" },
): void {
  if (!client) return;
  try {
    client.capture({
      distinctId,
      event: "command_run",
      properties: { command, ...props },
    });
  } catch {
    /* ignore */
  }
}

/** Flush queued events. Call before the process exits so nothing is lost. */
export async function flushTelemetry(): Promise<void> {
  if (!client) return;
  try {
    await client.flush();
  } catch {
    /* ignore */
  }
}
