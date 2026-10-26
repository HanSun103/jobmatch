#!/usr/bin/env node
// Pull every board in collect/boards.json through its provider and save the listing to
// data/jobs/boards/<provider>_<slug>.json: `all` (light rows: id, title, location, first_published, url,
// used to link LinkedIn postings to their true first-published date) and `candidates` (rows whose title
// and location fit the profile, with descriptions; Workday candidates get a detail fetch). Nothing here
// touches data/jobs/<id>.json; collect/assess_quality.mjs does the linking and materialising.
// usage: node collect/fetch_boards.mjs [--only stripe,td] [--no-detail]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeCtx } from "./boards/_http.mjs";
import { SKIP_TITLE, BOARD_TITLE, BOARD_LOCATION, parsePostedOn, CONFIG } from "./quality.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "data", "jobs", "boards");
const BOARDS = JSON.parse(fs.readFileSync(path.join(ROOT, "collect", "boards.json"), "utf8"));
const args = process.argv.slice(2);
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const NO_DETAIL = args.includes("--no-detail");

const providers = {};
for (const f of fs.readdirSync(path.join(ROOT, "collect", "boards")).filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))) {
  const p = (await import(pathToFileURL(path.join(ROOT, "collect", "boards", f)).href)).default;
  providers[p.id] = p;
}
const ctx = makeCtx({ searchTerms: BOARDS.search_terms });
const slugOf = (e) => e.slug || `${e.tenant}-${e.site}`;
// Workday list rows say "2 Locations" for multi-site postings; let them through, the detail fetch fills the real cities.
const isCandidate = (r) => BOARD_TITLE.test(r.title) && !SKIP_TITLE.test(r.title) && (r.location || "").split(";").some((l) => BOARD_LOCATION.test(l.trim()) || /^\d+ locations$/i.test(l.trim()));

fs.mkdirSync(OUT_DIR, { recursive: true });
let boards = 0, rows = 0, cands = 0;
for (const entry of BOARDS.boards.filter((e) => e.enabled !== false)) {
  const slug = slugOf(entry);
  if (ONLY && !ONLY.some((o) => slug.includes(o) || entry.name.toLowerCase().includes(o.toLowerCase()))) continue;
  const provider = providers[entry.provider];
  if (!provider) { console.log(`${entry.name}: unknown provider ${entry.provider}`); continue; }
  const t0 = Date.now();
  try {
    const all = await provider.list(entry, ctx);
    let candidates = all.filter(isCandidate);
    // Workday rows carry only "Posted N Days Ago"; skip the detail call for rows already older than the window.
    if (provider.detail && !NO_DETAIL) {
      const fresh = candidates.filter((r) => { const d = parsePostedOn(r.posted_on); return !d || (Date.now() - Date.parse(d)) / 86400000 <= CONFIG.max_age_days; });
      const out = [];
      for (const r of fresh) { try { out.push(await provider.detail(entry, r, ctx)); } catch (e) { out.push({ ...r, detail_error: e.message }); } await ctx.sleep(400); }
      candidates = out;
    }
    const light = all.map(({ board_id, title, location, first_published, updated_at, url, posted_on }) => ({ board_id, title, location, first_published: first_published || parsePostedOn(posted_on), updated_at, url }));
    fs.writeFileSync(path.join(OUT_DIR, `${entry.provider}_${slug}.json`), JSON.stringify({ fetched_at: new Date().toISOString(), entry, total: all.length, candidates, all: light }, null, 2));
    boards++; rows += all.length; cands += candidates.length;
    console.log(`${entry.name} (${entry.provider}): ${all.length} postings, ${candidates.length} candidates, ${((Date.now() - t0) / 1000) | 0}s`);
  } catch (e) { console.log(`${entry.name} (${entry.provider}): FAILED ${e.message}`); }
}
console.log(`done: ${boards} boards, ${rows} postings, ${cands} candidates -> data/jobs/boards/`);
