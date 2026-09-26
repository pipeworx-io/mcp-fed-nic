interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Federal Reserve National Information Center (NIC, ffiec.gov/npw)
 *
 * Institution search, corporate/ownership hierarchy, and merger/acquisition
 * history for US banks and bank/financial holding companies, sourced from
 * the Federal Reserve System's own public repository of bank structure data.
 * Keys: RSSD ID (NIC's own identifier), legal name, FDIC certificate number,
 * and LEI — the same RSSD ID and FDIC cert chain to the `fdic` pack
 * (fdic_get_institution) and the `ffiec-call-reports` pack (idrssd) for
 * deposits/financials on the same institution.
 *
 * hosting-claims-ok: this pack reads a periodically-refreshed copy of NIC's
 * own public bulk data files (Attributes-Active/Closed, Relationships,
 * Transformations from https://www.ffiec.gov/npw/FinancialReport/DataDownload).
 * NIC's live site sits behind a Cloudflare Managed Challenge that 403s every
 * non-browser client, including a Worker's fetch() — there is no live
 * per-query route this gateway can reach — so a periodic copy is the only
 * way to serve this data; see supabase/migrations/209_fed_nic.sql and
 * scripts/ingest-fed-nic.mjs for the refresh mechanics and the reuse-terms
 * check (US federal data, public domain).
 *
 * COVERAGE NOTE ON HIERARCHY: nic_get_hierarchy computes ancestor/descendant
 * chains by walking NIC's own Relationships file (a recursive closure over
 * currently-active ownership/control edges). This is NOT guaranteed to
 * produce byte-identical results to NIC's own web UI "Organization Hierarchy"
 * tiering algorithm, which may apply additional business rules not present
 * in the public bulk file. Spot-checked against the live UI on 2026-09-23
 * for JPMorgan Chase Bank, N.A. (RSSD 852218): top holder matched exactly
 * (JPMorgan Chase & Co., RSSD 1039502); our computed DISTINCT subsidiary
 * count (877) differs from the live UI's count (1,025) for reasons not fully
 * reconstructable from the public file alone (likely relationship rows or
 * bases the UI includes beyond the closure available in the bulk export).
 * Treat the down-direction count as "at least this many, via active ownership
 * edges in NIC's own published data" rather than NIC's official figure.
 *
 * total_subsidiary_count is computed by supabase/migrations/212's
 * nic_descendant_count RPC — a single-row scalar over COUNT(DISTINCT
 * rssd_id), so it is never subject to PostgREST's 1,000-row response cap.
 * An earlier version counted the rows returned by nic_descendants (209)
 * directly, which emits one row PER OWNERSHIP PATH (a subsidiary reachable
 * through more than one parent chain appears more than once) — for JPMorgan
 * that closure is 1,672 raw rows, so the row count silently landed on
 * PostgREST's 1,000-row cap rather than the real ~877 distinct figure.
 * nic_descendants_page dedupes (keeping the minimum-depth path per id) and
 * pages server-side, so the returned page is never a truncated slice either.
 */


const UA = 'pipeworx-mcp-fed-nic/1.0 (+https://pipeworx.io)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'Federal Reserve NIC data store');
}

interface SupabaseConfig {
  url: string;
  key: string;
}

