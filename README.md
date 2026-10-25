# @pipeworx/fed-nic

Institution search, corporate ownership hierarchy, and merger/acquisition history
for US banks and bank/financial holding companies, sourced from the Federal
Reserve System's National Information Center (NIC, ffiec.gov/npw).

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1879+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `nic_search_institutions(query, status?, state?, limit?)` — find institutions
  by name. Returns RSSD ID, FDIC certificate, LEI, institution type, location,
  active/closed status. RANKED via `nic_search_ranked` (migration 212): exact
  match, then prefix match on an active FDIC-cert institution, then any
  prefix match, then other active FDIC-cert institutions, then the rest —
  not alphabetical (see "Coverage / accuracy notes").
- `nic_get_institution(rssd_id? | fdic_cert? | lei?)` — full NIC record for
  one institution, looked up by exactly one of RSSD ID, FDIC certificate
  number (chains to the `fdic` pack), or LEI (chains to the `gleif` pack).
- `nic_get_hierarchy(rssd_id, direction?, limit?, offset?)` — `direction="up"`
  (default) walks the ownership chain to its top holder ("which holding
  company owns this bank?"); `direction="down"` lists entities owned by the
  given RSSD ID, paged via `limit`/`offset`, with `total_subsidiary_count`
  computed as a DISTINCT count in SQL (migration 212's `nic_descendant_count`)
  — see "Coverage / accuracy notes" for why the previous count was wrong.
- `nic_get_history(rssd_id)` — mergers, acquisitions, failures and
  transformations the institution was party to ("what predecessor
  institutions merged into this bank?").

## Auth

Keyless — no caller-facing credential. The gateway supplies the store
credential automatically.

## Data sources

- <https://www.ffiec.gov/npw/FinancialReport/DataDownload> — NIC's public
  bulk CSV files: Attributes-Active, Attributes-Closed, Relationships,
  Transformations. US federal government data; no reuse restriction found on
  the download page or the NPW site (public-domain by default for federal
  data — see "Reuse terms" below).

## Why this pack reads from a mirror, not a live proxy

`www.ffiec.gov` sits behind a Cloudflare Managed Challenge
(`cf-mitigated: challenge`) that returns a 403 "CAPTCHA Error" page to every
non-browser HTTP client — confirmed on both:

- the interactive NPW pages the live site itself uses per-query
  (`Institution/Profile/{rssd_id}`, POST `Institution/BuildTier`, POST
  `Institution/LoadHistory`), and
- the bulk CSV download endpoints (`FinancialReport/Return*ZipFileCSV`)
  themselves,

with a full Chrome header set (User-Agent, Accept, Accept-Language,
`sec-ch-ua*`). A Cloudflare Worker's `fetch()` hits the identical wall — there
is no header or cookie fix, it is a JS/TLS-fingerprint challenge, not a UA
check — so there is no live per-query route this gateway can reach. Per
Bruce's 2026-09-23 ruling ("build a copy when live doesn't serve"), this pack
is instead backed by a periodically-refreshed copy of NIC's own public bulk
files (migration `supabase/migrations/209_fed_nic.sql`), refreshed by
`scripts/ingest-fed-nic.mjs` — see that script's header for exactly why the
refresh cannot be a Worker cron and what running it manually requires. It is
registered in `workers/data-pipeline/src/datasets/fed-nic.ts` for freshness
visibility only (no scheduled run), the same pattern
`workers/data-pipeline/src/datasets/ffiec.ts` uses for `cdr.ffiec.gov`.

## Reuse terms

NIC's Data Download page (`/npw/FinancialReport/DataDownload`, "About the
Files") documents the file contents and how to use them but states no
copyright, license, or reuse restriction. The NIC Data Dictionary PDF (linked
from that page) sits behind the same Cloudflare wall as the rest of
`ffiec.gov`, so it could not be checked directly. This is data produced by a
US federal agency (the Federal Reserve System) about a supervisory/regulatory
function; US federal government works are public domain by default (17 U.S.C.
§ 105) absent a specific notice to the contrary, and none was found.

## Coverage / accuracy notes

- **Branches are not ingested.** NIC's Attributes-Branches file (~174k rows,
  95MB) is out of scope for the hierarchy/history use case this pack ships;
  the NIC UI's own "Branches" tab covers it and this could be added later.
- **`nic_get_hierarchy` is our own computed closure**, not a copy of NIC's own
  tiering algorithm. It recursively walks currently-active
  (`dt_end IS NULL`) edges in NIC's public Relationships file. Spot-checked
  live on 2026-09-23 against JPMorgan Chase Bank, N.A. (RSSD 852218):
  `direction="up"` matched the live UI exactly (top holder JPMorgan Chase &
  Co., RSSD 1039502); `direction="down"` from the top tier returned 877
  subsidiaries by our closure versus 1,025 on the live UI. The discrepancy is
  not reconstructable from the public bulk file alone (the live UI's tiering
  algorithm likely applies rules — e.g. non-equity control bases, branch/agent
  relationships — that the public Relationships export does not fully carry).
  Treat the down-direction count as a lower bound computed from NIC's own
  published data, not NIC's official figure.
  **Migration 212 fixes a separate bug in how that 877 reached the tool.**
  The Relationships closure emits one row per ownership PATH, not one per
  distinct subsidiary — a subsidiary reachable through more than one parent
  chain appears more than once (1,672 raw rows for JPMorgan vs. 877 distinct
  RSSD ids). The tool originally called the raw closure RPC directly and used
  the returned row count as `total_subsidiary_count`; PostgREST caps a single
  RPC response at 1,000 rows, so the count silently landed on 1,000 instead of
  877 whenever the raw closure exceeded that cap. `nic_descendant_count` (a
  single-row scalar, immune to the row cap) and `nic_descendants_page`
  (deduped + paged in SQL) fix this — see `src/index.ts`'s top-of-file
  comment and `supabase/migrations/212_fed_nic_hierarchy_and_search_fix.sql`.
- **`nic_search_institutions` ranking (migration 212, `nic_search_ranked`).**
  Plain alphabetical order put same-family entities ahead of the institution
  most callers mean — e.g. query "Wells Fargo Bank" returned "WELLS FARGO
  BANK INTERNATIONAL UNLIMITED COMPANY" (an Ireland entity, no FDIC cert)
  ahead of "WELLS FARGO BANK, NATIONAL ASSOCIATION" (RSSD 451965) purely
  because `' '` sorts before `','` in ASCII. Ranking now tiers by exact
  match, then prefix-match-with-FDIC-cert, then any prefix match, then
  other cert-holding active institutions, then the rest; ties within a tier
  break on shortest `legal_name` (closest in length to the query), then
  trigram similarity.
- **`entity_type_code` labels are partial.** `ENTITY_TYPE_LABELS` in
  `src/index.ts` only carries codes verified live against the NIC UI (NAT,
  FHD, EDI, IBK, INB, DEO). Any other code is returned raw rather than
  guessed — the NIC Data Dictionary that would confirm the rest is itself
  behind the Cloudflare wall.
- **`trnsfm_cd` (transformation type) is a raw NIC code**, not a label, for
  the same reason. Code 50 is corroborated against a live example (First
  Republic Bank, RSSD 4114567 → JPMorgan Chase Bank N.A., RSSD 852218,
  2023-05-01, "failed and ceased to exist" on the live NIC History tab).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "fed-nic": {
      "url": "https://gateway.pipeworx.io/fed-nic/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/fed-nic/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1879+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/nic_search_institutions \
  -H 'Content-Type: application/json' \
  -d '{"query":"JPMorgan Chase Bank"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/nic_search_institutions`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "fed-nic": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-fed-nic"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-fed-nic
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Fed Nic data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
