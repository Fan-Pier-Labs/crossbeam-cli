#!/usr/bin/env node
import { stdin, stdout, env, argv } from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CrossbeamClient, type Partner } from "./client.js";
import { clearSession, loadSession } from "./session.js";
import { BotChallengeError } from "./http.js";
import { AuthError } from "./auth.js";
import { initTelemetry, identifyUser, trackUsage, flushTelemetry } from "./telemetry.js";

const PKG_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

const ATTRIBUTION =
  "Built by Ryan Hughes (Fan Pier Labs) — https://fanpierlabs.com";

// ─────────────────────────── arg parsing ───────────────────────────

type ParsedArgs = {
  positional: string[];
  flags: Record<string, string | boolean>;
};

const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "h",
  "version",
  "v",
  "no-cache",
  "fresh-login",
  "inactive",
  "include-deleted",
  "account-mapping",
  "all-partners",
]);
const VALUE_FLAGS = new Set([
  "user", "u", "username",
  "pass", "p", "password",
  "org",
  "partner", "partners",
  "our-population", "our-populations",
  "partner-population", "partner-populations",
  "our-segment", "our-segments",
  "partner-segment", "partner-segments",
  "type",
  "limit",
  "page",
  "tag", "tags",
]);

function parseArgs(args: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
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
  const cols = columns ?? Object.keys(rows[0]!);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)),
  );
  const fmt = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ");
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

