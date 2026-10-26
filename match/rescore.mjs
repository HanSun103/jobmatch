#!/usr/bin/env node
// Recompute hard filters, score and tier for every saved trace in data/matches from the stored
// evaluation plus the job file's current `quality` block. No API calls: edit match/score.mjs or
// collect/quality.json (then run collect/assess_quality.mjs), run this, then rebuild the report.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hardFilters, score, tier } from "./score.mjs";
import { qualityFilters } from "../collect/quality.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATCH_DIR = path.join(ROOT, "data", "matches");
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "profile.json"), "utf8"));
const jobQuality = (id) => { const f = path.join(JOBS_DIR, `${id}.json`); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")).quality || null : null; };

const before = {}, after = {}; let changed = 0;
for (const f of fs.readdirSync(MATCH_DIR).filter((f) => f.endsWith(".json"))) {
  const p = path.join(MATCH_DIR, f);
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  before[m.tier] = (before[m.tier] || 0) + 1;
  m.quality = jobQuality(m.id);
  if (m.status === "prefiltered") {
    // Never evaluated because quality alone excluded it; if the rules relaxed, drop the stub so the matcher picks it up.
    const qf = qualityFilters(m.quality);
    if (!qf.length) { fs.unlinkSync(p); changed++; after.needs_evaluation = (after.needs_evaluation || 0) + 1; continue; }
    m.filters = qf; m.tier = "filtered_out"; m.rescored_at = new Date().toISOString();
    after[m.tier] = (after[m.tier] || 0) + 1; fs.writeFileSync(p, JSON.stringify(m, null, 2)); continue;
  }
  if (m.status !== "ok") continue;
  const filters = hardFilters(m.evaluation, profile, { quality: m.quality });
  const s = score(m.evaluation, profile);
  const t = tier(s.total, filters);
  if (t !== m.tier || s.total !== m.score.total || filters.join("|") !== m.filters.join("|")) changed++;
  m.filters = filters; m.score = s; m.tier = t; m.rescored_at = new Date().toISOString();
  after[t] = (after[t] || 0) + 1;
  fs.writeFileSync(p, JSON.stringify(m, null, 2));
}
console.log(`rescored ${changed} changed. before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
