import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { dbEnabled, pool, q, type DbClient } from './db/pool';

/**
 * FIRST-PARTY ANALYTICS — who a visitor is (for one day, and never beyond it), what their
 * request says about them, what a public endpoint is allowed to accept, the job that keeps any
 * of it from growing without bound, and the queries the admin console reads.
 *
 * Read `server/db/migrations/0042_analytics.sql` first. It states the privacy design that
 * everything here implements, and this file is where it is either true or not:
 *
 *   · **The IP address and the user agent are used and dropped.** They are arguments to
 *     `visitorHash` and to `classify`, they are never returned from either, and no code path
 *     below writes them to a row, a log line or a map. What survives a request is a
 *     16-hex-character digest and a handful of enums.
 *   · **The salt rotates daily and the old one is destroyed** (`sweepAnalytics`, two days).
 *     That deletion is what makes the guarantee real rather than promised: once it is gone,
 *     yesterday's digests cannot be recomputed from an address by anybody, including us.
 *   · **Nothing here knows about accounts.** No function takes a user id and no table it
 *     writes has a column for one. The product numbers at the bottom of this file are
 *     aggregates over the account tables and are never joined to traffic, because there is
 *     nothing to join them ON.
 *
 * ⚠️ THE INGEST ENDPOINT IS PUBLIC AND UNAUTHENTICATED, which is a different threat model from
 * every other route in `server/api.ts`. Four things stand between it and a bill: `parsePageview`
 * accepts a fixed shape with a length cap on every field and never reads an unknown key;
 * `rateOk` bounds one visitor and one address independently; `isBot` refuses the traffic that
 * would otherwise be most of the numbers; and `sweepAnalytics` deletes the raw tier on a
 * schedule rather than when somebody notices.
 */

// ---------------------------------------------------------------- the salt ----

/**
 * TODAY'S SALT, cached in memory with the day it belongs to.
 *
 * SHARED ACROSS MACHINES through the table rather than generated per process: five regions
 * each inventing their own would give one visitor five different hashes, which leaks nothing
 * but inflates every unique count by however many regions they bounced between. The insert is
 * `on conflict do nothing` plus a read-back, so whichever machine gets there first decides and
 * the rest adopt.
 */
let salt: { day: string; value: string } | null = null;

/** `YYYY-MM-DD` in UTC. UTC and not a local zone: five regions have to agree on when a day ends. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function currentSalt(now: Date = new Date()): Promise<string> {
  const day = utcDay(now);
  if (salt && salt.day === day) return salt.value;
  const fresh = randomBytes(32).toString('hex');
  await q('insert into analytics_salt (day, salt) values ($1, $2) on conflict (day) do nothing', [day, fresh]);
  const rows = await q<{ salt: string }>('select salt from analytics_salt where day = $1', [day]);
  const value = rows[0]?.salt ?? fresh;
  salt = { day, value };
  return value;
}

/** drop the cached salt. The tests use it; in production the next call simply re-reads. */
export function resetSaltCache(): void {
  salt = null;
}

/**
 * THE VISITOR KEY: `sha256(salt || ip || user-agent || site)`, truncated to 16 hex characters.
 *
 * `site` is in there so two deployments sharing a database cannot produce the same key for the
 * same person and silently merge their audiences — alpha and production do not share one
 * today, but one Fly app already serves every client version and that is the kind of thing
 * that changes.
 *
 * TRUNCATED TO 64 BITS on purpose. Long enough that a collision is not a practical concern at
 * this volume, short enough that the row is small — and, more to the point, a full digest
 * invites the thought that it is a durable identifier. It is not: it is valid for one UTC day
 * and then meaningless.
 */
export function visitorHash(saltValue: string, ip: string, ua: string, site: string): string {
  return createHash('sha256').update(`${saltValue}|${ip}|${ua}|${site}`).digest('hex').slice(0, 16);
}

// ------------------------------------------------------- the request itself ----

/**
 * THE CLIENT ADDRESS, used to compute a hash and then forgotten.
 *
 * `fly-client-ip` is what the Fly proxy sets and is the only one of these a client on this
 * deployment cannot forge; `x-forwarded-for` is honoured after it because a local reverse
 * proxy is the ordinary development setup, and its FIRST entry is the one the edge saw. A
 * forged header can at worst split one visitor into several — a slightly high unique count,
 * and nothing else. There is no privilege here to escalate to.
 */
export function clientIp(req: IncomingMessage): string {
  const one = (v: string | string[] | undefined): string =>
    (Array.isArray(v) ? v[0] : (v ?? '')).split(',')[0].trim();
  return one(req.headers['fly-client-ip']) || one(req.headers['x-forwarded-for']) || req.socket.remoteAddress || '';
}

/**
 * THE COUNTRY, from a header the edge already added, or nothing.
 *
 * Checked in the order of how much each is worth here: Fly is where the beacon actually lands,
 * and the other two cost one property access and keep a deployment behind a different edge
 * from silently losing the column. NEVER a geo-IP lookup — that means handing a visitor's
 * address to a company the privacy policy does not name, to answer a question the browser can
 * answer approximately for free.
 */
export function headerCountry(req: IncomingMessage): string {
  const raw = req.headers['fly-client-country'] ?? req.headers['cf-ipcountry'] ?? req.headers['x-vercel-ip-country'];
  const v = (Array.isArray(raw) ? raw[0] : (raw ?? '')).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(v) && v !== 'XX' ? v : '';
}

/**
 * IANA TIMEZONE → ISO COUNTRY, the fallback when no edge header carries one.
 *
 * COARSE, AND THAT IS THE POINT. A zone names a place a clock is kept, not a person: every
 * visitor in the eastern United States reports `America/New_York`, so this narrows to a
 * country and stops. Zones that genuinely span countries resolve to the largest of them and
 * the number is a little wrong there — a fair trade against the two alternatives, neither of
 * which is on the table (ask a geo-IP service, or store the address).
 *
 * The table is the zones that actually appear in browser traffic, not the whole tz database.
 * An unknown zone contributes no country rather than a guess.
 */
const TZ_COUNTRY: Record<string, string> = {};
{
  // `<country> <zone> <zone> …`, one group per country. Written this way because 250 lines of
  // `'America/New_York': 'US',` is 250 lines nobody reads and one nobody can diff; grouping by
  // country is how the tz database itself is organised.
  const TABLE =
    'US America/New_York America/Detroit America/Chicago America/Denver America/Phoenix America/Los_Angeles America/Anchorage America/Indiana/Indianapolis America/Kentucky/Louisville America/Boise Pacific/Honolulu|' +
    'CA America/Toronto America/Vancouver America/Edmonton America/Winnipeg America/Halifax America/St_Johns America/Regina America/Montreal|' +
    'MX America/Mexico_City America/Tijuana America/Monterrey America/Cancun America/Chihuahua|' +
    'BR America/Sao_Paulo America/Bahia America/Fortaleza America/Recife America/Manaus America/Belem|' +
    'AR America/Argentina/Buenos_Aires|CL America/Santiago|CO America/Bogota|PE America/Lima|VE America/Caracas|' +
    'EC America/Guayaquil|BO America/La_Paz|PY America/Asuncion|UY America/Montevideo|CR America/Costa_Rica|' +
    'PA America/Panama|GT America/Guatemala|DO America/Santo_Domingo|PR America/Puerto_Rico|JM America/Jamaica|' +
    'CU America/Havana|HN America/Tegucigalpa|SV America/El_Salvador|NI America/Managua|TT America/Port_of_Spain|' +
    'GB Europe/London|IE Europe/Dublin|PT Europe/Lisbon Atlantic/Azores|ES Europe/Madrid Atlantic/Canary|' +
    'FR Europe/Paris|DE Europe/Berlin|NL Europe/Amsterdam|BE Europe/Brussels|LU Europe/Luxembourg|' +
    'CH Europe/Zurich|AT Europe/Vienna|IT Europe/Rome|GR Europe/Athens|TR Europe/Istanbul|' +
    'PL Europe/Warsaw|CZ Europe/Prague|SK Europe/Bratislava|HU Europe/Budapest|RO Europe/Bucharest|' +
    'BG Europe/Sofia|HR Europe/Zagreb|SI Europe/Ljubljana|RS Europe/Belgrade|BA Europe/Sarajevo|' +
    'MK Europe/Skopje|AL Europe/Tirane|SE Europe/Stockholm|NO Europe/Oslo|DK Europe/Copenhagen|' +
    'FI Europe/Helsinki|IS Atlantic/Reykjavik|EE Europe/Tallinn|LV Europe/Riga|LT Europe/Vilnius|' +
    'BY Europe/Minsk|UA Europe/Kyiv Europe/Kiev|MD Europe/Chisinau|' +
    'RU Europe/Moscow Asia/Yekaterinburg Asia/Novosibirsk Asia/Krasnoyarsk Asia/Irkutsk Asia/Vladivostok Europe/Kaliningrad Europe/Samara|' +
    'CN Asia/Shanghai Asia/Urumqi Asia/Chongqing|HK Asia/Hong_Kong|TW Asia/Taipei|MO Asia/Macau|' +
    'JP Asia/Tokyo|KR Asia/Seoul|KP Asia/Pyongyang|MN Asia/Ulaanbaatar|' +
    'IN Asia/Kolkata Asia/Calcutta|PK Asia/Karachi|BD Asia/Dhaka|LK Asia/Colombo|NP Asia/Kathmandu|' +
    'AF Asia/Kabul|IR Asia/Tehran|IQ Asia/Baghdad|SA Asia/Riyadh|AE Asia/Dubai|QA Asia/Qatar|' +
    'KW Asia/Kuwait|BH Asia/Bahrain|OM Asia/Muscat|IL Asia/Jerusalem Asia/Tel_Aviv|JO Asia/Amman|' +
    'LB Asia/Beirut|SY Asia/Damascus|YE Asia/Aden|AM Asia/Yerevan|AZ Asia/Baku|GE Asia/Tbilisi|' +
    'KZ Asia/Almaty Asia/Aqtobe|UZ Asia/Tashkent|KG Asia/Bishkek|TJ Asia/Dushanbe|TM Asia/Ashgabat|' +
    'TH Asia/Bangkok|VN Asia/Ho_Chi_Minh Asia/Saigon|KH Asia/Phnom_Penh|LA Asia/Vientiane|MM Asia/Yangon|' +
    'MY Asia/Kuala_Lumpur Asia/Kuching|SG Asia/Singapore|ID Asia/Jakarta Asia/Makassar Asia/Jayapura|' +
    'PH Asia/Manila|BN Asia/Brunei|' +
    'AU Australia/Sydney Australia/Melbourne Australia/Brisbane Australia/Perth Australia/Adelaide Australia/Hobart Australia/Darwin|' +
    'NZ Pacific/Auckland|FJ Pacific/Fiji|PG Pacific/Port_Moresby|GU Pacific/Guam|' +
    'ZA Africa/Johannesburg|EG Africa/Cairo|NG Africa/Lagos|KE Africa/Nairobi|GH Africa/Accra|' +
    'MA Africa/Casablanca|DZ Africa/Algiers|TN Africa/Tunis|LY Africa/Tripoli|ET Africa/Addis_Ababa|' +
    'TZ Africa/Dar_es_Salaam|UG Africa/Kampala|SN Africa/Dakar|CI Africa/Abidjan|CM Africa/Douala|' +
    'ZW Africa/Harare|ZM Africa/Lusaka|MZ Africa/Maputo|AO Africa/Luanda|SD Africa/Khartoum';
  for (const group of TABLE.split('|')) {
    const parts = group.trim().split(/\s+/);
    for (let i = 1; i < parts.length; i++) TZ_COUNTRY[parts[i]] = parts[0];
  }
}

