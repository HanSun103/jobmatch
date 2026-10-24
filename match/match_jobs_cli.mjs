#!/usr/bin/env node
// Same evaluation as match_jobs.mjs, but each job is scored by `claude -p` (Claude Code headless
// mode) so it runs on the Claude subscription login instead of an API key. Structured output is
// enforced with --json-schema and validated with the same zod schema; scoring is identical.
//
// usage: node match/match_jobs_cli.mjs [--limit N] [--only id,id] [--concurrency 3] [--force]
//        env JOBMATCH_MODEL (default sonnet), JOBMATCH_EFFORT (default high)

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { JobEvaluation } from "./schema.mjs";
import { hardFilters, score, tier } from "./score.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const OUT_DIR = path.join(ROOT, "data", "matches");
const SYS_FILE = path.join(ROOT, "data", "raw", "system_prompt.txt");
const MODEL = process.env.JOBMATCH_MODEL || "sonnet";
const EFFORT = process.env.JOBMATCH_EFFORT || "high";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const LIMIT = Number(opt("--limit", 1e9));
const ONLY = opt("--only", null)?.split(",").filter(Boolean);
const CONC = Number(opt("--concurrency", 3));
const FORCE = args.includes("--force");

const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "profile.json"), "utf8"));
const { open_questions, answered_questions_log, sources, ...profileForModel } = profile;

const SYSTEM = `You evaluate job postings against ONE candidate's capacity profile. You are strict and evidence-bound. Do not use any tools; answer only with the JSON object requested.

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
${JSON.stringify(profileForModel)}`;
fs.writeFileSync(SYS_FILE, SYSTEM);

// The CLI validates with a draft-07 validator; drop zod's 2020-12 "$schema" header.
const schemaObj = z.toJSONSchema(JobEvaluation); delete schemaObj.$schema;
const SCHEMA = JSON.stringify(schemaObj);
const ENV = { ...process.env }; delete ENV.CLAUDECODE; delete ENV.CLAUDE_CODE_ENTRYPOINT;

function runClaude(prompt) {
  return new Promise((resolve) => {
    const p = spawn("claude", ["-p", "--output-format", "json", "--model", MODEL, "--effort", EFFORT, "--json-schema", SCHEMA, "--system-prompt-file", SYS_FILE], { env: ENV, windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => resolve({ code, out, err }));
    p.stdin.end(prompt);
  });
}

async function evaluate(job) {
  const prompt = `Job posting ${job.id}
Title: ${job.title}
Company: ${job.company}
Location (LinkedIn): ${job.location}
LinkedIn criteria: ${JSON.stringify(job.criteria || {})}
Posted: ${job.posted_date || job.posted_relative || "unknown"}

Description:
${job.description}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { code, out, err } = await runClaude(prompt);
    let res; try { res = JSON.parse(out); } catch { if (attempt === 2) return { error: "bad_cli_output", detail: (err || out).slice(0, 300) }; continue; }
    if (res.is_error || !res.structured_output) { if (attempt === 2) return { error: res.subtype || "no_structured_output", detail: String(res.result || err).slice(0, 300) }; continue; }
    const parsed = JobEvaluation.safeParse(res.structured_output);
    if (!parsed.success) { if (attempt === 2) return { error: "schema_mismatch", detail: parsed.error.issues.slice(0, 3) }; continue; }
    const u = res.usage || {};
    return { evaluation: parsed.data, model: Object.keys(res.modelUsage || {})[0] || MODEL, usage: { input: u.input_tokens || 0, cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, cost_estimate_usd: res.total_cost_usd || 0 } };
  }
}

function collectPointers(obj, set = new Set()) {
  if (Array.isArray(obj)) obj.forEach((x) => collectPointers(x, set));
  else if (obj && typeof obj === "object") for (const [k, v] of Object.entries(obj)) {
    if (k === "evidence" || k.endsWith("_evidence")) (v || []).forEach((p) => typeof p === "string" && set.add(p));
    else collectPointers(v, set);
  }
  return set;
}
function validateEvidence(ev, pointerSet) {
  let dropped = 0;
  const clean = (arr) => arr.filter((p) => { const ok = pointerSet.has(p); if (!ok) dropped++; return ok; });
  for (const r of ev.requirements) r.evidence = clean(r.evidence);
  ev.domain_fit.evidence = clean(ev.domain_fit.evidence);
  return dropped;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pointerSet = collectPointers(profile);
  const jobs = fs.readdirSync(JOBS_DIR).filter((f) => /^\d+\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8")))
    .filter((j) => j.status === "ok" && j.description && (!ONLY || ONLY.includes(j.id)))
    .filter((j) => FORCE || !fs.existsSync(path.join(OUT_DIR, `${j.id}.json`)))
    .slice(0, LIMIT);
  console.log(`${jobs.length} jobs to evaluate via claude -p (model ${MODEL}, effort ${EFFORT}), concurrency ${CONC}, ${pointerSet.size} known evidence pointers`);
  let done = 0, errors = 0; const usage = { input: 0, cached: 0, output: 0, cost_estimate_usd: 0 };
  const queue = [...jobs];
  async function worker() {
    while (queue.length) {
      const job = queue.shift(); const t0 = Date.now();
      const r = await evaluate(job);
      const out = { id: job.id, title: job.title, company: job.company, location: job.location, url: job.url, posted_date: job.posted_date || null, hits: job.hits, evaluated_at: new Date().toISOString(), model: r.model || MODEL, via: "claude-cli" };
      if (r.error) { out.status = "error"; out.error = r.error; out.detail = r.detail; errors++; }
      else {
        const ev = r.evaluation;
        out.invented_pointers_dropped = validateEvidence(ev, pointerSet);
        out.evaluation = ev; out.filters = hardFilters(ev, profile); out.score = score(ev, profile); out.tier = tier(out.score.total, out.filters); out.status = "ok"; out.usage = r.usage;
        for (const k of Object.keys(usage)) usage[k] += r.usage[k] || 0;
      }
      fs.writeFileSync(path.join(OUT_DIR, `${job.id}.json`), JSON.stringify(out, null, 2));
      done++;
      console.log(`${done}/${jobs.length} ${job.id} ${out.status} ${out.tier || out.error} ${out.score?.total ?? ""} ${(Date.now() - t0) / 1000 | 0}s  ${job.title} @ ${job.company}${out.filters?.length ? "  [" + out.filters.join("; ") + "]" : ""}`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log(`done: ${done - errors} ok, ${errors} errors. tokens in ${usage.input}, cached ${usage.cached}, out ${usage.output}; list-price estimate $${usage.cost_estimate_usd.toFixed(2)} (covered by subscription)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