function splitNums(s: string | undefined): number[] {
  return (s ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n);
}
function splitStrs(s: string | undefined): string[] {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// ─────────────────────────── command handlers ───────────────────────────

type Cmd = {
  name: string;
  args?: string;
  describe: string;
  run: (client: CrossbeamClient, me: unknown, args: ParsedArgs) => Promise<void>;
};

const commands: Cmd[] = [
  {
    name: "me",
    describe: "Show the current user, organization and roles",
    run: async (c, me, args) => {
      const data: any = me ?? (await c.getMe());
      output(args, data, () => {
        const auth = data.authorizations?.[0];
        const org = auth?.organization;
        console.log(`User:         ${data.user?.first_name ?? ""} ${data.user?.last_name ?? ""}  <${data.user?.email}>`);
        console.log(`User ID:      ${data.user?.id}`);
        console.log(`Organization: ${org?.name}  (id ${org?.id}, domain ${org?.domain ?? "-"})`);
        console.log(`Role:         ${auth?.role?.name ?? "-"}`);
      });
    },
  },
  {
    name: "team",
    describe: "List members of your organization",
    run: async (c, _me, args) => {
      const data: any = await c.getTeam();
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
      const data: any = await c.getRoles();
      const items = Array.isArray(data) ? data : (data.items ?? []);
      output(args, data, () =>
        table(
          items.map((r: any) => ({ id: r.id, name: r.name, type: r.role_type, seat: r.seat_type })),
          ["id", "name", "type", "seat"],
        ),
      );
    },
  },
  {
    name: "permissions",
    describe: "List permissions for current user",
    run: async (c, _me, args) => output(args, await c.getPermissions()),
  },
  {
    name: "feature-flags",
    describe: "List feature flags for the organization",
    run: async (c, _me, args) => output(args, await c.getFeatureFlags()),
  },
  {
    name: "partners",
    args: "list | get <id> | users <id> | tags <id> | team-access <id> | pending | suggestions | overlap-counts | overlap-matrix <id> | favorites",
    describe: "Partner-related queries",
    run: async (c, _me, args) => {
      const sub = args.positional[1];
      if (!sub || sub === "list") {
        const [items, counts, partnerPops] = await Promise.all([
          c.listPartners(),
          c.getOverlapCounts().catch(() => null) as Promise<any>,
          c.listPartnerPopulations().catch(() => null) as Promise<any>,
        ]);
        const byPartner: Record<number, any> = {};
        for (const r of counts?.overlap_usage?.by_partner ?? [])
          byPartner[r.partner_organization_id] = r;
        const popsByOrg: Record<number, number> = {};
        for (const p of partnerPops?.items ?? partnerPops ?? [])
          popsByOrg[p.organization_id] = (popsByOrg[p.organization_id] ?? 0) + 1;
        output(args, { items }, () =>
          table(
            items.map((p: Partner) => ({
              id: p.id,
              uuid: p.uuid ?? "",
              name: p.name,
              domain: p.domain ?? p.clearbit_domain ?? "",
              partnered: p.partnership_created_at?.slice(0, 10) ?? "",
              shared_pops: popsByOrg[p.id] ?? 0,
              overlaps: byPartner[p.id]?.total_overlap_count ?? "",
              partner_score: p.metrics?.partner_score ?? "",
            })),
            ["id", "uuid", "name", "domain", "partnered", "shared_pops", "overlaps", "partner_score"],
          ),
        );
        return;
      }
      if (sub === "get") {
        const id = args.positional[2];
        if (!id) throw new Error("partners get <id|uuid>");
        output(args, await c.getPartner(id));
        return;
      }
      if (sub === "users") {
        const id = args.positional[2];
        if (!id) throw new Error("partners users <id|uuid>");
        const data: any = await c.getPartnerUsers(id);
        const items = Array.isArray(data) ? data : (data.items ?? data.users ?? []);
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
        output(args, await c.getPartnerTags(id));
        return;
      }
      if (sub === "team-access") {
        const id = args.positional[2];
        if (!id) throw new Error("partners team-access <id|uuid>");
        output(args, await c.getPartnerTeamAccess(id));
        return;
      }
      if (sub === "pending") {
        const { inbound, outbound } = await c.getPendingShareRequests();
        output(args, { inbound, outbound }, () => {
          const inItems = Array.isArray(inbound) ? inbound : ((inbound as any)?.items ?? []);
          const outItems = Array.isArray(outbound) ? outbound : ((outbound as any)?.items ?? []);
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
        const data: any = await c.getPartnerSuggestions();
        const items = Array.isArray(data) ? data : (data.items ?? []);
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
        output(args, await c.getOverlapCounts());
        return;
      }
      if (sub === "overlap-matrix") {
        const id = args.positional[2];
        if (!id) throw new Error("partners overlap-matrix <id|uuid>");
        const data: any = await c.getOverlapMatrix(id);
        output(args, data, () => {
          const rows = data.items?.segment_to_segment ?? [];
          table(
            rows.map((r: any) => ({
              our_segment: r.our_segment,
              partner_segment: r.partner_segment,
              num_matches: r.num_matches,
              open_deals: r.open_deals_count ?? "",
              report_allowed: r.is_report_allowed,
            })),
            ["our_segment", "partner_segment", "num_matches", "open_deals", "report_allowed"],
          );
        });
        return;
      }
      if (sub === "favorites") {
        output(args, await c.getPartnerFavorites());
        return;
      }
      throw new Error(`Unknown partners subcommand: ${sub}`);
    },
  },
  {
    name: "partner-tags",
    describe: "List partner tags defined for the organization",
    run: async (c, _me, args) => {
      const data: any = await c.listPartnerTags();
      const items = Array.isArray(data) ? data : (data.items ?? []);
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
    run: async (c, _me, args) => output(args, await c.listPartnerPopulations()),
  },
  {
    name: "populations",
    args: "list [--inactive] | stats | record-stats",
    describe: "Population data",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "list";
      if (sub === "list") {
        const data: any = await c.listPopulations({ onlyInactive: boolFlag(args, "inactive") });
        const items = Array.isArray(data) ? data : (data.items ?? []);
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
        output(args, await c.getPopulationStats());
        return;
      }
      if (sub === "record-stats") {
        output(args, await c.getPopulationRecordStats());
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
      const data: any = await c.listLists();
      const items = Array.isArray(data) ? data : (data.lists ?? data.items ?? []);
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
    run: async (c, _me, args) => output(args, await c.listReportFolders()),
  },
  {
    name: "reports",
    describe: "List reports / saved Account-Mapping views",
    run: async (c, _me, args) => {
      const data: any = await c.listReports();
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
        const data: any = await c.listSources({ includeDeleted: boolFlag(args, "include-deleted") });
        const items = Array.isArray(data) ? data : (data.items ?? []);
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
        output(args, await c.getSource(id));
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
        output(args, await c.listFeeds());
        return;
      }
      if (sub === "get") {
        const id = args.positional[2];
        if (!id) throw new Error("feeds get <id>");
        output(args, await c.getFeed(id));
        return;
      }
      throw new Error(`Unknown feeds subcommand: ${sub}`);
    },
  },
  {
    name: "connections",
    describe: "Data warehouse / partner connections",
    run: async (c, _me, args) => output(args, await c.listConnections()),
  },
  {
    name: "integrations",
    args: "list | slack | partnerstack | tray",
    describe: "Connected integrations",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "list";
      if (sub === "list") {
        output(args, await c.listIntegrations());
        return;
      }
      if (sub === "slack") {
        output(args, await c.getSlackIntegration());
        return;
      }
      if (sub === "partnerstack") {
        output(args, await c.getPartnerstackIntegration());
        return;
      }
      if (sub === "tray") {
        output(args, await c.getTrayIntegrations());
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
      const data =
        sub === "inbound"
          ? await c.getInboundShareRequests()
          : await c.getOutboundShareRequests();
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
      const data =
        sub === "outgoing"
          ? await c.getOutgoingShareRules()
          : await c.getIncomingShareRules();
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
      const data =
        sub === "outgoing"
          ? await c.getOutgoingDataShares()
          : await c.getIncomingDataShares();
      output(args, data);
    },
  },
  {
    name: "share-presets",
    describe: "Data share presets",
    run: async (c, _me, args) => output(args, await c.listSharePresets()),
  },
  {
    name: "proposals",
    args: "sent | received",
    describe: "Partnership proposals",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "sent";
      const data = sub === "received" ? await c.getProposalsReceived() : await c.getProposalsSent();
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
        const data: any = await c.listNotifications();
        const items = Array.isArray(data) ? data : (data.items ?? []);
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
        output(args, await c.getNotificationSettings());
        return;
      }
      throw new Error(`Unknown notifications subcommand: ${sub}`);
    },
  },
  {
    name: "seat-requests",
    describe: "Seat requests for the org",
    run: async (c, _me, args) => output(args, await c.getSeatRequests()),
  },
  {
    name: "file-uploads",
    args: "list | tables",
    describe: "Uploaded files / tables",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "list";
      if (sub === "list") {
        output(args, await c.listFileUploads());
        return;
      }
      if (sub === "tables") {
        output(args, await c.listFileUploadTables());
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
      output(args, await c.discoverOrgs(q));
    },
  },
  {
    name: "clearbit",
    args: "<query>",
    describe: "Clearbit autocomplete (company lookup)",
    run: async (c, _me, args) => {
      const q = args.positional[1];
      if (!q) throw new Error("clearbit <query>");
      output(args, await c.clearbitAutocomplete(q));
    },
  },
  {
    name: "mop",
    args: "organizations | partnerships",
    describe: "Manager-of-Partners (MoP) data",
    run: async (c, _me, args) => {
      const sub = args.positional[1] ?? "organizations";
      const data =
        sub === "partnerships" ? await c.getMopPartnerships() : await c.getMopOrganizations();
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
      output(args, await c.getOverlap(id));
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
      output(args, await c.getOverlapTotal(id, populationIds));
    },
  },
  {
    name: "report-data",
    args: "[--partner id,id] [--our-population id,id] [--partner-population id,id] [--our-segment seg,seg] [--partner-segment seg,seg] [--type overlaps|ecosystem] [--account-mapping] [--limit N] [--page N]",
    describe: "Record-level overlap rows (the data behind a List / report view)",
    run: async (c, _me, args) => {
      const data = await c.getReportData(
        {
          partnerIds: splitNums(flag(args, "partner", "partners")),
          ourPopulationIds: splitNums(flag(args, "our-population", "our-populations")),
          partnerPopulationIds: splitNums(flag(args, "partner-population", "partner-populations")),
          ourSegments: splitStrs(flag(args, "our-segment", "our-segments")),
          partnerSegments: splitStrs(flag(args, "partner-segment", "partner-segments")),
          type: (flag(args, "type") || "overlaps") as "overlaps" | "ecosystem",
          isAccountMapping: boolFlag(args, "account-mapping"),
        },
        {
          page: Number(flag(args, "page") ?? 1),
          limit: Number(flag(args, "limit") ?? 50),
        },
      );
      output(args, data, () => {
        const items = data.items ?? [];
        table(
          items.map((r: any) => ({
            name: r.record_name ?? "",
            website: r._xb_website ?? "",
            our_pops: (r.population_ids ?? []).join(","),
            partner_pops: (r.partner_population_ids ?? []).join(","),
            partner_orgs: (r.partner_org_ids ?? []).join(","),
            overlap_time: r.overlap_time?.slice(0, 10) ?? "",
          })),
          ["name", "website", "our_pops", "partner_pops", "partner_orgs", "overlap_time"],
        );
        if (data.pagination)
          console.log(
            `\nPage ${data.pagination.page}/${data.pagination.last_page} (${data.pagination.total_count} total)`,
          );
      });
    },
  },
  {
    name: "account-mapping",
    args: "[--our-segment seg,seg] [--partner-segment seg,seg] [--limit N] [--page N]",
    describe: "Account-mapping records across all partners (shortcut for report-data)",
    run: async (c, _me, args) => {
      const data = await c.getAccountMapping(
        {
          ourSegments: splitStrs(flag(args, "our-segment", "our-segments")),
          partnerSegments: splitStrs(flag(args, "partner-segment", "partner-segments")),
        },
        {
          page: Number(flag(args, "page") ?? 1),
          limit: Number(flag(args, "limit") ?? 50),
        },
      );
      output(args, data, () => {
        const items = data.items ?? [];
        table(
          items.map((r: any) => ({
            name: r.record_name ?? "",
            website: r._xb_website ?? "",
            partner_orgs: (r.partner_org_ids ?? []).join(","),
            our_pops: (r.population_ids ?? []).join(","),
            partner_pops: (r.partner_population_ids ?? []).join(","),
          })),
          ["name", "website", "partner_orgs", "our_pops", "partner_pops"],
        );
        if (data.pagination)
          console.log(
            `\nPage ${data.pagination.page}/${data.pagination.last_page} (${data.pagination.total_count} total)`,
          );
      });
    },
  },
  {
    name: "partner-sources",
    args: "--partner id,id [--our-population id,id | --our-segment seg,seg] [--partner-population id,id | --partner-segment seg,seg] [--type overlaps|ecosystem]",
    describe: "Partner data sources / fields available for a report (column metadata)",
    run: async (c, _me, args) => {
      const partnerIds = splitNums(flag(args, "partner", "partners"));
      if (!partnerIds.length) throw new Error("partner-sources requires --partner id[,id...]");
      const data: any = await c.getPartnerSources({
        partnerIds,
        ourSegments: splitStrs(flag(args, "our-segment", "our-segments")),
        partnerSegments: splitStrs(flag(args, "partner-segment", "partner-segments")),
        ourPopulationIds: splitNums(flag(args, "our-population", "our-populations")),
        partnerPopulationIds: splitNums(flag(args, "partner-population", "partner-populations")),
        type: (flag(args, "type") || "overlaps") as "overlaps" | "ecosystem",
      });
      output(args, data, () => {
        const orgs = Array.isArray(data) ? data : [data];
        for (const o of orgs) {
          console.log(`\nPartner org ${o.id}:`);
          for (const s of o.sources ?? []) {
            console.log(`  Source ${s.id} (${s.schema}.${s.table}, mdm=${s.mdm_type})`);
            table(
              (s.fields ?? []).map((f: any) => ({
                id: f.id,
                column: f.column,
                display: f.display_name,
                type: f.data_type,
                sortable: f.is_sortable,
                filterable: f.is_filterable,
              })),
              ["id", "column", "display", "type", "sortable", "filterable"],
            );
          }
        }
      });
    },
  },
  {
    name: "attribution",
    args: "opportunities | metrics | won-pipeline",
    describe: "Attribution / influenced pipeline",
    run: async (c, _me, args) => {
      const sub = (args.positional[1] ?? "opportunities") as
        | "opportunities"
        | "metrics"
        | "won-pipeline";
      if (!["opportunities", "metrics", "won-pipeline"].includes(sub))
        throw new Error(`Unknown attribution subcommand: ${sub}`);
      output(args, await c.getAttribution(sub));
    },
  },
  {
    name: "search",
    args: "<query>",
    describe: "Global Crossbeam search (companies, people, populations, partners)",
    run: async (c, _me, args) => {
      const q = args.positional[1];
      if (!q) throw new Error("search <query>");
      output(args, await c.search(q));
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
        output(args, await c.get(path));
        return;
      }
      if (method === "POST") {
        const body = bodyStr ? JSON.parse(bodyStr) : undefined;
        output(args, await c.post(path, body));
        return;
      }
      throw new Error(`Unsupported method: ${method}`);
    },
  },
  {
    name: "logout",
    describe: "Clear cached session (~/.crossbeam/session.json)",
    run: async () => {
      // handled in main() before auth
    },
  },
  {
    name: "endpoints",
    describe: "List all known commands (offline)",
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

function printVersion() {
  console.log(`crossbeam-cli ${PKG_VERSION}`);
  console.log(ATTRIBUTION);
  console.log("https://github.com/Fan-Pier-Labs/crossbeam-cli");
}

function printHelp() {
  console.log(`crossbeam-cli ${PKG_VERSION} — CLI client for Crossbeam
${ATTRIBUTION}

Usage:
  crossbeam <command> [subcommand] [args] [options]

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
  crossbeam me --user you@x.com --pass secret
  crossbeam partners list --json
  crossbeam partners users 1094
  crossbeam populations list --inactive
  crossbeam clearbit "Snowflake"
  crossbeam raw GET /v0.1/team

${ATTRIBUTION}
`);
}

// ─────────────────────────── prompt fallback ───────────────────────────

async function promptHidden(question: string): Promise<string> {
  const isTTY = (stdin as any).isTTY === true;
  if (!isTTY) {
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
        } else if (ch === "") {
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

// ─────────────────────────── main ───────────────────────────

async function main() {
  const args = parseArgs(argv.slice(2));

  initTelemetry();

  if (boolFlag(args, "version", "v")) {
    printVersion();
    return;
  }
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

  trackUsage(cmd.name, { surface: "cli", version: PKG_VERSION });

  if (cmd.name === "endpoints") {
    await cmd.run(null as any, null, args);
    return;
  }

  const username = flag(args, "user", "u", "username") ?? env.CROSSBEAM_USER;
  identifyUser(username);
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

  // If a usable cache exists, skip the password prompt entirely.
  const haveUsableCache =
    !noCache && !forceLogin && !!loadSession(username);

  if (!password && !haveUsableCache) {
    password = await promptHidden("Password: ");
    if (!password) {
      console.error("Missing --pass (or CROSSBEAM_PASS env)");
      process.exit(1);
    }
  }

  const client = await CrossbeamClient.login({
    username,
    password: password ?? "",
    org: orgFlag,
    useCache: !noCache,
    forceFreshLogin: forceLogin,
  });
  await runCommand(cmd, client, client.me, args, username, noCache, forceLogin);
}

async function runCommand(
  cmd: Cmd,
  client: CrossbeamClient,
  me: unknown,
  args: ParsedArgs,
  username: string,
  noCache: boolean,
  forceLogin: boolean,
) {
  try {
    await cmd.run(client, me, args);
  } catch (err: unknown) {
    if (err instanceof BotChallengeError) {
      console.error(`\nStopping: ${err.message}`);
      console.error("Bot management software detected. Aborting.");
      process.exit(2);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (
      !noCache &&
      !forceLogin &&
      /401|403|Unauthorized|forbidden/i.test(msg)
    ) {
      clearSession(username);
      console.error("Session expired — re-running with fresh login.");
      argv.push("--fresh-login");
      await main();
      return;
    }
    throw err;
  }
}

main()
  .then(() => flushTelemetry())
  .catch(async (err: unknown) => {
    await flushTelemetry();
    if (err instanceof BotChallengeError) {
      console.error(`\nStopping: ${err.message}`);
      console.error("Bot management software detected. Aborting.");
      process.exit(2);
    }
    if (err instanceof AuthError) {
      console.error(`Auth error: ${err.message}`);
      process.exit(1);
    }
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
