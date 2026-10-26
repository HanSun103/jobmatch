#!/usr/bin/env node
// Write a `quality` block onto every data/jobs/<id>.json: original posting date (earliest of LinkedIn
// date, LinkedIn-id estimate, linked board first_published), age, repost flag, excluded-company flag,
// applicant count. Also links LinkedIn postings to their board posting (same company, similar title)
// and materialises board candidates that LinkedIn never showed as new job files (ids gh-/ab-/lv-/wd-).
// Re-run after fetch_boards.mjs or after editing collect/quality.json; then match + rescore + report.
// usage: node collect/assess_quality.mjs [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessQuality, titleSim, isLinkedInId, SKIP_TITLE, qualityFilters } from "./quality.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const BOARD_DIR = path.join(JOBS_DIR, "boards");
const DRY = process.argv.includes("--dry-run");
const SIM_MIN = 0.6;

// Frontier: newest LinkedIn card and its (reliable, because fresh) posted date.
const cards = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, "cards.json"), "utf8")).cards;
const top = cards.reduce((a, c) => (!a || Number(c.id) > Number(a.id) ? c : a), null);
const frontier = top?.posted_date ? { id: top.id, date: top.posted_date } : null;

// Boards: entry + rows, keyed by provider_slug.
const boards = fs.existsSync(BOARD_DIR) ? fs.readdirSync(BOARD_DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(BOARD_DIR, f), "utf8"))) : [];
const boardFor = (company) => boards.find((b) => new RegExp(b.entry.match, "i").test((company || "").trim()));

const jobFiles = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json") && f !== "cards.json");
const jobs = jobFiles.map((f) => JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8")));
const linkedBoardIds = new Set();
const stats = { assessed: 0, linked: 0, stale: 0, repost: 0, excluded: 0, new_board_jobs: 0 };

// 1. LinkedIn jobs: link to a board row, then assess.
for (const job of jobs) {
  let ats = null;
  if (isLinkedInId(job.id)) {
    const b = boardFor(job.company);
    if (b) {
      let best = null, bestSim = 0;
      for (const r of b.all) { const s = titleSim(job.title, r.title); if (s > bestSim) { best = r; bestSim = s; } }
      if (best && bestSim >= SIM_MIN) { ats = { provider: b.entry.provider, url: best.url, first_published: best.first_published, updated_at: best.updated_at, title: best.title, board_id: best.board_id, sim: +bestSim.toFixed(2) }; linkedBoardIds.add(best.board_id); stats.linked++; }
    }
  } else if (job.ats_self) ats = job.ats_self;
  job.quality = assessQuality(job, { ats, frontier });
  stats.assessed++; if (job.quality.stale) stats.stale++; if (job.quality.repost) stats.repost++; if (job.quality.excluded_company) stats.excluded++;
  if (!DRY) fs.writeFileSync(path.join(JOBS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2));
}

// 2. Board candidates LinkedIn never showed: materialise as job files.
const existing = new Set(jobs.map((j) => j.id));
for (const b of boards) {
  for (const r of b.candidates || []) {
    if (linkedBoardIds.has(r.board_id) || existing.has(r.board_id) || SKIP_TITLE.test(r.title)) continue;
    // Same company + near-identical title as a LinkedIn posting already on disk -> treat as the same opening.
    if (jobs.some((j) => isLinkedInId(j.id) && boardFor(j.company) === b && titleSim(j.title, r.title) >= SIM_MIN)) continue;
    const job = {
      id: r.board_id, source: `board:${b.entry.provider}`, title: r.title, company: b.entry.name, location: r.location, url: r.url,
      posted_date: r.first_published ? r.first_published.slice(0, 10) : null, first_published: r.first_published || null, updated_at: r.updated_at || null,
      remote: r.remote || null, criteria: {}, applicants: null, description: r.description || null, description_chars: r.description?.length ?? 0,
      fetched_at: b.fetched_at, status: r.description ? "ok" : "no_description",
      ats_self: { provider: b.entry.provider, url: r.url, first_published: r.first_published, updated_at: r.updated_at, title: r.title },
    };
    job.quality = assessQuality(job, { ats: job.ats_self, frontier });
    stats.new_board_jobs++; if (job.quality.stale) stats.stale++;
    if (!DRY) fs.writeFileSync(path.join(JOBS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2));
  }
}
console.log(`${DRY ? "[dry-run] " : ""}frontier ${frontier?.id} @ ${frontier?.date}; ${JSON.stringify(stats)}`);
const pre = jobs.filter((j) => j.status === "ok" && qualityFilters(j.quality).length);
console.log(`ok jobs that will be filtered by quality alone: ${pre.length}`);
for (const j of pre.slice(0, 40)) console.log(`  ${j.id} ${j.company} | ${j.title} | ${qualityFilters(j.quality).join("; ")}`);