export function countryForTimezone(tz: string): string {
  return TZ_COUNTRY[tz] ?? '';
}

/**
 * WHAT THE USER AGENT SAYS, reduced to three enums and then forgotten.
 *
 * Deliberately CRUDE. A real UA parser is a megabyte of tables tracking a moving target so it
 * can tell Chrome 118 from Chrome 119, and the dashboard says "Chrome" — a version column
 * would be four hundred rows of noise and one more thing narrowing a visitor down. The order
 * of the tests is the whole trick, because every browser claims to be every other one: Edge
 * says Chrome and Safari, Chrome says Safari, so the most specific claim is checked first.
 */
export function classify(ua: string): { device: string; os: string; browser: string } {
  const s = ua.toLowerCase();
  const os = /windows/.test(s) ? 'Windows'
    : /android/.test(s) ? 'Android'
      : /(iphone|ipad|ipod)/.test(s) ? 'iOS'
        : /mac os x|macintosh/.test(s) ? 'macOS'
          : /cros/.test(s) ? 'ChromeOS'
            : /linux/.test(s) ? 'Linux'
              : '';
  const browser = /edg\//.test(s) ? 'Edge'
    : /opr\/|opera/.test(s) ? 'Opera'
      : /samsungbrowser/.test(s) ? 'Samsung Internet'
        : /firefox|fxios/.test(s) ? 'Firefox'
          : /electron/.test(s) ? 'Electron'
            : /chrome|crios/.test(s) ? 'Chrome'
              : /safari/.test(s) ? 'Safari'
                : '';
  // A TABLET IS NOT A BIG PHONE for this purpose: DSIM hides ads on touch and lays the HUD out
  // differently, so "did it work on a tablet" is a question somebody asks. iPadOS reports
  // itself as a Mac with a touchscreen, which no user-agent string can settle — an iPad in
  // desktop Safari therefore lands in `desktop`, which is the honest reading of what the
  // request said rather than a guess about the hardware.
  const device = /ipad|android(?!.*mobile)|tablet|playbook|silk/.test(s) ? 'tablet'
    : /mobi|iphone|ipod|android|windows phone/.test(s) ? 'mobile'
      : 'desktop';
  return { device, os, browser };
}

/**
 * IS THIS A CRAWLER? — the single most important filter on the whole feature.
 *
 * Search engines, link-preview scrapers, uptime probes and headless browsers visit constantly,
 * and every one of them is a visitor, a session and a bounce unless something says otherwise.
 * Left in, they are not a rounding error: on a site this size they are most of the traffic,
 * and a number that flatters you is the one decisions get made on.
 *
 * A BLANK USER AGENT COUNTS AS A BOT. Every real browser sends one; the things that do not are
 * scripts, and a script is not a page view.
 */
const BOT_RE =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|embedly|quora link preview|pinterest|vkshare|whatsapp|telegram|discordbot|slackbot|twitterbot|linkedinbot|applebot|petalbot|yandex|duckduckgo|baiduspider|semrush|ahrefs|mj12|dotbot|screaming frog|headlesschrome|phantomjs|puppeteer|playwright|python-requests|curl\/|wget\/|axios\/|go-http-client|okhttp|java\/|libwww|httpclient|monitor|uptime|pingdom|statuscake|gtmetrix|lighthouse/i;

export function isBot(ua: string): boolean {
  if (!ua.trim()) return true;
  return BOT_RE.test(ua);
}

/** the primary language subtag off `Accept-Language` — `en`, `de`, never the whole list */
export function primaryLang(header: string | string[] | undefined): string {
  const raw = (Array.isArray(header) ? header[0] : (header ?? '')).split(',')[0].split(';')[0].trim();
  const tag = raw.split('-')[0].toLowerCase();
  return /^[a-z]{2,3}$/.test(tag) ? tag : '';
}

// ---------------------------------------------------- what the client sends ----

export interface PageviewInput {
  path: string;
  game: string;
  ref: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  screen: string;
  timezone: string;
  surface: string;
  channel: string;
  build: string;
}

const SCREENS = new Set(['sm', 'md', 'lg', 'xl']);
const SURFACES = new Set(['web', 'electron']);

/** a short, printable string or nothing — applied to every field below, without exception */
function text(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // Control characters are stripped rather than refused: they cannot appear in anything a real
  // client sends, and throwing away a genuine view over somebody's odd input method would be a
  // worse outcome than a cleaned string.
  // eslint-disable-next-line no-control-regex
  return v.replace(/[ -]/g, '').trim().slice(0, max);
}

/**
 * PARSE AND VALIDATE ONE BEACON, or refuse it.
 *
 * ⚠️ AN ALLOWLIST, NOT A SANITIZER. Unknown keys are not cleaned up, they are never read — the
 * result is built field by field from a fixed list — so a client cannot introduce a column, and
 * a body that is mostly junk costs exactly what one that is not costs.
 *
 * `path` is the only field that can refuse the beacon, because a pageview with no page is not
 * a partial record, it is not a record. Everything else empties out: a browser with no
 * timezone, a direct visit with no referrer and a client too old to send `channel` are all
 * ordinary, and a row with a blank column still counts as a view.
 */
export function parsePageview(body: unknown): PageviewInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const path = text(b.p, 128);
  if (!path.startsWith('/')) return null;
  const game = text(b.g, 16);
  const screen = text(b.w, 4);
  const surface = text(b.x, 12);
  return {
    path,
    game: /^[a-z]{1,16}$/.test(game) ? game : '',
    ref: text(b.r, 64).toLowerCase(),
    utmSource: text(b.s, 48).toLowerCase(),
    utmMedium: text(b.m, 48).toLowerCase(),
    utmCampaign: text(b.c, 48).toLowerCase(),
    screen: SCREENS.has(screen) ? screen : '',
    timezone: text(b.z, 48),
    surface: SURFACES.has(surface) ? surface : 'web',
    channel: text(b.ch, 16) || 'stable',
    build: text(b.b, 16),
  };
}

export interface EventInput {
  name: string;
  path: string;
  props: Record<string, string>;
}

