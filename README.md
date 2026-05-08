# crossbeam-cli

[![CI](https://github.com/Fan-Pier-Labs/crossbeam-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Fan-Pier-Labs/crossbeam-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/crossbeam-cli.svg)](https://www.npmjs.com/package/crossbeam-cli)
[![npm downloads](https://img.shields.io/npm/dm/crossbeam-cli.svg)](https://www.npmjs.com/package/crossbeam-cli)
[![install size](https://packagephobia.com/badge?p=crossbeam-cli)](https://packagephobia.com/result?p=crossbeam-cli)
[![TypeScript](https://img.shields.io/badge/TypeScript-included-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Bun](https://img.shields.io/badge/bun-compatible-fbf0df?logo=bun&logoColor=black)](https://bun.sh)
[![speed](https://img.shields.io/static/v1?label=speed&message=fast&color=success)](#)

CLI client for [Crossbeam](https://www.crossbeam.com). Log in with your existing Crossbeam credentials and read your partners, populations, overlaps, reports, account-mapping data, and more — from your terminal.

**Free for any Crossbeam customer.** Crossbeam normally requires upgrading to a paid tier (Connector / Supernode) to access their public API. This package uses the same endpoints the Crossbeam web app itself uses, so anyone with a Crossbeam login — including users on the free plan — can pull their own data programmatically.

**Great for AI agents.** Plug your partner ecosystem data into Claude Code, Cursor, or any agent framework. See the [AI agent prompt](#ai-agent-prompt) below.

> ⚠️ This package talks to Crossbeam's internal `api.crossbeam.com` endpoints (the same ones the Crossbeam web app uses). It is not affiliated with or endorsed by Crossbeam, Inc. Use at your own risk.

## Installation

```sh
npm install --save crossbeam-cli
# or globally for the CLI binary:
npm install --global crossbeam-cli
```

The CLI binary is named `crossbeam`.

## How it works

`crossbeam-cli` is a thin wrapper around Crossbeam's private HTTP API — the same endpoints the Crossbeam web app calls when you're signed in. When you run a command:

1. **You provide your own Crossbeam username and password** (via flag, env var, or interactive prompt).
2. The package logs in to `auth.crossbeam.com`, gets a session cookie, and stores it at `~/.crossbeam/session.json` (mode `0600`, valid for 6 hours).
3. Every API call goes directly to `api.crossbeam.com` over HTTPS with that cookie.

**Your credentials and your data never leave your machine.** This package has:

- No backend, proxy, relay, or "phone home."
- No telemetry, no analytics, no error reporting.
- No third-party HTTP libraries — just Node's built-in `fetch`.
- No remote configuration or auto-updates.

The full source is in [`src/`](./src) — read it, audit it, fork it.

## AI agent prompt

`crossbeam-cli` is built for AI coding agents (Claude Code, Cursor, Cline, Aider, Codex, etc). Every command emits JSON with `--json`, and the `crossbeam raw <METHOD> <path>` escape hatch lets an agent hit any endpoint it discovers.

Drop the prompt below into Claude Code / Cursor / your agent of choice to give it everything it needs:

````md
You have access to a CLI called `crossbeam` (npm package: `crossbeam-cli`) that
reads data from the user's Crossbeam account. Use it to answer questions about
their partners, ecosystem, populations, account-mapping records, and overlaps.

Setup (do this once per shell):
- Install: `npm install -g crossbeam-cli`
- Auth: ask the user for their Crossbeam email + password and export them as
  CROSSBEAM_USER and CROSSBEAM_PASS. Sessions are cached for 6 hours at
  ~/.crossbeam/session.json, so you only need credentials on the first run.

Always pass `--json` so output is machine-readable. Pipe through `jq` to keep
context small. Examples:

  crossbeam me --json | jq '.user.email, .authorizations[0].organization.name'
  crossbeam partners list --json | jq '.items[] | {id, name, domain}'
  crossbeam populations list --json | jq '.items[] | {id, name, record_count}'
  crossbeam overlap <partner-id> --json | jq '.items | length'
  crossbeam account-mapping --our-segment customer --limit 100 --json
  crossbeam report-data --partner 1234,5678 --type ecosystem --limit 200 --json
  crossbeam raw GET /v0.1/team --json    # any internal endpoint

Discovery:
- `crossbeam endpoints --json` lists every command and its arguments.
- `crossbeam --help` prints full CLI help.

Programmatic use (TypeScript / Node):

  import { CrossbeamClient } from "crossbeam-cli";
  const c = await CrossbeamClient.login({
    username: process.env.CROSSBEAM_USER!,
    password: process.env.CROSSBEAM_PASS!,
  });
  const partners = await c.listPartners();
  const overlap  = await c.getOverlap(partners[0].id);

Important rules:
- Never print or log the user's password.
- Prefer the cached session — do NOT pass `--fresh-login` unless you see a
  401/403 error.
- For large result sets, use `--limit` and `--page` for pagination.
- If the user asks for data the existing commands don't expose, use
  `crossbeam raw GET <path>` to call internal endpoints directly.
````

## CLI usage

```sh
crossbeam <command> [subcommand] [args] [options]
```

### Authentication

Provide credentials by flag. First run logs in; subsequent runs reuse the cached session (see [How it works](#how-it-works)).

```sh
crossbeam me --user you@example.com --pass 'your-password'

# or via env:
export CROSSBEAM_USER=you@example.com
export CROSSBEAM_PASS='your-password'
crossbeam partners list
```

If `--pass` and `CROSSBEAM_PASS` are both missing, the CLI prompts for the password silently on a TTY.

Flags:

| Flag | Description |
| --- | --- |
| `--user`, `-u` | Crossbeam username |
| `--pass`, `-p` | Crossbeam password |
| `--org <id>` | Override organization id (defaults to your first authorized org) |
| `--json` | Print raw JSON instead of a pretty table |
| `--no-cache` | Don't read or write the session cache |
| `--fresh-login` | Force a fresh login this run (skip the cached session) |
| `logout` | Forget cached session(s) |

### Commands

Run `crossbeam endpoints` for the full list. Highlights:

```sh
crossbeam me                                     # current user + org
crossbeam team                                   # list org members
crossbeam partners list                          # all partners with overlap counts
crossbeam partners get <id|uuid>
crossbeam partners users <id|uuid>
crossbeam partners overlap-matrix <id|uuid>
crossbeam populations list [--inactive]
crossbeam reports                                # saved Account-Mapping views
crossbeam lists                                  # user-saved lists
crossbeam overlap <partner-id>
crossbeam report-data --partner 1234 --type ecosystem --limit 100
crossbeam account-mapping --our-segment customer --limit 100
crossbeam search "<query>"
crossbeam clearbit "<query>"
crossbeam raw GET /v0.1/team                     # call any endpoint
```

---

## Programmatic usage

```ts
import { CrossbeamClient } from "crossbeam-cli";

const client = await CrossbeamClient.login({
  username: process.env.CROSSBEAM_USER!,
  password: process.env.CROSSBEAM_PASS!,
  // org: "12345",       // optional: override organization id
  // useCache: true,      // default: true. Reads/writes ~/.crossbeam/session.json
});

const me = await client.getMe();
console.log(`Logged in as ${me.user?.email}`);

const partners = await client.listPartners();
for (const p of partners) {
  console.log(`${p.id}\t${p.name}\t${p.domain ?? ""}`);
}

const overlap = await client.getOverlap(partners[0].id);
console.log(`Overlap with ${partners[0].name}: ${overlap.items?.length ?? 0} rows`);
```

### `CrossbeamClient.login(options)`

```ts
type LoginOptions = {
  username: string;
  password: string;
  org?: string;          // override organization id
  useCache?: boolean;    // default true; caches at ~/.crossbeam/session.json
  forceFreshLogin?: boolean;
};
```

### Selected client methods

All methods return parsed JSON. See `src/client.ts` for the full surface.

| Area | Methods |
| --- | --- |
| Identity | `getMe()`, `getTeam()`, `getRoles()`, `getPermissions()`, `getFeatureFlags()` |
| Partners | `listPartners()`, `getPartner(id)`, `getPartnerUsers(id)`, `getPartnerTags(id)`, `getPartnerTeamAccess(id)`, `getPartnerSuggestions()`, `getOverlapCounts()`, `getPartnerFavorites()`, `getPendingShareRequests()` |
| Populations | `listPopulations({ onlyInactive? })`, `getPopulationStats()`, `getPopulationRecordStats()`, `listPartnerPopulations()`, `listPartnerTags()` |
| Reports | `listLists()`, `listReports()`, `listReportFolders()`, `getReportData(body, { page, limit })`, `getAccountMapping(opts)`, `getPartnerSources(body)` |
| Sources | `listSources({ includeDeleted? })`, `getSource(id)`, `listFeeds()`, `getFeed(id)`, `listConnections()` |
| Sharing | `getInboundShareRequests()`, `getOutboundShareRequests()`, `getIncomingShareRules()`, `getOutgoingShareRules()`, `getIncomingDataShares()`, `getOutgoingDataShares()`, `listSharePresets()` |
| Overlaps | `getOverlap(partnerId)`, `getOverlapTotal(partnerId, populationIds?)`, `getOverlapMatrix(partnerId)` |
| Misc | `discoverOrgs(query)`, `clearbitAutocomplete(query)`, `search(query)`, `listIntegrations()`, `listNotifications()`, `getNotificationSettings()`, `getAttribution(kind)`, `listFileUploads()`, `listFileUploadTables()`, `getMopOrganizations()`, `getMopPartnerships()` |
| Escape hatch | `get<T>(path, query?)`, `post<T>(path, body?)` |

### Session caching

`CrossbeamClient.login()` caches cookies at `~/.crossbeam/session.json` (mode `0600`) for 6 hours, keyed by username. Set `useCache: false` to skip, or `forceFreshLogin: true` to bypass on this call only. To clear everything programmatically:

```ts
import { clearSession } from "crossbeam-cli";
clearSession();              // clear all
clearSession("you@x.com");   // clear one user
```

## Development

```sh
npm install
npm run build
node dist/cli.js me --user you@x.com --pass '...'
npm pack --dry-run         # see what would ship
```

## Disclaimer

Unofficial client. Crossbeam may change or block these endpoints at any time. Use at your own risk.

## License

Source-available under the [Fan Pier Labs Source-Available License](./LICENSE). You may view the source and use the Software for personal, non-commercial, and educational purposes only. For commercial licensing, contact ryan@fanpierlabs.com.
