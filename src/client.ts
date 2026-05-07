import { CookieJar } from "./cookie-jar.js";
import { request } from "./http.js";
import { coAuthenticate, exchangeLoginTicket, API_BASE, APP_ORIGIN } from "./auth.js";
import { loadSession, saveSession } from "./session.js";

export type LoginOptions = {
  username: string;
  password: string;
  org?: string;
  useCache?: boolean;
  forceFreshLogin?: boolean;
};

export type ReportFilters = {
  partnerIds?: number[];
  ourPopulationIds?: number[];
  partnerPopulationIds?: number[];
  ourSegments?: string[];
  partnerSegments?: string[];
  type?: "overlaps" | "ecosystem";
  isAccountMapping?: boolean;
};

export type Pagination = {
  page?: number;
  limit?: number;
};

/**
 * Crossbeam API client. Use `CrossbeamClient.login(...)` to construct.
 */
export class CrossbeamClient {
  constructor(
    public jar: CookieJar,
    public orgId: string,
    public me: unknown = null,
  ) {}

  /**
   * Authenticate against Crossbeam (Auth0 cross-origin flow) and return a ready
   * client. By default, caches the resulting session at ~/.crossbeam/session.json
   * for 6 hours, keyed by username.
   */
  static async login(opts: LoginOptions): Promise<CrossbeamClient> {
    const useCache = opts.useCache !== false;
    const forceFresh = opts.forceFreshLogin === true;

    const jar = new CookieJar();
    let me: unknown = null;
    let orgId: string | undefined;

    if (useCache && !forceFresh) {
      const cached = loadSession(opts.username);
      if (cached) {
        jar.cookies = cached.cookies;
        orgId = cached.orgId;
        me = cached.me ?? null;
      }
    }

    if (!jar.cookies.length || !orgId) {
      const ticket = await coAuthenticate(jar, opts.username, opts.password);
      await exchangeLoginTicket(jar, ticket);
      const tmp = new CrossbeamClient(jar, "0");
      me = await tmp.get<MeResponse>("/v0.1/users/web-me");
      const defaultOrg = (me as MeResponse).authorizations?.[0]?.organization;
      orgId = opts.org ?? (defaultOrg?.id != null ? String(defaultOrg.id) : "");
      if (!orgId) throw new Error("Could not determine organization id from web-me");
      if (useCache) saveSession(opts.username, jar.cookies, orgId, me);
    } else if (opts.org) {
      orgId = opts.org;
    }

    return new CrossbeamClient(jar, orgId, me);
  }

  // ─── low-level escape hatches ──────────────────────────────────────

  async get<T = unknown>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
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

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
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

  // ─── identity / org ────────────────────────────────────────────────

  async getMe(): Promise<MeResponse> {
    if (this.me) return this.me as MeResponse;
    const me = await this.get<MeResponse>("/v0.1/users/web-me");
    this.me = me;
    return me;
  }

  getTeam() {
    return this.get<unknown>("/v0.1/team");
  }
  getRoles() {
    return this.get<unknown>("/v0.1/roles");
  }
  getPermissions() {
    return this.get<unknown>("/v0.1/permissions");
  }
  getFeatureFlags() {
    return this.get<unknown>("/v0.1/feature-flags");
  }
  getSeatRequests() {
    return this.get<unknown>("/v0.1/seat-requests");
  }

  // ─── partners ──────────────────────────────────────────────────────

  async listPartners(): Promise<Partner[]> {
    const data = await this.get<{ items?: Partner[] } | Partner[]>("/v0.2/partners");
    return Array.isArray(data) ? data : (data.items ?? []);
  }