/**
 * ⚠️ EVENT PROPERTIES ARE BOUNDED HERE, not trusted to be small.
 *
 * `src/analytics.ts` states the rule its payloads have always been written to — counts and
 * enums, never a user id, username, email or transaction id — and this is the first place it
 * is ENFORCED rather than followed. Four keys, lowercase names, each value coerced to a short
 * string. A property carrying something long enough to be an identifier is truncated into
 * something that is not one, which is a better outcome than dropping the event and losing the
 * count it was fired for.
 */
export function parseEvent(body: unknown): EventInput | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const name = text(b.n, 40);
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(name)) return null;
  const props: Record<string, string> = {};
  const raw = b.d && typeof b.d === 'object' ? (b.d as Record<string, unknown>) : {};
  for (const key of Object.keys(raw).slice(0, 4)) {
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(key)) continue;
    const v = raw[key];
    if (typeof v === 'number' || typeof v === 'boolean') props[key] = String(v).slice(0, 32);
    else if (typeof v === 'string') props[key] = text(v, 32);
  }
  return { name, path: text(b.p, 128), props };
}

/** the game a path names, so an event does not have to be told one it already implies */
export function gameOfPath(path: string): string {
  const m = /^\/([a-z]{1,16})(?:\/|$)/.exec(path);
  return m ? m[1] : '';
}

// -------------------------------------------------------------- rate limits ----

/**
 * TWO INDEPENDENT LIMITS, because they answer different questions — the same shape
 * `lanRateOk` and `exportRateOk` in `server/api.ts` take, and for the same reason: one more
 * small function beats an abstraction over three call sites.
 *
 *   PER VISITOR — how many pages one browser may claim to have viewed. Generous against real
 *     behaviour (this is a single-page app; a busy session is tens of route changes) and
 *     ruinous for a script.
 *   PER ADDRESS — how much one network may send in total. Much higher, because a school or a
 *     competition venue is one address with a room full of people behind it, and throttling the
 *     venue because it is busy is exactly the failure this second number exists to avoid.
 *
 * ⚠️ NEITHER MAP HOLDS AN IP ADDRESS. The per-address key is a hash of the address under the
 * same rotating salt, so the limiter cannot quietly become the one place the addresses live.
 */
const RATE_WINDOW_MS = 10 * 60_000;
export const VISITOR_LIMIT = 90;
export const ADDRESS_LIMIT = 400;
const hits = new Map<string, { n: number; until: number }>();

export function rateOk(key: string, max: number, now = Date.now()): boolean {
  // Swept unconditionally on the way past — `lanRateOk` in `server/api.ts` spells out why a
  // size-gated sweep never runs in the one burst that would justify it.
  for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
  const hit = hits.get(key);
  if (!hit || hit.until <= now) {
    hits.set(key, { n: 1, until: now + RATE_WINDOW_MS });
    return true;
  }
  hit.n++;
  return hit.n <= max;
}

export function resetRateLimits(): void {
  hits.clear();
}

// ------------------------------------------------------------- dimensions ----

/**
 * THE BREAKDOWNS, and the column each one reads.
 *
 * ONE LIST, read by the rollup, by the raw-tier queries, by the filter validator and by the
 * dashboard, so a new breakdown is one entry rather than four edits that have to agree.
 * `label` lives here rather than in the component because the server validates a filter
 * against this same set, and the two must not be able to disagree about what exists.
 */
export const DIMENSIONS = [
  { id: 'path', col: 'path', label: 'Pages' },
  { id: 'entry', col: 'path', label: 'Entry pages' },
  { id: 'ref', col: 'ref_host', label: 'Referrers' },
  { id: 'utm_source', col: 'utm_source', label: 'UTM source' },
  { id: 'utm_medium', col: 'utm_medium', label: 'UTM medium' },
  { id: 'utm_campaign', col: 'utm_campaign', label: 'UTM campaign' },
  { id: 'country', col: 'country', label: 'Countries' },
  { id: 'device', col: 'device', label: 'Devices' },
  { id: 'os', col: 'os', label: 'Operating systems' },
  { id: 'browser', col: 'browser', label: 'Browsers' },
  { id: 'screen', col: 'screen', label: 'Screen sizes' },
  { id: 'lang', col: 'lang', label: 'Languages' },
  { id: 'surface', col: 'surface', label: 'Surface' },
  { id: 'channel', col: 'channel', label: 'Build channel' },
  { id: 'build', col: 'build', label: 'Client build' },
] as const;

export type DimensionId = (typeof DIMENSIONS)[number]['id'];

/**
 * The column a dimension FILTERS on, or null when it cannot be filtered.
 *
 * ⚠️ THIS IS THE ONLY PLACE A COLUMN NAME REACHES A QUERY FROM A REQUEST. Everything else is a
 * bound parameter; a dimension id is not, because a column name cannot be one. So the id is
 * matched against this fixed list and an unknown one produces null rather than a string that
 * gets interpolated.
 *
 * `entry` is a property of a SESSION, not of a row, so there is no pageview column to filter
 * on — a chip for it would have to mean "sessions that started here", which is a different
 * question from the one every other chip asks.
 */
export function dimColumn(id: string): string | null {
  const hit = DIMENSIONS.find((d) => d.id === id);
  if (!hit || hit.id === 'entry') return null;
  return hit.col;
}

/** 30 minutes of inactivity ends a session — the interval the schema comment names */
const GAP = "interval '30 minutes'";

/**
 * SESSIONS ARE DERIVED, NEVER STORED — this CTE is the whole definition.
 *
 * A stored session would need a client-side identifier to attach views to, which is the one
 * thing this design does not have and will not add. So the boundary is computed from what IS
 * recorded: a visitor's views in time order, cut wherever the gap exceeds 30 minutes.
 *
 * ⚠️ THE WINDOW LOOKS BACK 30 MINUTES BEFORE THE RANGE, and then `having` drops the sessions
 * that started earlier. Without the lookback, a session straddling the boundary is reported as
 * two; without the `having`, it is counted again in every bucket it merely continued into.
 * Views are attributed to the bucket they happened in, SESSIONS to the bucket they STARTED in
 * — the convention every analytics product uses, and the only one under which two adjacent
 * buckets add up to the range that contains them.
 */
function sessionCte(where: string): string {
  return `
    win as (select * from analytics_pageviews
             where at >= $1::timestamptz - ${GAP} and at < $2::timestamptz ${where}),
    lagged as (select w.*, lag(at) over (partition by visitor order by at) as prev from win w),
    marked as (
      select l.*, sum(case when prev is null or at - prev > ${GAP} then 1 else 0 end)
                    over (partition by visitor order by at rows unbounded preceding) as sid
        from lagged l),
    pv as (select * from marked where at >= $1),
    sess as (
      select visitor, sid, min(at) as started, max(at) as ended, count(*)::int as views,
             (array_agg(path         order by at))[1] as path,
             (array_agg(game         order by at))[1] as game,
             (array_agg(ref_host     order by at))[1] as ref_host,
             (array_agg(utm_source   order by at))[1] as utm_source,
             (array_agg(utm_medium   order by at))[1] as utm_medium,
             (array_agg(utm_campaign order by at))[1] as utm_campaign,
             (array_agg(country      order by at))[1] as country,
             (array_agg(device       order by at))[1] as device,
             (array_agg(os           order by at))[1] as os,
             (array_agg(browser      order by at))[1] as browser,
             (array_agg(screen       order by at))[1] as screen,
             (array_agg(lang         order by at))[1] as lang,
             (array_agg(surface      order by at))[1] as surface,
             (array_agg(channel      order by at))[1] as channel,
             (array_agg(build        order by at))[1] as build
        from marked group by visitor, sid having min(at) >= $1)`;
}

/**
 * A BUCKET BOUNDARY IN UTC, whatever timezone the database session happens to be in.
 *
 * `date_trunc('day', at)` truncates in the SESSION's timezone, and a Fly machine's is whatever
 * its image decided. Two regions rolling up the same range into differently-aligned days is
 * the kind of bug that shows as "the chart is one bar off" and is never traced to a timezone.
 */
function bucketExpr(grain: 'hour' | 'day', col: string): string {
  return grain === 'day'
    ? `(${col} at time zone 'UTC')::date`
    : `date_trunc('hour', ${col} at time zone 'UTC') at time zone 'UTC'`;
}

// ------------------------------------------------------------- the rollup ----

