// Posting-quality rules shared by the collector, the scorer and the report. Pure functions over
// data on disk; no network. Rules live in collect/quality.json, id->date anchors in collect/id_anchors.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, "collect", "quality.json"), "utf8"));
const ANCHORS = JSON.parse(fs.readFileSync(path.join(ROOT, "collect", "id_anchors.json"), "utf8")).anchors
  .map((a) => ({ id: Number(a.id), t: Date.parse(a.date) })).sort((a, b) => a.id - b.id);

export const SKIP_TITLE = new RegExp(CONFIG.skip_title_pattern, "i");
export const BOARD_TITLE = new RegExp(CONFIG.board_title_pattern, "i");
export const BOARD_LOCATION = new RegExp(CONFIG.board_location_pattern, "i");
export const DAY = 86400000;
export const isoDay = (t) => new Date(t).toISOString().slice(0, 10);
export const isLinkedInId = (id) => /^\d+$/.test(String(id));

// Date a LinkedIn posting was created, interpolated from its sequential id. `frontier` = {id, date}
// of the newest card seen, so the curve extends to today without editing the anchor file.
export function estimateCreatedDate(id, frontier = null) {
  const n = Number(id); if (!Number.isFinite(n)) return null;
  let A = ANCHORS;
  if (frontier && Number(frontier.id) > A[A.length - 1].id) A = [...A, { id: Number(frontier.id), t: Date.parse(frontier.date) }];
  const i = A.findIndex((a) => a.id >= n);
  const [lo, hi] = i === 0 ? [A[0], A[1]] : i < 0 ? [A[A.length - 2], A[A.length - 1]] : [A[i - 1], A[i]];
  const t = lo.t + (n - lo.id) * ((hi.t - lo.t) / (hi.id - lo.id));
  return isoDay(Math.min(t, A[A.length - 1].t));
}

export function parseApplicants(s) {
  if (!s) return null;
  const m = String(s).match(/\d+/); if (!m) return null;
  return { n: Number(m[0]), over: /over|超过|\+/i.test(s), under: /first|前/i.test(s) };
}

export function excludedCompany(company) {
  const c = (company || "").toLowerCase();
  return CONFIG.exclude_companies.find((e) => c.includes(e.toLowerCase())) || null;
}

export function normTitle(t) {
  return (t || "").toLowerCase().replace(/\(.*?\)/g, " ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
export function titleSim(a, b) {
  const A = new Set(normTitle(a).split(" ").filter(Boolean)), B = new Set(normTitle(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
}

// Workday list rows only say "Posted 3 Days Ago" / "Posted 30+ Days Ago"; turn that into a date bound.
export function parsePostedOn(s, today = Date.now()) {
  if (!s) return null;
  if (/today/i.test(s)) return isoDay(today);
  if (/yesterday/i.test(s)) return isoDay(today - DAY);
  const m = s.match(/(\d+)\+?\s*days?/i); if (!m) return null;
  return isoDay(today - Number(m[1]) * DAY);
}

// The assessment stored on every job file and copied into its match trace.
export function assessQuality(job, { today = Date.now(), ats = null, frontier = null } = {}) {
  const posted = job.posted_date || null; // LinkedIn's refreshable date, or the board's first_published for board jobs
  const q = { assessed_at: isoDay(today), posted_date: posted, source: job.source || "linkedin" };
  q.id_created_est = isLinkedInId(job.id) ? estimateCreatedDate(job.id, frontier) : null;
  if (q.id_created_est && posted && q.id_created_est > posted) q.id_created_est = posted;
  q.ats = ats ? { provider: ats.provider, url: ats.url, first_published: ats.first_published, updated_at: ats.updated_at || null, title: ats.title } : null;
  q.original_date = [posted, q.id_created_est, ats?.first_published?.slice(0, 10)].filter(Boolean).sort()[0] || null;
  q.age_days = q.original_date ? Math.round((today - Date.parse(q.original_date)) / DAY) : null;
  q.refreshed_days = posted && q.original_date ? Math.round((Date.parse(posted) - Date.parse(q.original_date)) / DAY) : 0;
  q.repost = q.refreshed_days >= CONFIG.repost_days;
  q.stale = q.age_days != null && q.age_days > CONFIG.max_age_days;
  q.excluded_company = excludedCompany(job.company);
  const ap = parseApplicants(job.applicants);
  q.applicants = ap ? ap.n : null; q.applicants_over = !!ap?.over;
  q.flags = [];
  if (q.excluded_company) q.flags.push(`company excluded (${q.excluded_company})`);
  if (q.stale) q.flags.push(`stale: originally posted ~${q.original_date}, ${q.age_days} days ago${q.ats ? ` (${q.ats.provider} first_published ${q.ats.first_published.slice(0, 10)})` : " (LinkedIn id estimate)"}`);
  else if (q.repost) q.flags.push(`repost: LinkedIn shows ${posted} but originally ~${q.original_date}`);
  if (q.applicants_over) q.flags.push(`${q.applicants}+ applicants`);
  return q;
}

// Hard-filter reasons derived from quality alone (used before spending a fetch or an evaluation).
export function qualityFilters(q) {
  const out = [];
  if (q?.excluded_company) out.push(`company excluded: ${q.excluded_company}`);
  if (q?.stale) out.push(q.flags.find((f) => f.startsWith("stale")));
  return out;
}

// Before fetching descriptions: stub out cards that would never be evaluated (title band, excluded
// company, stale by id estimate), so neither LinkedIn requests nor evaluations are spent on them.
export function writeSkipStubs(cards, jobsDir) {
  const top = cards.reduce((a, c) => (!a || Number(c.id) > Number(a.id) ? c : a), null);
  const frontier = top?.posted_date ? { id: top.id, date: top.posted_date } : null;
  const skipped_by = {}; let skipped = 0;
  for (const c of cards) {
    const f = path.join(jobsDir, `${c.id}.json`);
    if (fs.existsSync(f)) continue;
    let status = null, reason = null;
    const q = assessQuality(c, { frontier });
    if (SKIP_TITLE.test(c.title)) { status = "skipped_title"; reason = c.title.match(SKIP_TITLE)[0]; }
    else if (q.excluded_company) { status = "skipped_company"; reason = q.excluded_company; }
    else if (q.stale) { status = "skipped_stale"; reason = q.flags.find((x) => x.startsWith("stale")); }
    if (!status) continue;
    fs.writeFileSync(f, JSON.stringify({ ...c, status, skip_reason: reason, quality: q, fetched_at: null }, null, 2));
    skipped++; skipped_by[status] = (skipped_by[status] || 0) + 1;
  }
  return { skipped, skipped_by };
}
