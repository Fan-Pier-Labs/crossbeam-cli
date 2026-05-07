export type Cookie = { name: string; value: string; domain: string; path: string };

export class CookieJar {
  cookies: Cookie[] = [];

  setFromResponse(res: Response, reqUrl: string): void {
    const reqHost = new URL(reqUrl).hostname;
    const headers = res.headers as unknown as { getSetCookie?: () => string[] };
    const setCookies = headers.getSetCookie
      ? headers.getSetCookie()
      : (() => {
          const raw = res.headers.get("set-cookie");
          return raw ? [raw] : [];
        })();
    for (const sc of setCookies) this.set(sc, reqHost);
  }

  private set(setCookie: string, reqHost: string): void {
    const parts = setCookie.split(";").map((p) => p.trim());
    const [nameValue, ...attrs] = parts;
    if (!nameValue) return;
    const eq = nameValue.indexOf("=");
    if (eq < 0) return;
    const name = nameValue.slice(0, eq);
    const value = nameValue.slice(eq + 1);
    let domain = reqHost;
    let path = "/";
    for (const a of attrs) {
      const [k, v] = a.split("=").map((s) => s?.trim());
      const lk = k?.toLowerCase();
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
