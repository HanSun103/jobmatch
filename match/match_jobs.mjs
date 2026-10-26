#!/usr/bin/env node
// Evaluate every fetched job (data/jobs/<id>.json with status "ok") against data/profile.json.
// One structured Claude call per job -> data/matches/<id>.json containing the full trace:
// extracted requirements, per-requirement verdict + evidence pointers, deterministic score, tier.
//
// usage: node match/match_jobs.mjs [--limit N] [--only id,id] [--concurrency 3] [--force]
// Credentials: ANTHROPIC_API_KEY env var, or an `ant auth login` profile (SDK resolves both).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { JobEvaluation } from "./schema.mjs";
import { hardFilters, score, tier } from "./score.mjs";
import { qualityFilters } from "../collect/quality.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Minimal .env loader (ANTHROPIC_API_KEY=... in jobmatch/.env); real env vars win.
const ENV_FILE = path.join(ROOT, ".env");
if (fs.existsSync(ENV_FILE)) for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const OUT_DIR = path.join(ROOT, "data", "matches");
const MODEL = process.env.JOBMATCH_MODEL || "claude-opus-5-5";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const LIMIT = Number(opt("--limit", 1e9));
const ONLY = opt("--only", null)?.split(",").filter(Boolean);
const CONC = Number(opt("--concurrency", 3));
const FORCE = args.includes("--force");

const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "profile.json"), "utf8"));
// Strip chatter the model does not need; keep everything evidence-bearing.
const { open_questions, answered_questions_log, sources, ...profileForModel } = profile;

const SYSTEM = [
  {
    type: "text",
    text: `You evaluate job postings against ONE candidate's capacity profile. You are strict and evidence-bound.

Rules:
- Extract the posting's real requirements (3-18). Mark "must" only when the posting says required / must / minimum / need; otherwise "nice".
- For each requirement give a verdict:
  met      = profile has direct evidence at the needed level
  partial  = adjacent or weaker evidence (listed-only skill, basic level, academic only, different tool in same class)
  gap      = nothing relevant in the profile
  unknown  = the requirement is vague or unverifiable (e.g. "passion for X")
- The "evidence" array must contain ONLY pointer strings copied verbatim from the profile's evidence fields (they look like resume:exp:jk:b4, variant:han:jk:pricing, github:HanSun103/<repo>:README, qa:2026-10-23:Q5). Never invent pointers. Leave it empty for gap/unknown.
- Judge seniority from scope and years in the text, not LinkedIn's label. "Senior" with 3-5 years and no people management is "senior"; 8+ years, org-wide ownership or "staff/principal" wording is "staff_principal".
- canada_based_ok: true for Canadian employers/locations; for US or global remote roles, true only if the text explicitly includes Canada. US-only remote is false.
- The pitch must cite concrete profile facts (projects, metrics, tools). No generic enthusiasm.
- red_flags lists concrete mismatches only; empty array if none.

Candidate profile (JSON):
${JSON.stringify(profileForModel)}`,
    cache_control: { type: "ephemeral" },
  },
];