/**
 * ONE STATEMENT THAT REBUILDS A RANGE OF BUCKETS, at either grain.
 *
 * GENERATED from `DIMENSIONS` rather than written out, because it is the same five aggregates
 * over fifteen breakdowns and a hand-written version is fifteen chances for one of them to
 * drift. Per dimension: views and visitors counted off the VIEWS, sessions, bounces and
 * session seconds counted off the SESSIONS and joined on the value — with `dim = 'path'`
 * deliberately taking no session half, per the schema comment. A session visits many pages and
 * splitting its length across them would invent a number that reads as measured.
 *
 * `cross join lateral (values (game), ('*'))` is what produces the all-games row ALONGSIDE the
 * per-game ones instead of expecting a reader to sum them. Views and sessions would sum
 * correctly; VISITORS WOULD NOT — one person who played two games on one day is one visitor —
 * and a table you must sum in one column and must not in another is a table somebody sums
 * wrong.
 *
 * IDEMPOTENT by `on conflict … do update`, which is what lets the job re-run the last few
 * buckets every time rather than trusting that a machine happened to be up when one closed.
 */
export function rollupSql(grain: 'hour' | 'day'): string {
  const table = grain === 'hour' ? 'analytics_hourly' : 'analytics_daily';
  const col = grain === 'hour' ? 'hour' : 'day';
  const vb = bucketExpr(grain, 'at');
  const sb = bucketExpr(grain, 'started');
  const sessionAgg = (valSql: string): string => `
    select ${sb} as b, g.gm, ${valSql} as val, count(*)::int as sessions,
           count(*) filter (where sess.views = 1)::int as bounces,
           coalesce(sum(extract(epoch from (ended - started))), 0)::bigint as seconds
      from sess cross join lateral (values (sess.game), ('*')) g(gm) group by 1, 2, 3`;

  const blocks: string[] = [];

  // the headline row: one per bucket per game, val '*'
  blocks.push(`
    select v.b as bucket, v.gm as game, 'total' as dim, '*' as val, v.views, v.visitors,
           coalesce(s.sessions, 0) as sessions, coalesce(s.bounces, 0) as bounces,
           coalesce(s.seconds, 0) as seconds
      from (select ${vb} as b, g.gm, count(*)::int as views, count(distinct visitor)::int as visitors
              from pv cross join lateral (values (pv.game), ('*')) g(gm) group by 1, 2) v
      left join (${sessionAgg("'*'")}) s on s.b = v.b and s.gm = v.gm`);

  for (const d of DIMENSIONS) {
    if (d.id === 'entry') {
      // Entry pages are a session fact with no view half at all. `views` here is how many
      // pages those sessions went on to see, which is the number that makes a landing page
      // worth anything.
      blocks.push(`
        select ${sb} as bucket, g.gm as game, 'entry' as dim, sess.path as val,
               sum(sess.views)::int as views, count(distinct visitor)::int as visitors,
               count(*)::int as sessions, count(*) filter (where sess.views = 1)::int as bounces,
               coalesce(sum(extract(epoch from (ended - started))), 0)::bigint as seconds
          from sess cross join lateral (values (sess.game), ('*')) g(gm) group by 1, 2, 4`);
      continue;
    }
    const plain = d.id === 'path';
    blocks.push(`
      select v.b as bucket, v.gm as game, '${d.id}' as dim, v.val, v.views, v.visitors,
             ${plain ? '0' : 'coalesce(s.sessions, 0)'} as sessions,
             ${plain ? '0' : 'coalesce(s.bounces, 0)'} as bounces,
             ${plain ? '0::bigint' : 'coalesce(s.seconds, 0)'} as seconds
        from (select ${vb} as b, g.gm, pv.${d.col} as val, count(*)::int as views,
                     count(distinct visitor)::int as visitors
                from pv cross join lateral (values (pv.game), ('*')) g(gm) group by 1, 2, 3) v
        ${plain ? '' : `left join (${sessionAgg('sess.' + d.col)}) s on s.b = v.b and s.gm = v.gm and s.val = v.val`}`);
  }

  // named events, so the funnel keeps the same history the traffic does
  blocks.push(`
    select ${bucketExpr(grain, 'e.at')} as bucket, g.gm as game, 'event' as dim, e.name as val,
           count(*)::int as views, count(distinct e.visitor)::int as visitors,
           0 as sessions, 0 as bounces, 0::bigint as seconds
      from analytics_events e cross join lateral (values (e.game), ('*')) g(gm)
     where e.at >= $1::timestamptz and e.at < $2::timestamptz group by 1, 2, 4`);

  // ...and their property values, as `name|key|value`, so a month-old sponsor report can still
  // be broken down by placement after the raw events are gone.
  blocks.push(`
    select ${bucketExpr(grain, 'e.at')} as bucket, g.gm as game, 'evprop' as dim,
           e.name || '|' || p.key || '|' || p.value as val,
           count(*)::int as views, count(distinct e.visitor)::int as visitors,
           0 as sessions, 0 as bounces, 0::bigint as seconds
      from analytics_events e cross join lateral jsonb_each_text(e.props) p
           cross join lateral (values (e.game), ('*')) g(gm)
     where e.at >= $1::timestamptz and e.at < $2::timestamptz group by 1, 2, 4`);

  return `with ${sessionCte('')}
    insert into ${table} (${col}, game, dim, val, views, visitors, sessions, bounces, seconds)
    select bucket, game, dim, val, views, visitors, sessions, bounces, seconds
      from (${blocks.join('\n      union all\n')}) rolled
     where val is not null
    on conflict (${col}, game, dim, val) do update set
      views = excluded.views, visitors = excluded.visitors, sessions = excluded.sessions,
      bounces = excluded.bounces, seconds = excluded.seconds`;
}

// ------------------------------------------------------ retention + the job ----

/** raw rows past this are gone; the aggregates keep the history */
export const RAW_RETENTION_DAYS = 30;
/** hourly buckets past this are gone; a 90-day range reads the daily table */
export const HOURLY_RETENTION_DAYS = 35;
/** operational concurrency samples — long enough to compare a season to the last one */
export const CONCURRENCY_RETENTION_DAYS = 120;
/** ⚠️ the salt is destroyed at two days, which is what makes an old visitor hash unlinkable */
export const SALT_RETENTION_DAYS = 2;

/**
 * THE ADVISORY LOCK KEY for the maintenance job — fixed and arbitrary, exactly like
 * `MIGRATE_LOCK_KEY` in `server/db/migrate.ts`, because every machine must pick the same
 * number for a lock to mean anything.
 *
 * `pg_try_advisory_lock` rather than `pg_advisory_lock`: five regions wake on the same
 * interval, and a machine that finds the job already running should go back to sleep rather
 * than queue up to do the whole thing again the moment the first one finishes.
 */
export const ANALYTICS_LOCK_KEY = 0x414e4c59; // 'ANLY'

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * WIDEN A RANGE TO WHOLE BUCKETS. The upsert REPLACES a bucket with whatever the range held,
 * so a range that starts mid-bucket overwrites that bucket with a fraction of it. The job
 * rolls "the last three hours", which starts mid-hour and mid-day on every pass: before this,
 * each pass overwrote the oldest hourly bucket and TODAY'S DAILY ROW with the last three hours
 * only. Epoch-aligned is UTC-aligned, matching `bucketExpr`.
 */
function bucketRange(grain: 'hour' | 'day', from: Date, to: Date): [Date, Date] {
  const size = grain === 'hour' ? HOUR_MS : DAY_MS;
  return [
    new Date(Math.floor(from.getTime() / size) * size),
    new Date(Math.ceil(to.getTime() / size) * size),
  ];
}

/** roll one grain's buckets over a range. Re-runs are free — the upsert is idempotent. */
export async function runRollupGrain(grain: 'hour' | 'day', from: Date, to: Date): Promise<void> {
  await q(rollupSql(grain), bucketRange(grain, from, to));
}

/** roll a range up at both grains */
export async function runRollup(from: Date, to: Date): Promise<void> {
  await runRollupGrain('hour', from, to);
  await runRollupGrain('day', from, to);
}

/**
 * DELETE WHAT IS PAST ITS RETENTION — and, in the same pass, the old salts.
 *
 * ⚠️ THE SALT SWEEP IS THE PRIVACY GUARANTEE, not housekeeping. Everything else here is about
 * disk; that one line is the difference between "we do not link visitors across days" as a
 * policy somebody could change their mind about and as a fact about what the database is able
 * to compute.
 */
export async function sweepAnalytics(): Promise<void> {
  // `make_interval(days => …)` rather than `($1 || ' days')::interval`: the concatenation form
  // leaves the parameter's type UNKNOWN, which Postgres then infers as whatever makes the
  // expression parse — and the delete either errors or, worse, silently compares against
  // something nobody meant. The days are constants here, but the shape is the point.
  const older = 'at < now() - make_interval(days => $1::int)';
  await q(`delete from analytics_pageviews where ${older}`, [RAW_RETENTION_DAYS]);
  await q(`delete from analytics_events where ${older}`, [RAW_RETENTION_DAYS]);
  await q(`delete from analytics_hourly where hour < now() - make_interval(days => $1::int)`, [HOURLY_RETENTION_DAYS]);
  await q(`delete from analytics_concurrency where ${older}`, [CONCURRENCY_RETENTION_DAYS]);
  await q(`delete from analytics_salt where day < (now() at time zone 'UTC')::date - $1::int`, [SALT_RETENTION_DAYS]);
}