async function pg<T>(cfg: SupabaseConfig, path: string, query: string): Promise<T> {
  const url = `${cfg.url}/rest/v1/${path}?${query}`;
  const headers = { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await pwFetch(url, { headers });
    if (res.ok) return res.json() as Promise<T>;
    lastErr = await httpError(res, 'Federal Reserve NIC data store');
    if (res.status < 500) break;
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  throw lastErr ?? new Error('Federal Reserve NIC data store: query failed');
}

async function pgRpc<T>(cfg: SupabaseConfig, fn: string, params: Record<string, unknown>): Promise<T> {
  const url = `${cfg.url}/rest/v1/rpc/${fn}`;
  const res = await pwFetch(url, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw await httpError(res, 'Federal Reserve NIC data store');
  return res.json() as Promise<T>;
}

// Verified live against ffiec.gov/npw on 2026-09-23 (Institution Profile /
// Organization Hierarchy tab). Codes NOT in this map return their raw
// ENTITY_TYPE string rather than an invented label — the NIC Data Dictionary
// that would confirm the rest sits behind the same Cloudflare wall as
// everything else on ffiec.gov.
const ENTITY_TYPE_LABELS: Record<string, string> = {
  NAT: 'National Bank',
  FHD: 'Financial Holding Company - Domestic',
  EDI: 'Edge Corporation - Investment',
  IBK: 'International Bank of U.S. Depository - Edge or Trust Co.',
  INB: 'International Nonbank Sub of Domestic Entities',
  DEO: 'Domestic Entity Other',
};
function entityTypeLabel(code: string | null): string | null {
  if (!code) return null;
  return ENTITY_TYPE_LABELS[code] ?? code;
}

interface InstitutionRow {
  rssd_id: number;
  legal_name: string;
  short_name: string | null;
  status: 'active' | 'closed';
  entity_type_code: string | null;
  bhc_ind: boolean;
  fhc_ind: boolean;
  chtr_type_cd: number | null;
  fdic_cert: number | null;
  lei: string | null;
  city: string | null;
  state_abbr: string | null;
  country_name: string | null;
  effective_start: string | null;
  effective_end: string | null;
  data_as_of: string;
}

function presentInstitution(r: Omit<InstitutionRow, 'chtr_type_cd' | 'effective_start' | 'effective_end'>) {
  return {
    rssd_id: r.rssd_id,
    legal_name: r.legal_name.trim(),
    short_name: r.short_name?.trim() ?? null,
    status: r.status,
    institution_type: entityTypeLabel(r.entity_type_code),
    entity_type_code: r.entity_type_code,
    is_bank_holding_company: r.bhc_ind,
    is_financial_holding_company: r.fhc_ind,
    fdic_cert: r.fdic_cert,
    lei: r.lei,
    city: r.city,
    state: r.state_abbr,
    country: r.country_name?.trim() ?? null,
    data_as_of: r.data_as_of,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'nic_search_institutions',
    description:
      'Search US banks, bank holding companies, financial holding companies and their subsidiaries by name — sourced from the Federal Reserve National Information Center (NIC, ffiec.gov/npw), the Fed\'s own repository of bank structure data. Case-insensitive substring match on legal/short name, RANKED (not alphabetical): exact name match first, then a prefix match on an active institution with an FDIC certificate, then any prefix match, then other active FDIC-cert institutions, then the rest — so searching "Wells Fargo Bank" returns the main national bank ahead of same-family entities like an Ireland-domiciled affiliate with no FDIC cert. Returns RSSD ID (NIC\'s identifier), FDIC certificate number, LEI, institution type, city/state, and active/closed status — RSSD ID and FDIC cert chain to the `fdic` pack (fdic_get_institution) and `ffiec-call-reports` pack (idrssd) for financials on the same bank.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Institution name, or part of it, e.g. "JPMorgan Chase Bank"' },
        status: { type: 'string', description: 'Filter: "active" | "closed" | "any" (default "active")' },
        state: { type: 'string', description: 'Optional 2-letter US state abbreviation filter, e.g. "OH"' },
        limit: { type: 'number', description: '1-50, default 20' },
      },
      required: ['query'],
    },
  },
  {
    name: 'nic_get_institution',
    description:
      'Full NIC record for one institution — legal name, FDIC certificate, LEI, institution type, charter type, location, and active/closed status. Sourced from the Federal Reserve National Information Center (ffiec.gov/npw). Look it up by RSSD ID (NIC\'s own identifier), FDIC certificate number (the join key shared with the `fdic` pack), or LEI (the join key shared with the `gleif` pack) — provide exactly one. Use nic_search_institutions first to find an RSSD ID from a name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rssd_id: { type: 'number', description: 'NIC RSSD ID, e.g. 852218 for JPMorgan Chase Bank, N.A. Provide exactly one of rssd_id, fdic_cert, lei.' },
        fdic_cert: { type: 'number', description: 'FDIC certificate number — chains to the `fdic` pack (fdic_get_institution), e.g. 3511 for Wells Fargo Bank, N.A. Provide exactly one of rssd_id, fdic_cert, lei.' },
        lei: { type: 'string', description: 'Legal Entity Identifier (20-character LEI code) — chains to the `gleif` pack, e.g. "7H6GLXDRUGQFU57RNE97" for JPMorgan Chase Bank, N.A. Provide exactly one of rssd_id, fdic_cert, lei.' },
      },
      required: [],
    },
  },
  {
    name: 'nic_get_hierarchy',
    description:
      'Corporate ownership hierarchy for a bank or holding company, sourced from the Federal Reserve NIC (ffiec.gov/npw) Relationships data — "which holding company owns this bank?" / "list the subsidiaries of this BHC". direction="up" (default) walks the ownership chain to its top holder(s) — for a bank subsidiary this typically resolves to a single ultimate parent (e.g. a bank holding company). direction="down" lists entities OWNED BY the given RSSD ID; pass rssd_id of the TOP-TIER parent (found via direction="up") to get the full corporate family. total_subsidiary_count is a DISTINCT count computed in SQL (deduped by RSSD ID across multiple ownership paths to the same subsidiary) — it is always the true total, independent of `limit`/`offset`; use offset to page beyond the first `limit` rows. Coverage note: this is our own computed closure over NIC\'s public Relationships file, not necessarily identical to NIC\'s own web UI tiering figure — see pack README.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rssd_id: { type: 'number', description: 'NIC RSSD ID to start from' },
        direction: { type: 'string', description: '"up" (ancestors/owners, default) or "down" (subsidiaries/descendants)' },
        limit: { type: 'number', description: 'For direction="down": max subsidiary rows to return, 1-200, default 50 (total_subsidiary_count is always the true distinct total, not the page size)' },
        offset: { type: 'number', description: 'For direction="down": pagination offset into total_subsidiary_count, default 0' },
      },
      required: ['rssd_id'],
    },
  },
  {
    name: 'nic_get_history',
    description:
      'Merger, acquisition, failure and charter-transformation history for an institution, sourced from the Federal Reserve NIC (ffiec.gov/npw) Transformations data — "what predecessor institutions merged into this bank?" / "what happened to this bank?". Returns rows where the given RSSD ID is either predecessor (was absorbed/transformed) or successor (absorbed/received the other institution), each with the counterpart institution\'s name, RSSD ID and event date.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        rssd_id: { type: 'number', description: 'NIC RSSD ID' },
      },
      required: ['rssd_id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const supabaseUrl = (args._supabaseUrl as string | undefined)?.trim();
  const supabaseKey = (args._supabaseKey as string | undefined)?.trim();
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('fed-nic is not configured on this deployment — an operator must enable its data credentials. This is a setup problem, not your arguments.');
  }
  const cfg: SupabaseConfig = { url: supabaseUrl, key: supabaseKey };

  switch (name) {
    case 'nic_search_institutions': {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('query is required');
      const status = (args.status as string | undefined) ?? 'active';
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 50);
      const state = (args.state as string | undefined)?.trim().toUpperCase();

      const rows = await pgRpc<Array<Omit<InstitutionRow, 'chtr_type_cd' | 'effective_start' | 'effective_end'>>>(cfg, 'nic_search_ranked', {
        q: query,
        status_filter: status,
        state_filter: state || null,
        result_limit: limit,
      });
      if (rows.length === 0) {
        return { query, status, results: [], message: `No institution matching "${query}" (status=${status}).` };
      }
      return { query, status, result_count: rows.length, results: rows.map(presentInstitution) };
    }

    case 'nic_get_institution': {
      const hasRssd = args.rssd_id !== undefined && args.rssd_id !== null && args.rssd_id !== '';
      const hasFdic = args.fdic_cert !== undefined && args.fdic_cert !== null && args.fdic_cert !== '';
      const hasLei = typeof args.lei === 'string' && args.lei.trim() !== '';
      const providedCount = [hasRssd, hasFdic, hasLei].filter(Boolean).length;
      if (providedCount === 0) throw new Error('Provide exactly one of rssd_id, fdic_cert, or lei.');
      if (providedCount > 1) throw new Error('Provide exactly one of rssd_id, fdic_cert, or lei — not more than one.');

      let filterClause: string;
      let lookupKey: 'rssd_id' | 'fdic_cert' | 'lei';
      let lookupValue: number | string;
      if (hasRssd) {
        const rssdId = Number(args.rssd_id);
        if (!Number.isFinite(rssdId)) throw new Error('rssd_id must be a number');
        lookupKey = 'rssd_id';
        lookupValue = rssdId;
        filterClause = `rssd_id=eq.${rssdId}`;
      } else if (hasFdic) {
        const fdicCert = Number(args.fdic_cert);
        if (!Number.isFinite(fdicCert)) throw new Error('fdic_cert must be a number');
        lookupKey = 'fdic_cert';
        lookupValue = fdicCert;
        filterClause = `fdic_cert=eq.${fdicCert}`;
      } else {
        const lei = String(args.lei).trim().toUpperCase();
        lookupKey = 'lei';
        lookupValue = lei;
        filterClause = `lei=eq.${encodeURIComponent(lei)}`;
      }

      const rows = await pg<InstitutionRow[]>(
        cfg,
        'nic_institutions',
        `${filterClause}&select=rssd_id,legal_name,short_name,status,entity_type_code,bhc_ind,fhc_ind,chtr_type_cd,fdic_cert,lei,city,state_abbr,country_name,effective_start,effective_end,data_as_of&order=status.asc,effective_start.desc.nullslast&limit=1`,
      );
      if (rows.length === 0) {
        return { [lookupKey]: lookupValue, found: false, message: `No institution found for ${lookupKey}=${lookupValue}.` };
      }
      return { found: true, ...presentInstitution(rows[0]), chtr_type_cd: rows[0].chtr_type_cd, effective_start: rows[0].effective_start, effective_end: rows[0].effective_end };
    }

    case 'nic_get_hierarchy': {
      const rssdId = Number(args.rssd_id);
      if (!Number.isFinite(rssdId)) throw new Error('rssd_id is required and must be a number');
      const direction = (args.direction as string | undefined) ?? 'up';

      if (direction === 'down') {
        const limit = Math.min(Math.max(Number(args.limit ?? 50), 1), 200);
        const offset = Math.max(Number(args.offset ?? 0), 0);

        // Two separate RPCs, not one: nic_descendant_count returns a single
        // scalar row (never subject to PostgREST's 1,000-row cap, however
        // large the real closure is), and nic_descendants_page returns an
        // already-deduped, already-paged slice (LIMIT/OFFSET applied in SQL).
        // The old code called nic_descendants (raw, one row per ownership
        // PATH) and used the returned row count as the total — for JPMorgan
        // that RPC alone returns 1,672 rows and PostgREST truncates any
        // single response at 1,000, so the "total" silently became whatever
        // the cap happened to be, not a real count.
        const [totalCountRaw, page] = await Promise.all([
          pgRpc<number>(cfg, 'nic_descendant_count', { start_rssd: rssdId }),
          pgRpc<Array<{ rssd_id: number; parent_rssd_id: number | null; depth: number }>>(
            cfg,
            'nic_descendants_page',
            { start_rssd: rssdId, page_limit: limit, page_offset: offset },
          ),
        ]);
        const totalCount = Number(totalCountRaw);
        if (totalCount === 0) {
          return { rssd_id: rssdId, direction, total_subsidiary_count: 0, subsidiaries: [], message: 'No active subsidiaries found for this RSSD ID.' };
        }
        const ids = page.map((d) => d.rssd_id);
        const names = ids.length
          ? await pg<InstitutionRow[]>(
              cfg,
              'nic_institutions',
              `rssd_id=in.(${ids.join(',')})&select=rssd_id,legal_name,short_name,status,entity_type_code,city,state_abbr,country_name,data_as_of`,
            )
          : [];
        const byId = new Map(names.map((r) => [r.rssd_id, r]));
        const subsidiaries = page.map((d) => {
          const inst = byId.get(d.rssd_id);
          return {
            rssd_id: d.rssd_id,
            legal_name: inst?.legal_name?.trim() ?? null,
            institution_type: entityTypeLabel(inst?.entity_type_code ?? null),
            city: inst?.city ?? null,
            state: inst?.state_abbr ?? null,
            country: inst?.country_name?.trim() ?? null,
            parent_rssd_id: d.parent_rssd_id,
            depth_from_start: d.depth,
          };
        });
        return {
          rssd_id: rssdId,
          direction,
          total_subsidiary_count: totalCount,
          returned_count: subsidiaries.length,
          offset,
          subsidiaries,
          coverage_note: 'total_subsidiary_count counts each subsidiary once, even when it is reachable through several ownership paths, over NIC\'s own public Relationships file; it may differ from NIC\'s own web UI figure — see tool description.',
        };
      }

      // direction: up
      const up = await pgRpc<Array<{ rssd_id: number; depth: number }>>(cfg, 'nic_ancestors', { start_rssd: rssdId });
      if (up.length <= 1) {
        return { rssd_id: rssdId, direction, top_holder: null, chain: [], message: 'No parent/owner found for this RSSD ID — it may already be its own top-tier entity, or ownership data is not present.' };
      }
      const chainIds = up.map((u) => u.rssd_id);
      const names = await pg<InstitutionRow[]>(
        cfg,
        'nic_institutions',
        `rssd_id=in.(${chainIds.join(',')})&select=rssd_id,legal_name,short_name,status,entity_type_code,fdic_cert,lei,city,state_abbr,country_name,data_as_of`,
      );
      const byId = new Map(names.map((r) => [r.rssd_id, r]));
      const depthById = new Map(up.map((u) => [u.rssd_id, u.depth]));
      const chain = chainIds
        .slice()
        .sort((a, b) => (depthById.get(a) ?? 0) - (depthById.get(b) ?? 0))
        .map((id) => {
          const inst = byId.get(id);
          return {
            rssd_id: id,
            legal_name: inst?.legal_name?.trim() ?? null,
            institution_type: entityTypeLabel(inst?.entity_type_code ?? null),
            fdic_cert: inst?.fdic_cert ?? null,
            lei: inst?.lei ?? null,
            depth_from_start: depthById.get(id) ?? null,
          };
        });
      const topHolderId = chainIds.reduce((best, id) => ((depthById.get(id) ?? 0) > (depthById.get(best) ?? 0) ? id : best), chainIds[0]);
      const topHolder = byId.get(topHolderId);
      return {
        rssd_id: rssdId,
        direction,
        top_holder: topHolder
          ? { rssd_id: topHolderId, legal_name: topHolder.legal_name.trim(), institution_type: entityTypeLabel(topHolder.entity_type_code), fdic_cert: topHolder.fdic_cert, lei: topHolder.lei }
          : null,
        chain,
      };
    }

    case 'nic_get_history': {
      const rssdId = Number(args.rssd_id);
      if (!Number.isFinite(rssdId)) throw new Error('rssd_id is required and must be a number');
      const rows = await pg<Array<{ predecessor_rssd_id: number; successor_rssd_id: number; trans_date: string; trnsfm_cd: number | null }>>(
        cfg,
        'nic_transformations',
        `or=(predecessor_rssd_id.eq.${rssdId},successor_rssd_id.eq.${rssdId})&select=predecessor_rssd_id,successor_rssd_id,trans_date,trnsfm_cd&order=trans_date.desc&limit=200`,
      );
      if (rows.length === 0) {
        return { rssd_id: rssdId, event_count: 0, events: [], message: 'No merger/transformation history found for this RSSD ID.' };
      }
      const counterpartIds = [...new Set(rows.map((r) => (r.predecessor_rssd_id === rssdId ? r.successor_rssd_id : r.predecessor_rssd_id)))];
      const names = await pg<InstitutionRow[]>(
        cfg,
        'nic_institutions',
        `rssd_id=in.(${counterpartIds.join(',')})&select=rssd_id,legal_name,status`,
      );
      const byId = new Map(names.map((r) => [r.rssd_id, r]));
      const events = rows.map((r) => {
        const role = r.predecessor_rssd_id === rssdId ? 'predecessor' : 'successor';
        const counterpartId = role === 'predecessor' ? r.successor_rssd_id : r.predecessor_rssd_id;
        const counterpart = byId.get(counterpartId);
        return {
          date: r.trans_date,
          role,
          role_description: role === 'predecessor'
            ? 'This institution was absorbed/transformed into the counterpart institution.'
            : 'This institution absorbed/received the counterpart institution.',
          counterpart_rssd_id: counterpartId,
          counterpart_name: counterpart?.legal_name?.trim() ?? null,
          transformation_code: r.trnsfm_cd,
        };
      });
      return { rssd_id: rssdId, event_count: events.length, events };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