const client = new Anthropic();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(job) {
  const userText = `Job posting ${job.id}
Title: ${job.title}
Company: ${job.company}
Location (LinkedIn): ${job.location}
LinkedIn criteria: ${JSON.stringify(job.criteria || {})}
Posted: ${job.posted_date || job.posted_relative || "unknown"}

Description:
${job.description}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await client.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: "high", format: zodOutputFormat(JobEvaluation) },
        system: SYSTEM,
        messages: [{ role: "user", content: userText }],
      });
      if (res.stop_reason === "refusal") return { error: "refusal", detail: res.stop_details };
      if (!res.parsed_output) return { error: "parse_failed", stop_reason: res.stop_reason };
      return { evaluation: res.parsed_output, usage: res.usage, model: res.model };
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError || (e instanceof Anthropic.APIError && e.status >= 500) || e instanceof Anthropic.APIConnectionError) {
        const wait = 5000 * attempt; console.log(`  ${job.id}: ${e.constructor.name}, retry in ${wait / 1000}s`); await sleep(wait); continue;
      }
      throw e;
    }
  }
  return { error: "gave_up" };
}

function validateEvidence(ev, pointerSet) {
  // Drop any pointer the model invented; record how many were dropped.
  let dropped = 0;
  const clean = (arr) => arr.filter((p) => { const ok = pointerSet.has(p); if (!ok) dropped++; return ok; });
  for (const r of ev.requirements) r.evidence = clean(r.evidence);
  ev.domain_fit.evidence = clean(ev.domain_fit.evidence);
  return dropped;
}

function collectPointers(obj, set = new Set()) {
  if (Array.isArray(obj)) obj.forEach((x) => collectPointers(x, set));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) {
    if (k === "evidence" || k.endsWith("_evidence")) (v || []).forEach((p) => typeof p === "string" && set.add(p));
    else collectPointers(v, set);
  }
  return set;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pointerSet = collectPointers(profile);
  let prefiltered = 0;
  const jobs = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json") && f !== "cards.json")
    .map((f) => JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8")))
    .filter((j) => j.status === "ok" && j.description && (!ONLY || ONLY.includes(j.id)))
    .filter((j) => FORCE || !fs.existsSync(path.join(OUT_DIR, `${j.id}.json`)))
    .filter((j) => {
      // Quality alone (excluded company, stale original date) decides without spending an evaluation.
      const qf = qualityFilters(j.quality);
      if (!qf.length) return true;
      fs.writeFileSync(path.join(OUT_DIR, `${j.id}.json`), JSON.stringify({ id: j.id, title: j.title, company: j.company, location: j.location, url: j.url, posted_date: j.posted_date || null, source: j.source || "linkedin", hits: j.hits, evaluated_at: new Date().toISOString(), status: "prefiltered", quality: j.quality, filters: qf, tier: "filtered_out" }, null, 2));
      prefiltered++; return false;
    })
    .slice(0, LIMIT);
  console.log(`${jobs.length} jobs to evaluate with ${MODEL}, concurrency ${CONC}, ${pointerSet.size} known evidence pointers; ${prefiltered} prefiltered by quality`);

  let done = 0, usage = { input: 0, cached: 0, output: 0 };
  const queue = [...jobs];
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      const t0 = Date.now();
      const r = await evaluate(job);
      const out = { id: job.id, title: job.title, company: job.company, location: job.location, url: job.url, posted_date: job.posted_date || null, source: job.source || "linkedin", hits: job.hits, evaluated_at: new Date().toISOString(), model: r.model || MODEL, quality: job.quality || null };
      if (r.error) { out.status = "error"; out.error = r.error; out.detail = r.detail || r.stop_reason || null; }
      else {
        const ev = r.evaluation;
        out.invented_pointers_dropped = validateEvidence(ev, pointerSet);
        out.evaluation = ev;
        out.filters = hardFilters(ev, profile, { quality: job.quality });
        out.score = score(ev, profile);
        out.tier = tier(out.score.total, out.filters);
        out.status = "ok";
        usage.input += r.usage.input_tokens; usage.cached += r.usage.cache_read_input_tokens || 0; usage.output += r.usage.output_tokens;
      }
      fs.writeFileSync(path.join(OUT_DIR, `${job.id}.json`), JSON.stringify(out, null, 2));
      done++;
      console.log(`${done}/${jobs.length} ${job.id} ${out.status} ${out.tier || out.error} ${out.score?.total ?? ""} ${(Date.now() - t0) / 1000 | 0}s  ${job.title} @ ${job.company}${out.filters?.length ? "  [" + out.filters.join("; ") + "]" : ""}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`done. tokens: input ${usage.input}, cache_read ${usage.cached}, output ${usage.output}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