/**
 * SAMPLE HOW MANY PEOPLE ARE ON THE SERVICE, per region, into a table that keeps it.
 *
 * `presence` (0015) already holds the live snapshot and is OVERWRITTEN every five seconds by
 * design, so it can answer "now" and nothing else. This copies it, rounded to the minute, and
 * that copy is the only record of concurrency this project has ever had.
 *
 * Returns how many rows it wrote, which is what arms and disarms the job below.
 */
export async function sampleConcurrency(): Promise<number> {
  const rows = await q<{ n: string }>(
    `insert into analytics_concurrency (at, region, online, authed, rooms, q1v1, q2v2)
     select date_trunc('minute', now()), region,
            sum(online)::int, sum(jsonb_array_length(authed))::int,
            sum(jsonb_array_length(rooms))::int, sum(q1v1)::int, sum(q2v2)::int
       from presence
      where updated_at > now() - interval '30 seconds' and online > 0
      group by region
     on conflict (at, region) do update set
       online = excluded.online, authed = excluded.authed, rooms = excluded.rooms,
       q1v1 = excluded.q1v1, q2v2 = excluded.q2v2
     returning 1 as n`,
  );
  return rows.length;
}

/**
 * THE MAINTENANCE JOB, started by the first beacon that arrives and self-arming after that.
 *
 * ⚠️ IT IS STARTED FROM THE INGEST PATH, not from `server/index.ts`'s boot sequence, and the
 * reason is the rule that block states: **Neon bills the wall-clock time the compute is awake,
 * and a timer that fires unconditionally does not cost one small query, it costs the month.**
 * A deployment with `VITE_ANALYTICS` unset receives no beacons, so this never starts at all
 * and never wakes anything; one that does receive them has an awake database already, because
 * the beacon it just handled wrote a row.
 *
 * `busy` matters as much as the advisory lock. The lock stops five MACHINES doing the work at
 * once; `busy` stops one machine starting a second pass while the first is still going, which
 * a slow rollup on a cold compute will otherwise do every five minutes forever.
 */
const ROLLUP_EVERY_MS = 5 * 60_000;
let jobTimer: NodeJS.Timeout | null = null;
let sawTraffic = false;
let busy = false;
/**
 * When this process last ran the DAILY pass (the day-grain rollup and the retention sweep).
 * Those run at most once per UTC hour, not every five minutes: the day rollup scans the whole
 * day's raw rows, the daily table is only read for ranges older than the raw tier, and
 * retention is counted in days. The next daily pass rolls from this watermark, so traffic that
 * arrived after one pass and before a long quiet spell still reaches the day it belongs to.
 */
let lastDailyAt: number | null = null;

export function noteTraffic(): void {
  sawTraffic = true;
}

export function ensureAnalyticsJobs(): void {
  if (jobTimer || !dbEnabled) return;
  jobTimer = setInterval(() => {
    void analyticsTick();
  }, ROLLUP_EVERY_MS);
  jobTimer.unref();
}

/** stop the job. Test-only; a live server keeps it for the life of the process. */
export function stopAnalyticsJobs(): void {
  if (jobTimer) clearInterval(jobTimer);
  jobTimer = null;
  sawTraffic = false;
  busy = false;
  lastDailyAt = null;
}

/** one maintenance pass, exported so the tests can drive it without a timer */
export async function analyticsTick(now = Date.now()): Promise<void> {
  if (busy || !dbEnabled || !pool) return;
  // Nothing has arrived since the last pass, so there is nothing to roll up and nobody to
  // count. Stay quiet: an idle machine must not be the reason the database is awake.
  if (!sawTraffic) return;
  sawTraffic = false;
  busy = true;
  // ⚠️ THE LOCK NEEDS ITS OWN CLIENT. A session-level advisory lock belongs to the connection
  // that took it, and `q()` hands each statement to whichever pooled connection is free — so
  // the unlock could land on a different session, fail, and leave the lock held by an idle
  // pooled connection that every other machine then fails to take. Same shape as `migrate()`.
  let lock: DbClient | null = null;
  try {
    lock = await pool.connect();
    const held = await lock.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [ANALYTICS_LOCK_KEY]);
    if (!held.rows[0]?.ok) {
      // another machine has it. Its pass may have started before our rows landed, so ask again
      // next tick rather than dropping them until the next beacon.
      sawTraffic = true;
      return;
    }
    try {
      // Re-roll the last three hours rather than only the one that just closed: a machine that
      // was restarting when a bucket ended would otherwise leave a permanent hole, and the
      // upsert makes redoing recent work free.
      const to = new Date(now);
      const from = new Date(now - 3 * HOUR_MS);
      await runRollupGrain('hour', from, to);
      if ((await sampleConcurrency()) > 0) sawTraffic = true; // people are on — keep sampling
      const dailyDue = lastDailyAt === null || Math.floor(lastDailyAt / HOUR_MS) !== Math.floor(now / HOUR_MS);
      if (dailyDue) {
        const dayFrom = new Date(Math.min(from.getTime(), lastDailyAt ?? from.getTime()));
        await runRollupGrain('day', dayFrom, to);
        await sweepAnalytics();
        lastDailyAt = now;
      }
    } finally {
      await lock.query('select pg_advisory_unlock($1)', [ANALYTICS_LOCK_KEY]).catch(() => {});
    }
  } catch (e) {
    console.error('[analytics] maintenance failed:', e);
  } finally {
    lock?.release();
    busy = false;
  }
}

// ----------------------------------------------------------------- ingest ----

export interface IngestContext {
  visitor: string;
  country: string;
  device: string;
  os: string;
  browser: string;
  lang: string;
}

