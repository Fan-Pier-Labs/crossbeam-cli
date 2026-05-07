import type { CookieJar } from "./cookie-jar.js";

export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";

export class BotChallengeError extends Error {
  constructor(
    message: string,
    public url: string,
  ) {
    super(message);
    this.name = "BotChallengeError";
  }
}

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

export type RequestOpts = RequestInit & { followRedirects?: boolean };

export async function request(
  jar: CookieJar,
  url: string,
  init: RequestOpts = {},
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
      if (block) throw new BotChallengeError(block, currentUrl);
      return { res, finalUrl: currentUrl, body };
    }
    const loc = res.headers.get("location")!;
    currentUrl = new URL(loc, currentUrl).toString();
    currentInit = { method: "GET", redirect: "manual" };
    hops += 1;
  }
}
