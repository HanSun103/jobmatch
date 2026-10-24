#!/usr/bin/env node
// Write data/jobs/<id>.json from a batch of jobs parsed in the browser tab
// (array of {id,title,company,location,posted,applicants,criteria,description}).
// Also: --todo prints the ids still needing a description (skip-by-title applied, stubs written).
// usage: node collect/ingest_browser_batch.mjs data/raw/linkedin/desc_1.json [...]
//        node collect/ingest_browser_batch.mjs --todo [--n 12]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const cards = new Map(JSON.parse(fs.readFileSync(path.join(JOBS_DIR, "cards.json"), "utf8")).cards.map((c) => [c.id, c]));
const SKIP_TITLE = /\b(intern|co-?op|stage|stagiaire|director|principal|staff|head of|vp|vice president|manager|chief|architect)\b|people scientist|ecologist|annotation|labell?ing|subject matter expert|product manager|account executive|programme de stages|intern program/i;
const exists = (id) => fs.existsSync(path.join(JOBS_DIR, `${id}.json`));

const args = process.argv.slice(2);
if (args.includes("--todo")) {
  const n = Number(args[args.indexOf("--n") + 1] || 12);
  let skipped = 0;
  for (const c of cards.values()) if (!exists(c.id) && SKIP_TITLE.test(c.title)) {
    fs.writeFileSync(path.join(JOBS_DIR, `${c.id}.json`), JSON.stringify({ ...c, status: "skipped_title", skip_reason: c.title.match(SKIP_TITLE)[0], fetched_at: null }, null, 2)); skipped++;
  }
  const todo = [...cards.values()].filter((c) => !exists(c.id)).map((c) => c.id);
  console.log(JSON.stringify({ skipped_now: skipped, remaining: todo.length, next: todo.slice(0, n) }));
  process.exit(0);
}

let n = 0;
for (const file of args) {
  const raw = fs.readFileSync(file, "utf8");
  // Persisted tool results carry a trailing "(captured at origin ...)" line after the JSON.
  let data = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
  // Persisted tool-result format: [{type:"text", text:"<json>"}]
  if (Array.isArray(data) && data[0]?.type === "text" && typeof data[0].text === "string") {
    const t = data[0].text; // inner JSON array, followed by "(captured at origin ...)"
    data = JSON.parse(t.slice(t.indexOf("["), t.lastIndexOf("]") + 1));
  }
  for (const j of data) {
    if (!/^\d+$/.test(j.id)) continue;
    const card = cards.get(j.id) || {};
    const out = { ...card, ...j, url: `https://www.linkedin.com/jobs/view/${j.id}/`, title: j.title || card.title, company: j.company || card.company, location: j.location || card.card_location,
      posted_relative: j.posted ?? null, description_chars: j.description?.length ?? 0, fetched_at: new Date().toISOString(), status: j.error ? "error" : j.description ? "ok" : "no_description", source: "browser" };
    delete out.posted;
    fs.writeFileSync(path.join(JOBS_DIR, `${j.id}.json`), JSON.stringify(out, null, 2)); n++;
  }
}
console.log(`ingested ${n} jobs; files on disk: ${fs.readdirSync(JOBS_DIR).filter((f) => /^\d+\.json$/.test(f)).length}`);
