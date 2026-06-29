#!/usr/bin/env node
/**
 * Crossbeam MCP server (stdio transport).
 *
 * Exposes the read methods of {@link CrossbeamClient} as MCP tools so the
 * Crossbeam internal API can be queried from Claude Desktop or any other MCP
 * client. Credentials are read from the environment:
 *
 *   CROSSBEAM_USERNAME   Crossbeam login email (required)
 *   CROSSBEAM_PASSWORD   Crossbeam password (required)
 *   CROSSBEAM_ORG        Organization id to scope requests to (optional)
 *
 * Login happens lazily on the first tool call and the session is cached under
 * ~/.crossbeam/session.json (see session.ts) just like the CLI.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CrossbeamClient } from "./client.js";
import { initTelemetry, identifyUser, trackUsage, flushTelemetry } from "./telemetry.js";

const USERNAME = process.env.CROSSBEAM_USERNAME?.trim();
const PASSWORD = process.env.CROSSBEAM_PASSWORD;
const ORG = process.env.CROSSBEAM_ORG?.trim() || undefined;

let clientPromise: Promise<CrossbeamClient> | null = null;

/** Log in once and reuse the client for the lifetime of the process. */
function getClient(): Promise<CrossbeamClient> {
  if (!USERNAME || !PASSWORD) {
    return Promise.reject(
      new Error(
        "Crossbeam credentials are not configured. Set CROSSBEAM_USERNAME and " +
          "CROSSBEAM_PASSWORD (and optionally CROSSBEAM_ORG).",
      ),
    );
  }
  if (!clientPromise) {
    clientPromise = CrossbeamClient.login({
      username: USERNAME,
      password: PASSWORD,
      org: ORG,
    }).catch((err) => {
      // Reset so a later call can retry after the user fixes credentials.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  const text =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

const server = new McpServer({
  name: "crossbeam",
  version: "0.1.1",
});

/**
 * Register a tool whose handler receives a logged-in client. Errors are caught
 * and returned as tool errors rather than crashing the server.
 */
function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  run: (client: CrossbeamClient, args: z.infer<z.ZodObject<S>>) => Promise<unknown>,
): void {
  const handler = async (args: z.infer<z.ZodObject<S>>): Promise<ToolResult> => {
    trackUsage(name, { surface: "mcp", version: "0.1.1" });
    try {
      const client = await getClient();
      return ok(await run(client, args));
    } catch (err) {
      return fail(err);
    }
  };
  // The SDK's callback generics over ZodRawShape are awkward to satisfy through
  // this thin wrapper; the runtime shape is correct.
  server.registerTool(name, { description, inputSchema }, handler as never);
}

// ─── identity / org ────────────────────────────────────────────────────
tool("get_me", "Get the current authenticated user, their organizations, and roles.", {}, (c) => c.getMe());
tool("get_team", "List members of the current Crossbeam organization.", {}, (c) => c.getTeam());
tool("get_roles", "List roles defined in the organization.", {}, (c) => c.getRoles());
tool("get_permissions", "List the current user's permissions.", {}, (c) => c.getPermissions());
tool("get_feature_flags", "List feature flags for the organization.", {}, (c) => c.getFeatureFlags());

// ─── partners ──────────────────────────────────────────────────────────
tool("list_partners", "List all partners (partner organizations) for the current org.", {}, (c) => c.listPartners());
tool(
  "get_partner",
  "Get a single partner by numeric id or uuid.",
  { partner: z.string().describe("Partner numeric id or uuid") },
  (c, a) => c.getPartner(a.partner),
);
tool(
  "get_partner_users",
  "List the users at a partner organization.",
  { partner: z.string().describe("Partner numeric id or uuid") },
  (c, a) => c.getPartnerUsers(a.partner),
);
tool(
  "get_partner_tags",
  "List tags applied to a partner.",
  { partner: z.string().describe("Partner numeric id or uuid") },
  (c, a) => c.getPartnerTags(a.partner),
);
tool("get_partner_suggestions", "Get suggested partners.", {}, (c) => c.getPartnerSuggestions());
tool("get_overlap_counts", "Get global overlap counts across all partners.", {}, (c) => c.getOverlapCounts());
tool("get_partner_favorites", "List the current user's favorite partners.", {}, (c) => c.getPartnerFavorites());
tool("list_partner_tags", "List all partner tags defined in the org.", {}, (c) => c.listPartnerTags());
tool("list_partner_populations", "List partner populations.", {}, (c) => c.listPartnerPopulations());
tool(
  "get_overlap_matrix",
  "Get the overlap matrix for a partner (v0.5 overlaps).",
  { partner: z.string().describe("Partner numeric id or uuid") },
  (c, a) => c.getOverlapMatrix(a.partner),
);

// ─── populations ────────────────────────────────────────────────────────
tool(
  "list_populations",
  "List populations for the current org.",
  { only_inactive: z.boolean().optional().describe("Only return inactive populations") },
  (c, a) => c.listPopulations({ onlyInactive: a.only_inactive }),
);
tool("get_population_stats", "Get population stats.", {}, (c) => c.getPopulationStats());
tool("get_population_record_stats", "Get per-population record counts.", {}, (c) => c.getPopulationRecordStats());

// ─── lists / reports ──────────────────────────────────────────────────────
tool("list_lists", "List saved Lists.", {}, (c) => c.listLists());
tool("list_reports", "List saved Reports.", {}, (c) => c.listReports());
tool("list_report_folders", "List report folders.", {}, (c) => c.listReportFolders());
tool(
  "get_report_data",
  "Get record-level overlap rows (the data behind a List / Account-Mapping view). All filters are optional.",
  {
    partner_ids: z.array(z.number()).optional().describe("Restrict to these partner organization ids"),
    our_population_ids: z.array(z.number()).optional(),
    partner_population_ids: z.array(z.number()).optional(),
    our_segments: z.array(z.string()).optional(),
    partner_segments: z.array(z.string()).optional(),
    type: z.enum(["overlaps", "ecosystem"]).optional().describe("Consolidated report type"),
    is_account_mapping: z.boolean().optional(),
    page: z.number().optional().describe("Page number (default 1)"),
    limit: z.number().optional().describe("Rows per page (default 50)"),
  },
  (c, a) =>
    c.getReportData(
      {
        partnerIds: a.partner_ids,
        ourPopulationIds: a.our_population_ids,
        partnerPopulationIds: a.partner_population_ids,
        ourSegments: a.our_segments,
        partnerSegments: a.partner_segments,
        type: a.type,
        isAccountMapping: a.is_account_mapping,
      },
      { page: a.page, limit: a.limit },
    ),
);
tool(
  "get_account_mapping",
  "Get account-mapping rows across every partner (ecosystem report).",
  {
    our_segments: z.array(z.string()).optional(),
    partner_segments: z.array(z.string()).optional(),
    page: z.number().optional(),
    limit: z.number().optional(),
  },
  (c, a) =>
    c.getAccountMapping(
      { ourSegments: a.our_segments, partnerSegments: a.partner_segments },
      { page: a.page, limit: a.limit },
    ),
);

// ─── sources / feeds / integrations ───────────────────────────────────────
tool(
  "list_sources",
  "List data sources.",
  { include_deleted: z.boolean().optional() },
  (c, a) => c.listSources({ includeDeleted: a.include_deleted }),
);
tool(
  "get_source",
  "Get a single source by id.",
  { id: z.string().describe("Source id") },
  (c, a) => c.getSource(a.id),
);
tool("list_feeds", "List feeds.", {}, (c) => c.listFeeds());
tool("list_connections", "List data connections.", {}, (c) => c.listConnections());
tool("list_integrations", "List integrations.", {}, (c) => c.listIntegrations());

// ─── sharing ───────────────────────────────────────────────────────────────
tool("get_pending_share_requests", "Get inbound and outbound pending share requests.", {}, (c) => c.getPendingShareRequests());
tool("get_incoming_share_rules", "List incoming sharing rules.", {}, (c) => c.getIncomingShareRules());
tool("get_outgoing_share_rules", "List outgoing sharing rules.", {}, (c) => c.getOutgoingShareRules());
tool("list_share_presets", "List data-share presets.", {}, (c) => c.listSharePresets());
tool("get_proposals_sent", "List partnership proposals sent.", {}, (c) => c.getProposalsSent());
tool("get_proposals_received", "List partnership proposals received.", {}, (c) => c.getProposalsReceived());

// ─── overlaps ────────────────────────────────────────────────────────────
tool(
  "get_overlap",
  "Get overlapping accounts with a single partner.",
  { partner_id: z.string().describe("Partner organization id") },
  (c, a) => c.getOverlap(a.partner_id),
);
tool(
  "get_overlap_total",
  "Get the total overlap count with a partner, optionally scoped to populations.",
  {
    partner_id: z.string().describe("Partner organization id"),
    population_ids: z.array(z.number()).optional(),
  },
  (c, a) => c.getOverlapTotal(a.partner_id, a.population_ids ?? []),
);

// ─── misc ────────────────────────────────────────────────────────────────
tool("list_notifications", "List notifications.", {}, (c) => c.listNotifications());
tool(
  "get_attribution",
  "Get partner attribution data.",
  { kind: z.enum(["opportunities", "metrics", "won-pipeline"]).optional() },
  (c, a) => c.getAttribution(a.kind ?? "opportunities"),
);
tool(
  "search",
  "Search Crossbeam (accounts, partners, etc.).",
  { query: z.string().describe("Search query") },
  (c, a) => c.search(a.query),
);
tool(
  "discover_orgs",
  "Search discoverable Crossbeam organizations by name.",
  { query: z.string().describe("Organization name to search for") },
  (c, a) => c.discoverOrgs(a.query),
);

// ─── escape hatch ──────────────────────────────────────────────────────────
tool(
  "get",
  "Low-level escape hatch: issue a raw authenticated GET against the Crossbeam API. " +
    "Use when no dedicated tool exists. Path must start with '/' (e.g. '/v0.2/partners').",
  {
    path: z.string().describe("API path beginning with '/', e.g. '/v0.2/partners'"),
    query: z.record(z.string(), z.string()).optional().describe("Optional query-string parameters"),
  },
  (c, a) => c.get(a.path, a.query),
);

async function main(): Promise<void> {
  initTelemetry();
  identifyUser(USERNAME);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      void flushTelemetry().finally(() => process.exit(0));
    });
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting Crossbeam MCP server:", err);
  process.exit(1);
});
