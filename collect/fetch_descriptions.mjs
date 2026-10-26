#!/usr/bin/env node
// Fetch full job descriptions for cards listed in data/jobs/cards.json using
// LinkedIn's public guest job-posting endpoint (no login). Writes one JSON per
// job to data/jobs/<id>.json, skipping ids already present. Paced; backs off on 429.
//
// usage: node collect/fetch_descriptions.mjs [--limit N] [--delay-ms 3500] [--only id,id]

import fs from "node:fs";
import path from "node:path";
import { writeSkipStubs } from "./quality.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const CARDS = path.join(JOBS_DIR, "cards.json");

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const LIMIT = Number(opt("--limit", 1e9));
const DELAY = Number(opt("--delay-ms", 3500));
const ONLY = opt("--only", null)?.split(",").filter(Boolean);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}
function htmlToText(html) {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div|h\d|ul|ol)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, "")
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function first(html, re) { const m = html.match(re); return m ? decode(m[1].replace(/<[^>]+>/g, "")).trim() : null; }

function parseJob(id, html) {
  const title = first(html, /topcard__title[^>]*>([\s\S]*?)<\/h2>/);
  const company = first(html, /topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/) || first(html, /topcard__flavor[^>]*>([\s\S]*?)<\//);
  const location = first(html, /topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/);
  const posted = first(html, /posted-time-ago__text[^>]*>([\s\S]*?)<\/span>/);
  const applicants = first(html, /num-applicants__caption[^>]*>([\s\S]*?)<\//);
  const descM = html.match(/<div class="description__text description__text--rich">([\s\S]*?)<\/div>\s*<\/section>/)
    || html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/);
  const description = descM ? htmlToText(descM[1]).replace(/\n*\s*(显示更多|Show more|显示较少|Show less)\s*$/g, "").trim() : null;
  const criteria = {};
  const critRe = /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/g;
  let m; while ((m = critRe.exec(html))) criteria[decode(m[1]).trim()] = decode(m[2].replace(/<[^>]+>/g, "")).trim();
  const applyUrl = first(html, /<code id="applyUrl"[^>]*>\s*<!--"?([\s\S]*?)"?-->/);
  return { id, url: `https://www.linkedin.com/jobs/view/${id}/`, title, company, location, posted_relative: posted, applicants, criteria, apply_url: applyUrl, description, description_chars: description?.length ?? 0 };
}

async function fetchJob(id) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, {
      headers: { "User-Agent": UA, "Accept-Language": "en-CA,en;q=0.9" },
    });
    if (res.status === 200) return await res.text();
    if (res.status === 404) return null;
    const wait = res.status === 429 ? 60000 * attempt : 10000;
    console.log(`  ${id}: http ${res.status}, waiting ${wait / 1000}s (attempt ${attempt})`);
    await sleep(wait);
  }
  throw new Error(`gave up on ${id}`);
}

async function main() {
  const cards = JSON.parse(fs.readFileSync(CARDS, "utf8")).cards;
  const { skipped, skipped_by } = writeSkipStubs(cards, JOBS_DIR);
  const todo = cards.filter((c) => (!ONLY || ONLY.includes(c.id)) && !fs.existsSync(path.join(JOBS_DIR, `${c.id}.json`))).slice(0, LIMIT);
  console.log(`${cards.length} cards, ${skipped} newly skipped (${JSON.stringify(skipped_by)}), ${todo.length} to fetch, delay ${DELAY}ms`);
  let ok = 0, fail = 0;
  for (const [i, c] of todo.entries()) {
    try {
      const html = await fetchJob(c.id);
      if (!html) { console.log(`${i + 1}/${todo.length} ${c.id} 404 (expired)`); fs.writeFileSync(path.join(JOBS_DIR, `${c.id}.json`), JSON.stringify({ ...c, fetched_at: new Date().toISOString(), status: "expired" }, null, 2)); continue; }
      const job = parseJob(c.id, html);
      const out = { ...c, ...job, title: job.title || c.title, company: job.company || c.company, location: job.location || c.location, fetched_at: new Date().toISOString(), status: job.description ? "ok" : "no_description" };
      fs.writeFileSync(path.join(JOBS_DIR, `${c.id}.json`), JSON.stringify(out, null, 2));
      ok++; console.log(`${i + 1}/${todo.length} ${c.id} ${out.status} ${out.description_chars}ch  ${out.title} @ ${out.company}`);
    } catch (e) { fail++; console.log(`${i + 1}/${todo.length} ${c.id} FAILED ${e.message}`); if (fail >= 5) { console.log("too many failures, stopping"); break; } }
    if (i < todo.length - 1) await sleep(DELAY + Math.floor(Math.random() * 1500));
  }
  console.log(`done: ${ok} ok, ${fail} failed`);
}
main();