  async resolvePartnerUuid(idOrUuid: string | number): Promise<string> {
    const s = String(idOrUuid);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(s)) return s;
    const partners = await this.listPartners();
    const p = partners.find((x) => String(x.id) === s || x.uuid === s);
    if (!p?.uuid) throw new Error(`No partner found with id/uuid ${s}`);
    return p.uuid;
  }

  async getPartner(idOrUuid: string | number) {
    const uuid = await this.resolvePartnerUuid(idOrUuid);
    return this.get<unknown>(`/v0.1/partners/${uuid}`);
  }

  async getPartnerUsers(idOrUuid: string | number) {
    const uuid = await this.resolvePartnerUuid(idOrUuid);
    return this.get<unknown>(`/v0.1/partners/${uuid}/users`);
  }

  async getPartnerTags(idOrUuid: string | number) {
    const uuid = await this.resolvePartnerUuid(idOrUuid);
    return this.get<unknown>(`/v0.1/partners/${uuid}/tags`);
  }

  async getPartnerTeamAccess(idOrUuid: string | number) {
    const uuid = await this.resolvePartnerUuid(idOrUuid);
    return this.get<unknown>(`/v0.1/partners/${uuid}/team-access`);
  }

  async getPendingShareRequests() {
    const [inbound, outbound] = await Promise.all([
      this.get<unknown>("/v0.1/inbound-share-requests"),
      this.get<unknown>("/v0.1/outbound-share-requests"),
    ]);
    return { inbound, outbound };
  }

  getPartnerSuggestions() {
    return this.get<unknown>("/v0.3/partner-suggestions");
  }
  getOverlapCounts() {
    return this.get<unknown>("/v0.1/partners/global/overlap-counts");
  }
  getPartnerFavorites() {
    return this.get<unknown>("/v0.1/users/favorites");
  }
  listPartnerTags() {
    return this.get<unknown>("/v0.1/partner-tags");
  }
  listPartnerPopulations() {
    return this.get<unknown>("/v0.1/partner-populations");
  }

  async getOverlapMatrix(idOrUuid: string | number) {
    const partners = await this.listPartners();
    const s = String(idOrUuid);
    const p = partners.find((x) => String(x.id) === s || x.uuid === s);
    if (!p) throw new Error(`No partner found with id/uuid ${s}`);
    return this.post<unknown>(`/v0.5/overlaps/${p.id}`, {});
  }

  // ─── populations ───────────────────────────────────────────────────

  listPopulations(opts: { onlyInactive?: boolean } = {}) {
    return this.get<unknown>("/v0.3/populations", {
      only_inactive: opts.onlyInactive ? "true" : "false",
    });
  }
  getPopulationStats() {
    return this.get<unknown>("/alpha/population-stats");
  }
  getPopulationRecordStats() {
    return this.get<unknown>("/v0.1/population-record-stats");
  }

  // ─── lists / reports / report-data ─────────────────────────────────

  listLists() {
    return this.get<unknown>("/v0.2/lists");
  }
  listReports() {
    return this.get<unknown>("/v0.4/reports");
  }
  listReportFolders() {
    return this.get<unknown>("/v0.1/report-folders");
  }

  /**
   * Record-level overlap rows — the data behind a List or Account-Mapping view.
   */
  getReportData(filters: ReportFilters = {}, page: Pagination = {}) {
    const body = buildReportDataBody(filters);
    const p = page.page ?? 1;
    const l = page.limit ?? 50;
    return this.post<ReportDataResponse>(`/v0.5/report-data?page=${p}&limit=${l}`, body);
  }

  /**
   * Convenience wrapper around `getReportData` that targets every partner with
   * `is_account_mapping: true` and `consolidated_report_type: "ecosystem"`.
   */
  async getAccountMapping(
    opts: { ourSegments?: string[]; partnerSegments?: string[] } = {},
    page: Pagination = {},
  ) {
    const partners = await this.listPartners();
    const partnerIds = partners.map((p) => p.id);
    return this.getReportData(
      {
        partnerIds,
        ourSegments: opts.ourSegments,
        partnerSegments: opts.partnerSegments,
        type: "ecosystem",
        isAccountMapping: true,
      },
      page,
    );
  }

  /**
   * Column metadata / partner data sources for a given report scope.
   */
  getPartnerSources(filters: ReportFilters & { partnerIds: number[] }) {
    const body = buildReportDataBody(filters);
    return this.post<unknown>("/v0.2/reports/partner-sources", body);
  }

  // ─── sources / feeds / connections / integrations ──────────────────

  listSources(opts: { includeDeleted?: boolean } = {}) {
    return this.get<unknown>("/v0.1/sources", {
      include_deleted: opts.includeDeleted ? "true" : "false",
    });
  }
  getSource(id: string | number) {
    return this.get<unknown>(`/v0.1/sources/${id}`);
  }
  listFeeds() {
    return this.get<unknown>("/v0.1/feeds");
  }
  getFeed(id: string | number) {
    return this.get<unknown>(`/v0.1/feeds/${id}`);
  }
  listConnections() {
    return this.get<unknown>("/v0.1/connections");
  }
  listIntegrations() {
    return this.get<unknown>("/v0.1/integrations");
  }
  getSlackIntegration() {
    return this.get<unknown>("/v0.1/slack-app/slack-integration");
  }
  getPartnerstackIntegration() {
    return this.get<unknown>("/v0.1/partnerstack/integration");
  }
  getTrayIntegrations() {
    return this.get<unknown>("/v0.1/tray-integrations");
  }

  // ─── sharing ───────────────────────────────────────────────────────

  getInboundShareRequests() {
    return this.get<unknown>("/v0.1/inbound-share-requests");
  }
  getOutboundShareRequests() {
    return this.get<unknown>("/v0.1/outbound-share-requests");
  }
  getIncomingShareRules() {
    return this.get<unknown>("/v0.1/incoming-sharing-rules");
  }
  getOutgoingShareRules() {
    return this.get<unknown>("/v0.1/outgoing-sharing-rules");
  }
  getIncomingDataShares() {
    return this.get<unknown>("/v0.1/incoming-data-shares");
  }
  getOutgoingDataShares() {
    return this.get<unknown>("/v0.1/outgoing-data-shares");
  }
  listSharePresets() {
    return this.get<unknown>("/v0.1/data-share-presets");
  }
  getProposalsSent() {
    return this.get<unknown>("/v0.1/proposals");
  }
  getProposalsReceived() {
    return this.get<unknown>("/v0.1/proposals-received");
  }

  // ─── overlaps ──────────────────────────────────────────────────────

  /** Overlap accounts with a single partner. */
  getOverlap(partnerId: string | number) {
    return this.post<unknown>(`/v0.4/overlaps/${partnerId}`, {});
  }

  getOverlapTotal(partnerId: string | number, populationIds: number[] = []) {
    return this.post<unknown>("/v0.3/overlaps/total", {
      partner_organization_id: Number(partnerId),
      population_ids: populationIds,
    });
  }

  // ─── notifications / attribution / misc ────────────────────────────

  listNotifications() {
    return this.get<unknown>("/v0.1/notifications");
  }
  getNotificationSettings() {
    return this.get<unknown>("/v0.1/notification-settings");
  }
  getAttribution(kind: "opportunities" | "metrics" | "won-pipeline" = "opportunities") {
    const map = {
      opportunities: "/v0.1/attribution/opportunities",
      metrics: "/v0.1/attribution/opportunities/metrics",
      "won-pipeline": "/v0.1/attribution/won-pipeline/opportunities",
    } as const;
    return this.get<unknown>(map[kind]);
  }
  listFileUploads() {
    return this.get<unknown>("/v0.2/file-uploads");
  }
  listFileUploadTables() {
    return this.get<unknown>("/v0.3/file-uploads/tables");
  }
  discoverOrgs(query: string) {
    return this.get<unknown>("/v0.1/discoverable-org-search", { query });
  }
  clearbitAutocomplete(query: string) {
    return this.get<unknown>("/v0.1/clearbit-autocomplete", { query });
  }
  search(query: string) {
    return this.get<unknown>("/v0.1/search", { search: query });
  }
  getMopOrganizations() {
    return this.get<unknown>("/v0.1/mop/organizations");
  }
  getMopPartnerships() {
    return this.get<unknown>("/v0.1/mop/partnerships");
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

function buildReportDataBody(f: ReportFilters): Record<string, unknown> {
  const ourItems: Array<Record<string, unknown>> = [];
  if ((f.ourSegments?.length ?? 0) || (f.ourPopulationIds?.length ?? 0)) {
    const segs = f.ourSegments?.length ? f.ourSegments : [undefined];
    for (const seg of segs)
      ourItems.push({
        ...(seg ? { segment: seg } : {}),
        ...(f.ourPopulationIds?.length ? { population_ids: f.ourPopulationIds } : {}),
      });
  }
  const partnerItems: Array<Record<string, unknown>> = [];
  if (
    (f.partnerSegments?.length ?? 0) ||
    (f.partnerPopulationIds?.length ?? 0) ||
    (f.partnerIds?.length ?? 0)
  ) {
    const segs = f.partnerSegments?.length ? f.partnerSegments : [undefined];
    const oids = f.partnerIds?.length ? f.partnerIds : [undefined];
    for (const seg of segs)
      for (const oid of oids)
        partnerItems.push({
          ...(seg ? { segment: seg } : {}),
          ...(oid !== undefined ? { organization_id: oid } : {}),
          ...(f.partnerPopulationIds?.length
            ? { population_ids: f.partnerPopulationIds }
            : {}),
        });
  }
  return {
    consolidated_report_type: f.type ?? "overlaps",
    ...(f.partnerIds?.length ? { partner_organization_ids: f.partnerIds } : {}),
    ...(ourItems.length ? { our_segment_filters: { operator: "OR", items: ourItems } } : {}),
    ...(partnerItems.length
      ? { partner_segment_filters: { operator: "OR", items: partnerItems } }
      : {}),
    ...(f.isAccountMapping ? { is_account_mapping: true } : {}),
  };
}

// ─── public types (loose, mirrors observed responses) ─────────────────

export type Partner = {
  id: number;
  uuid?: string;
  name: string;
  domain?: string;
  clearbit_domain?: string;
  partnership_created_at?: string;
  metrics?: { partner_score?: number };
  [k: string]: unknown;
};

export type MeOrganization = {
  id: number;
  name?: string;
  domain?: string;
  [k: string]: unknown;
};

export type MeAuthorization = {
  organization?: MeOrganization;
  role?: { name?: string };
  [k: string]: unknown;
};

export type MeResponse = {
  user?: { id?: number; first_name?: string; last_name?: string; email?: string };
  authorizations?: MeAuthorization[];
  [k: string]: unknown;
};

export type ReportDataResponse = {
  items?: Array<Record<string, unknown>>;
  pagination?: { page: number; last_page: number; total_count: number };
  [k: string]: unknown;
};