/** write one pageview. The context is everything derived from headers; nothing raw survives. */
export async function insertPageview(v: PageviewInput, c: IngestContext): Promise<void> {
  await q(
    `insert into analytics_pageviews
       (visitor, path, game, ref_host, utm_source, utm_medium, utm_campaign,
        country, device, os, browser, screen, lang, surface, channel, build)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [c.visitor, v.path, v.game, v.ref, v.utmSource, v.utmMedium, v.utmCampaign,
      c.country, c.device, c.os, c.browser, v.screen, c.lang, v.surface, v.channel, v.build],
  );
  noteTraffic();
}

export async function insertEvent(e: EventInput, visitor: string): Promise<void> {
  await q(
    `insert into analytics_events (visitor, name, game, path, props) values ($1,$2,$3,$4,$5)`,
    [visitor, e.name, gameOfPath(e.path), e.path, JSON.stringify(e.props)],
  );
  noteTraffic();
}

// ------------------------------------------------------- the dashboard read ----

export interface RangeQuery {
  from: Date;
  to: Date;
  game: string;
  filters: { dim: string; val: string }[];
  grain: 'hour' | 'day';
}

export interface Totals {
  views: number;
  visitors: number;
  sessions: number;
  bounces: number;
  seconds: number;
}

export interface BreakdownRow {
  dim: string;
  val: string;
  views: number;
  visitors: number;
}

export interface AnalyticsReport {
  /** 'raw' answers a filtered question exactly; 'aggregate' is the long-history fallback */
  source: 'raw' | 'aggregate';
  /** the oldest instant the raw tier can still answer about, so the UI can say why */
  rawFloor: string;
  totals: Totals;
  previous: Totals;
  series: { t: string; views: number; visitors: number }[];
  breakdowns: BreakdownRow[];
  events: { name: string; views: number; visitors: number }[];
  eventProps: { name: string; key: string; val: string; views: number }[];
  online: number;
  /** the first UTC day this database holds its own traffic for, or null before any */
  historyStart: string | null;
  /** history loaded from Vercel Web Analytics (migration 0052), or null if none was imported */
  imported: ImportedReport | null;
}

/**
 * THE IMPORTED HISTORY, over the same range as the live report. Page views and daily-unique
 * visitors only: the source had no sessions, and it is not split by game. `firstDay`/`lastDay`
 * are the whole imported span, so the dashboard can say where it is even when the range misses it.
 */
export interface ImportedReport {
  source: string;
  firstDay: string;
  lastDay: string;
  totals: { views: number; visitors: number };
  series: { t: string; views: number; visitors: number }[];
  breakdowns: BreakdownRow[];
  events: { name: string; views: number; visitors: number }[];
  eventProps: { name: string; key: string; val: string; views: number }[];
}

/**
 * WHERE THE FILTERS GO, and the one place a request's words reach SQL.
 *
 * The dimension id is matched against `DIMENSIONS` and turned into a column by `dimColumn`;
 * the VALUE is always a bound parameter. There is no path by which a caller-supplied string is
 * concatenated into a statement, which is the property worth stating out loud on a route that
 * takes an arbitrary number of arbitrary filters.
 */
function filterSql(filters: { dim: string; val: string }[], params: unknown[], alias = ''): string {
  let sql = '';
  for (const f of filters) {
    const col = dimColumn(f.dim);
    if (!col) continue;
    params.push(f.val);
    sql += ` and ${alias}${col} = $${params.length}`;
  }
  return sql;
}

/** the game term, which is a filter like any other but lives in its own column on every table */
function gameSql(game: string, params: unknown[], alias = ''): string {
  if (!game || game === '*') return '';
  params.push(game);
  return ` and ${alias}game = $${params.length}`;
}

/** headline numbers for one window, off the raw tier (exact, and filterable) */
async function rawTotals(from: Date, to: Date, game: string, filters: { dim: string; val: string }[]): Promise<Totals> {
  const params: unknown[] = [from, to];
  const where = gameSql(game, params) + filterSql(filters, params);
  const rows = await q<{ views: string; visitors: string; sessions: string; bounces: string; seconds: string }>(
    `with ${sessionCte(where)}
     select (select count(*) from pv) as views,
            (select count(distinct visitor) from pv) as visitors,
            (select count(*) from sess) as sessions,
            (select count(*) from sess where views = 1) as bounces,
            (select coalesce(sum(extract(epoch from (ended - started))), 0) from sess) as seconds`,
    params,
  );
  const r = rows[0];
  const n = (v: string | undefined): number => Math.round(Number(v ?? 0));
  return { views: n(r?.views), visitors: n(r?.visitors), sessions: n(r?.sessions), bounces: n(r?.bounces), seconds: n(r?.seconds) };
}

/** the same numbers off the rollups, for a range older than the raw tier keeps */
async function aggTotals(from: Date, to: Date, game: string): Promise<Totals> {
  const params: unknown[] = [from, to, game || '*'];
  const rows = await q<{ views: string; visitors: string; sessions: string; bounces: string; seconds: string }>(
    `select coalesce(sum(views),0) as views, coalesce(sum(visitors),0) as visitors,
            coalesce(sum(sessions),0) as sessions, coalesce(sum(bounces),0) as bounces,
            coalesce(sum(seconds),0) as seconds
       from analytics_daily
      where day >= ($1 at time zone 'UTC')::date and day < ($2 at time zone 'UTC')::date
        and game = $3 and dim = 'total'`,
    params,
  );
  const r = rows[0];
  const n = (v: string | undefined): number => Math.round(Number(v ?? 0));
  return { views: n(r?.views), visitors: n(r?.visitors), sessions: n(r?.sessions), bounces: n(r?.bounces), seconds: n(r?.seconds) };
}

/**
 * THE WHOLE DASHBOARD PAYLOAD IN ONE CALL.
 *
 * ⚠️ TWO TIERS, AND THE UI IS TOLD WHICH ONE IT GOT. A range that starts inside the raw
 * retention window is answered exactly and can be cross-filtered; one that reaches further
 * back is answered from the daily rollups, where a filter on country AND device does not exist
 * to be applied. Both are honest answers; silently degrading one into the other is what would
 * not be, so `source` rides along and the panel says so.
 */
export async function analyticsReport(qy: RangeQuery): Promise<AnalyticsReport> {
  const floor = new Date(Date.now() - RAW_RETENTION_DAYS * 86_400_000);
  /**
   * ⚠️ THE BOUNDARY NEEDS A GRACE, and without one the "30 days" preset could never take the
   * raw tier it is named after. `from` is computed in the BROWSER and `floor` here, so the
   * client's "exactly 30 days ago" is always a few hundred milliseconds — plus whatever the
   * two clocks disagree by — EARLIER than the server's floor. The comparison therefore failed
   * every single time, and the most useful range on the dashboard answered from
   * `analytics_daily`: zero views, zero visitors, no chart and no breakdowns on a service
   * whose raw table held every row of it.
   *
   * An hour is sized to swallow clock skew and the request in flight, not to reach for data
   * the raw tier does not have: `sweepAnalytics` deletes rows OLDER than the retention window,
   * so the extra hour simply finds fewer rows at the very start of the range rather than
   * different ones. Under-reporting the oldest sixty minutes of a thirty-day window is a far
   * smaller error than reporting the whole window as zero.
   */
  const BOUNDARY_GRACE_MS = 3_600_000;
  const source: 'raw' | 'aggregate' =
    qy.from.getTime() >= floor.getTime() - BOUNDARY_GRACE_MS ? 'raw' : 'aggregate';
  const span = qy.to.getTime() - qy.from.getTime();
  const prevFrom = new Date(qy.from.getTime() - span);

  const [totals, previous, series, breakdowns, events, eventProps, online, historyStart, imported] = await Promise.all([
    source === 'raw' ? rawTotals(qy.from, qy.to, qy.game, qy.filters) : aggTotals(qy.from, qy.to, qy.game),
    source === 'raw'
      ? prevFrom >= floor
        ? rawTotals(prevFrom, qy.from, qy.game, qy.filters)
        : aggTotals(prevFrom, qy.from, qy.game)
      : aggTotals(prevFrom, qy.from, qy.game),
    source === 'raw' ? rawSeries(qy) : aggSeries(qy),
    source === 'raw' ? rawBreakdowns(qy) : aggBreakdowns(qy),
    source === 'raw' ? rawEvents(qy) : aggEvents(qy),
    source === 'raw' ? rawEventProps(qy) : aggEventProps(qy),
    onlineNow(),
    firstOwnDay(),
    importedReport(qy.from, qy.to),
  ]);

  return {
    source,
    rawFloor: floor.toISOString(),
    totals,
    previous,
    series,
    breakdowns,
    events,
    eventProps,
    online,
    historyStart,
    imported,
  };
}

/** `name|key|value` back into its parts. The value may itself contain `|`. */
function splitEvprop(val: string): { name: string; key: string; val: string } {
  const a = val.indexOf('|');
  const b = a < 0 ? -1 : val.indexOf('|', a + 1);
  if (b < 0) return { name: val, key: '', val: '' };
  return { name: val.slice(0, a), key: val.slice(a + 1, b), val: val.slice(b + 1) };
}

/** events off the daily rollups, for a range older than the raw tier keeps */
async function aggEvents(qy: RangeQuery): Promise<{ name: string; views: number; visitors: number }[]> {
  const rows = await q<{ name: string; views: string; visitors: string }>(
    `select val as name, sum(views) as views, sum(visitors) as visitors from analytics_daily
      where day >= ($1 at time zone 'UTC')::date and day < ($2 at time zone 'UTC')::date
        and game = $3 and dim = 'event'
      group by 1 order by views desc limit 30`,
    [qy.from, qy.to, qy.game || '*'],
  );
  return rows.map((r) => ({ name: r.name, views: Number(r.views), visitors: Number(r.visitors) }));
}

async function aggEventProps(qy: RangeQuery): Promise<{ name: string; key: string; val: string; views: number }[]> {
  const rows = await q<{ val: string; views: string }>(
    `select val, sum(views) as views from analytics_daily
      where day >= ($1 at time zone 'UTC')::date and day < ($2 at time zone 'UTC')::date
        and game = $3 and dim = 'evprop'
      group by 1 order by views desc limit 120`,
    [qy.from, qy.to, qy.game || '*'],
  );
  return rows.map((r) => ({ ...splitEvprop(r.val), views: Number(r.views) }));
}

/** where this database's own traffic begins — the dashboard states it beside the imported span */
async function firstOwnDay(): Promise<string | null> {
  const rows = await q<{ d: Date | string | null }>(
    `select least((select min(day) from analytics_daily where dim = 'total'),
                  (select min((at at time zone 'UTC')::date) from analytics_pageviews)) as d`,
  );
  const d = rows[0]?.d;
  return d ? new Date(d).toISOString().slice(0, 10) : null;
}

/**
 * THE IMPORTED HISTORY over a range, all games (the source never knew one). Days, not instants:
 * the source's days are UTC, and so are ours.
 */
async function importedReport(from: Date, to: Date): Promise<ImportedReport | null> {
  const span = await q<{ source: string; first: Date | string; last: Date | string }>(
    `select source, min(day) as first, max(day) as last from analytics_imported
      where dim = 'total' group by source order by min(day) limit 1`,
  );
  if (!span[0]) return null;
  const source = span[0].source;
  const day = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);
  // `to` is exclusive, so the last day is the one holding the instant just before it
  const params = [source, day(from), day(new Date(to.getTime() - 1))];
  const inRange = `source = $1 and day >= $2::date and day <= $3::date`;
  const [series, breakdowns, events, props] = await Promise.all([
    q<{ t: Date | string; views: string; visitors: string }>(
      `select day as t, views, visitors from analytics_imported where ${inRange} and dim = 'total' order by day`,
      params,
    ),
    q<{ dim: string; val: string; views: string; visitors: string }>(
      `select dim, val, sum(views) as views, sum(visitors) as visitors from analytics_imported
        where ${inRange} and dim not in ('total', 'event', 'evprop')
        group by dim, val order by dim, views desc`,
      params,
    ),
    q<{ name: string; views: string; visitors: string }>(
      `select val as name, sum(views) as views, sum(visitors) as visitors from analytics_imported
        where ${inRange} and dim = 'event' group by 1 order by views desc limit 30`,
      params,
    ),
    q<{ val: string; views: string }>(
      `select val, sum(views) as views from analytics_imported
        where ${inRange} and dim = 'evprop' group by 1 order by views desc limit 120`,
      params,
    ),
  ]);
  const seen = new Map<string, number>();
  const rows: BreakdownRow[] = [];
  for (const r of breakdowns) {
    const n = seen.get(r.dim) ?? 0;
    if (n >= TOP_N) continue;
    seen.set(r.dim, n + 1);
    rows.push({ dim: r.dim, val: r.val ?? '', views: Number(r.views), visitors: Number(r.visitors) });
  }
  const s = series.map((r) => ({ t: new Date(r.t).toISOString(), views: Number(r.views), visitors: Number(r.visitors) }));
  return {
    source,
    firstDay: day(span[0].first),
    lastDay: day(span[0].last),
    totals: { views: s.reduce((a, r) => a + r.views, 0), visitors: s.reduce((a, r) => a + r.visitors, 0) },
    series: s,
    breakdowns: rows,
    events: events.map((r) => ({ name: r.name, views: Number(r.views), visitors: Number(r.visitors) })),
    eventProps: props.map((r) => ({ ...splitEvprop(r.val), views: Number(r.views) })),
  };
}

async function rawSeries(qy: RangeQuery): Promise<{ t: string; views: number; visitors: number }[]> {
  const params: unknown[] = [qy.from, qy.to];
  const where = gameSql(qy.game, params) + filterSql(qy.filters, params);
  const rows = await q<{ t: Date | string; views: string; visitors: string }>(
    `select ${bucketExpr(qy.grain, 'at')} as t, count(*) as views, count(distinct visitor) as visitors
       from analytics_pageviews
      where at >= $1 and at < $2 ${where}
      group by 1 order by 1`,
    params,
  );
  return rows.map((r) => ({ t: new Date(r.t).toISOString(), views: Number(r.views), visitors: Number(r.visitors) }));
}

async function aggSeries(qy: RangeQuery): Promise<{ t: string; views: number; visitors: number }[]> {
  const rows = await q<{ t: Date | string; views: string; visitors: string }>(
    `select day as t, views, visitors from analytics_daily
      where day >= ($1 at time zone 'UTC')::date and day < ($2 at time zone 'UTC')::date
        and game = $3 and dim = 'total' order by day`,
    [qy.from, qy.to, qy.game || '*'],
  );
  return rows.map((r) => ({ t: new Date(r.t).toISOString(), views: Number(r.views), visitors: Number(r.visitors) }));
}

/** how many rows each breakdown panel shows. Twelve is a panel; forty is a page nobody reads. */
const TOP_N = 12;

/**
 * EVERY BREAKDOWN IN ONE ROUND TRIP.
 *
 * Fifteen separate queries would each re-scan the same range; one `union all` scans it once per
 * branch but ships a single result the panel can split, and — more usefully — it cannot get
 * fifteen slightly different `where` clauses. Each branch carries its own `limit`, so the
 * payload is bounded by the number of panels rather than by how many distinct countries
 * happened to visit.
 */
async function rawBreakdowns(qy: RangeQuery): Promise<BreakdownRow[]> {
  const params: unknown[] = [qy.from, qy.to];
  const where = gameSql(qy.game, params) + filterSql(qy.filters, params);
  const branches = DIMENSIONS.filter((d) => d.id !== 'entry').map(
    (d) => `(select '${d.id}' as dim, ${d.col} as val, count(*) as views, count(distinct visitor) as visitors
               from analytics_pageviews where at >= $1 and at < $2 ${where}
              group by 2 order by views desc limit ${TOP_N})`,
  );
  // Entry pages come off the sessions rather than the views, so they need the CTE the others do
  // not. Kept in the same result set because the panel grid does not care where a row came from.
  const entryParams: unknown[] = [qy.from, qy.to];
  const entryWhere = gameSql(qy.game, entryParams) + filterSql(qy.filters, entryParams);
  const [rows, entry] = await Promise.all([
    q<{ dim: string; val: string; views: string; visitors: string }>(branches.join(' union all '), params),
    q<{ val: string; views: string; visitors: string }>(
      `with ${sessionCte(entryWhere)}
       select path as val, count(*) as views, count(distinct visitor) as visitors
         from sess group by 1 order by views desc limit ${TOP_N}`,
      entryParams,
    ),
  ]);
  return [
    ...rows.map((r) => ({ dim: r.dim, val: r.val ?? '', views: Number(r.views), visitors: Number(r.visitors) })),
    ...entry.map((r) => ({ dim: 'entry', val: r.val ?? '', views: Number(r.views), visitors: Number(r.visitors) })),
  ];
}

async function aggBreakdowns(qy: RangeQuery): Promise<BreakdownRow[]> {
  const rows = await q<{ dim: string; val: string; views: string; visitors: string }>(
    `select dim, val, sum(views) as views, sum(visitors) as visitors
       from analytics_daily
      where day >= ($1 at time zone 'UTC')::date and day < ($2 at time zone 'UTC')::date
        and game = $3 and dim not in ('total', 'event', 'evprop')
      group by dim, val order by dim, views desc`,
    [qy.from, qy.to, qy.game || '*'],
  );
  // The per-dimension `limit` that the raw branches apply in SQL is applied here instead: one
  // grouped scan of a small table beats fifteen, and the trim is the same trim.
  const seen = new Map<string, number>();
  const out: BreakdownRow[] = [];
  for (const r of rows) {
    const n = seen.get(r.dim) ?? 0;
    if (n >= TOP_N) continue;
    seen.set(r.dim, n + 1);
    out.push({ dim: r.dim, val: r.val ?? '', views: Number(r.views), visitors: Number(r.visitors) });
  }
  return out;
}

async function rawEvents(qy: RangeQuery): Promise<{ name: string; views: number; visitors: number }[]> {
  const params: unknown[] = [qy.from, qy.to];
  const where = gameSql(qy.game, params);
  const rows = await q<{ name: string; views: string; visitors: string }>(
    `select name, count(*) as views, count(distinct visitor) as visitors
       from analytics_events where at >= $1 and at < $2 ${where}
      group by 1 order by views desc limit 30`,
    params,
  );
  return rows.map((r) => ({ name: r.name, views: Number(r.views), visitors: Number(r.visitors) }));
}

/**
 * THE PROPERTY VALUES BEHIND EACH EVENT — `sponsor_shown` by `placement`, `desktop_download` by
 * `os`, `support_claim_fail` by `reason`.
 *
 * An event count on its own answers "did this happen" and almost never the question somebody
 * arrived with. `jsonb_each_text` unrolls the bounded property bag `parseEvent` wrote, so the
 * panel can nest the values under the name without a column per property existing.
 */
async function rawEventProps(qy: RangeQuery): Promise<{ name: string; key: string; val: string; views: number }[]> {
  const params: unknown[] = [qy.from, qy.to];
  const where = gameSql(qy.game, params);
  const rows = await q<{ name: string; key: string; val: string; views: string }>(
    `select name, p.key, p.value as val, count(*) as views
       from analytics_events e, lateral jsonb_each_text(e.props) p
      where e.at >= $1 and e.at < $2 ${where}
      group by 1, 2, 3 order by views desc limit 120`,
    params,
  );
  return rows.map((r) => ({ name: r.name, key: r.key, val: r.val, views: Number(r.views) }));
}

/** live sockets across every region with a fresh heartbeat — the "online now" tile */
async function onlineNow(): Promise<number> {
  const rows = await q<{ n: string }>(
    `select coalesce(sum(online), 0) as n from presence where updated_at > now() - interval '30 seconds'`,
  );
  return Number(rows[0]?.n ?? 0);
}

// ------------------------------------------------------------ the product ----

export interface ProductReport {
  /** matches finished per day, split by game × mode × physics */
  matches: { day: string; game: string; kind: string; mode: string; physics: string; n: number }[];
  /** accounts created per day */
  signups: { day: string; n: number }[];
  /** accounts that played something that day, and how many of them were new */
  active: { day: string; active: number; returning: number }[];
  /** what share of a signup cohort came back on day 1, 7 and 30 */
  retention: { cohort: string; size: number; d1: number; d7: number; d30: number }[];
  /** ranked ratings, in 100-point buckets, for the live period of each game */
  ranked: { game: string; bucket: number; n: number }[];
  /** replays written per day, and what the table weighs now */
  replays: { day: string; n: number }[];
  replayBytes: number;
  /** reports filed and actioned */
  reports: { day: string; filed: number; actioned: number }[];
  /** Ko-fi payments claimed per day, and comps granted */
  supporters: { day: string; claimed: number; granted: number }[];
  /** 2D vs 3D, as chosen by the people who watched a practice run */
  view: { view: string; n: number }[];
  /** peak and mean concurrency per day per region */
  concurrency: { day: string; region: string; peak: number; mean: number }[];
}

/**
 * THE NUMBERS A TRAFFIC DASHBOARD CANNOT GIVE YOU, read off the tables that already hold them.
 *
 * ⚠️ NOT ONE NEW COLUMN IS WRITTEN FOR ANY OF THIS. Matches, signups, retention, the ranked
 * distribution, replay growth, moderation load and supporter conversions are all already in
 * this database because the product needed them; what was missing was somewhere to look at
 * them. Anything genuinely NOT recorded is absent from this list rather than approximated —
 * queue wait times, graphics tier and disconnect rates live only in process memory, and
 * inventing them from something adjacent would be worse than the gap.
 *
 * Every query is bounded by the same range the traffic half uses, and every one is a plain
 * aggregate: no row here identifies a person, and the dashboard shows none.
 */
export async function productReport(from: Date, to: Date, game: string): Promise<ProductReport> {
  const g = game && game !== '*' ? game : null;
  const day = (col: string): string => `(${col} at time zone 'UTC')::date`;

  const [matches, signups, active, retention, ranked, replays, replayBytes, reports, supporters, view, concurrency] =
    await Promise.all([
      // Versus matches and record runs are two tables and one question. `ranked` splits the
      // first into ranked/custom; a record run is its own kind because it has no opponent.
      q<{ day: string; game: string; kind: string; mode: string; physics: string; n: string }>(
        `select ${day('created_at')} as day, game,
                case when ranked then 'ranked' else 'custom' end as kind, mode, physics, count(*) as n
           from matches where created_at >= $1 and created_at < $2 and ($3::text is null or game = $3)
          group by 1,2,3,4,5
         union all
         select ${day('created_at')} as day, game, 'record' as kind, mode, physics, count(*) as n
           from records where created_at >= $1 and created_at < $2 and ($3::text is null or game = $3)
          group by 1,2,3,4,5
          order by 1`,
        [from, to, g],
      ),
      q<{ day: string; n: string }>(
        `select ${day('created_at')} as day, count(*) as n from profiles
          where created_at >= $1 and created_at < $2 group by 1 order by 1`,
        [from, to],
      ),
      // "Played something" = took part in a versus match or submitted a record run. Deliberately
      // not `user_activity`, which is a running TOTAL per account with no dates in it at all
      // (0028 says why), so it can answer how much somebody has played and never when.
      q<{ day: string; active: string; returning: string }>(
        `with acts as (
           select mp.user_id, ${day('m.created_at')} as day from match_participants mp
             join matches m on m.id = mp.match_id
            where m.created_at >= $1 and m.created_at < $2 and ($3::text is null or m.game = $3)
           union
           select user_id, ${day('created_at')} as day from records
            where created_at >= $1 and created_at < $2 and ($3::text is null or game = $3))
         select a.day, count(*) as active,
                count(*) filter (where p.created_at::date < a.day) as returning
           from acts a join profiles p on p.user_id = a.user_id
          group by a.day order by a.day`,
        [from, to, g],
      ),
      // D1/D7/D30: of the accounts created on a day, how many played at least once on or after
      // that later day. "On or after" rather than "on exactly": a player who comes back on day
      // 8 is retained, and the exact-day version measures whether somebody was free on a
      // Tuesday.
      q<{ cohort: string; size: string; d1: string; d7: string; d30: string }>(
        `with cohort as (
           select user_id, created_at::date as day from profiles
            where created_at >= $1 and created_at < $2),
         acts as (
           select mp.user_id, m.created_at::date as day from match_participants mp
             join matches m on m.id = mp.match_id
           union
           select user_id, created_at::date from records)
         select c.day as cohort, count(distinct c.user_id) as size,
                count(distinct c.user_id) filter (where a.day >= c.day + 1) as d1,
                count(distinct c.user_id) filter (where a.day >= c.day + 7) as d7,
                count(distinct c.user_id) filter (where a.day >= c.day + 30) as d30
           from cohort c left join acts a on a.user_id = c.user_id
          group by c.day order by c.day`,
        [from, to],
      ),
      // THE LIVE ACT ONLY. A rating is keyed to an ACT, not a season (migration 0013: a season
      // reset wipes the record boards and carries the ratings over), so the live distribution
      // is the one joined to the active season's act — mixing two acts describes nobody, since
      // an act reset is exactly where everyone went back to the middle.
      q<{ game: string; bucket: string; n: string }>(
        `select e.game, (floor(e.rating / 100.0) * 100)::int as bucket, count(*) as n
           from elo_ratings e join seasons s on s.game = e.game and s.act = e.act and s.active
          where e.games > 0 and ($1::text is null or e.game = $1)
          group by 1, 2 order by 1, 2`,
        [g],
      ),
      q<{ day: string; n: string }>(
        `select ${day('created_at')} as day, count(*) as n from replays
          where created_at >= $1 and created_at < $2 and ($3::text is null or game = $3)
          group by 1 order by 1`,
        [from, to, g],
      ),
      // What the archive actually weighs, which is the number behind "should we purge a season".
      q<{ bytes: string }>(`select pg_total_relation_size('replays') as bytes`),
      q<{ day: string; filed: string; actioned: string }>(
        `select ${day('created_at')} as day, count(*) as filed,
                count(*) filter (where status <> 'open') as actioned
           from player_reports where created_at >= $1 and created_at < $2 group by 1 order by 1`,
        [from, to],
      ),
      // A claim is the conversion event: a payment that reached an account. `supporter_grants`
      // separates the comps an admin handed out from the ones somebody paid for.
      q<{ day: string; claimed: string; granted: string }>(
        `select d.day, coalesce(k.n, 0) as claimed, coalesce(sg.n, 0) as granted
           from (select distinct ${day('claimed_at')} as day from kofi_payments
                  where claimed_at >= $1 and claimed_at < $2
                 union
                 select distinct ${day('created_at')} from supporter_grants
                  where created_at >= $1 and created_at < $2) d
           left join (select ${day('claimed_at')} as day, count(*) as n from kofi_payments
                       where claimed_at >= $1 and claimed_at < $2 group by 1) k on k.day = d.day
           left join (select ${day('created_at')} as day, count(*) as n from supporter_grants
                       where created_at >= $1 and created_at < $2 and source = 'admin' group by 1) sg
             on sg.day = d.day
          order by d.day`,
        [from, to],
      ),
      // The one table that records which RENDERER somebody watched in — 0039 explains why it is
      // only ever recorded for a practice run.
      q<{ view: string; n: string }>(
        `select coalesce(view, 'unrecorded') as view, count(*) as n from practice_runs
          where created_at >= $1 and created_at < $2 and ($3::text is null or game = $3)
          group by 1 order by 2 desc`,
        [from, to, g],
      ),
      q<{ day: string; region: string; peak: string; mean: string }>(
        `select ${day('at')} as day, region, max(online) as peak, round(avg(online), 1) as mean
           from analytics_concurrency where at >= $1 and at < $2 group by 1, 2 order by 1, 2`,
        [from, to],
      ),
    ]);

  /**
   * Counts come back from the driver as STRINGS (`count(*)` is `bigint`) and a `date` column as
   * a `Date`, which `JSON.stringify` renders as a full instant with a timezone on it. Both are
   * fixed once, here, rather than in eleven chart components: a day is `YYYY-MM-DD` and a count
   * is a number, and the client should not have to know which driver produced either.
   */
  const num = <T extends Record<string, unknown>>(rows: T[], keys: string[]): T[] =>
    rows.map((r) => {
      const out = { ...r } as Record<string, unknown>;
      for (const k of keys) out[k] = Number(out[k] ?? 0);
      for (const k of ['day', 'cohort']) {
        if (out[k] != null) out[k] = new Date(out[k] as string).toISOString().slice(0, 10);
      }
      return out as T;
    });

  return {
    matches: num(matches, ['n']) as unknown as ProductReport['matches'],
    signups: num(signups, ['n']) as unknown as ProductReport['signups'],
    active: num(active, ['active', 'returning']) as unknown as ProductReport['active'],
    retention: num(retention, ['size', 'd1', 'd7', 'd30']) as unknown as ProductReport['retention'],
    ranked: num(ranked, ['bucket', 'n']) as unknown as ProductReport['ranked'],
    replays: num(replays, ['n']) as unknown as ProductReport['replays'],
    replayBytes: Number(replayBytes[0]?.bytes ?? 0),
    reports: num(reports, ['filed', 'actioned']) as unknown as ProductReport['reports'],
    supporters: num(supporters, ['claimed', 'granted']) as unknown as ProductReport['supporters'],
    view: num(view, ['n']) as unknown as ProductReport['view'],
    concurrency: num(concurrency, ['peak', 'mean']) as unknown as ProductReport['concurrency'],
  };
}
