#!/usr/bin/env node
// Merge browser-extracted card batches into data/jobs/cards.json (dedup by id, keep all search tags).
// usage: node collect/merge_cards.mjs data/raw/linkedin/batch1.json [more.json ...]
// batch file: [{ tag: "search|loc", total: "822", cards: ["id|title|company|location|posted", ...] }, ...]
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const OUT = path.join(ROOT, "data", "jobs", "cards.json");
const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { collected_at: null, searches: {}, cards: [] };
const byId = new Map(existing.cards.map((c) => [c.id, c]));

for (const file of process.argv.slice(2)) {
  const batches = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const b of batches) {
    const [search, loc] = b.tag.split("|");
    existing.searches[b.tag] = { total_reported: b.total ?? null, cards_taken: b.cards.length, at: new Date().toISOString() };
    for (const [rank, line] of b.cards.entries()) {
      const [id, title, company, location, posted] = line.split("|");
      const hit = { search, loc, rank: rank + 1 };
      const prev = byId.get(id);
      const today = new Date().toISOString().slice(0, 10);
      if (prev) {
        if (!prev.hits.some((h) => h.search === search && h.loc === loc)) prev.hits.push(hit);
        // Seen again in a later crawl: keep the first date LinkedIn showed, record the refresh.
        prev.last_seen = today;
        if (posted && prev.posted_date && posted !== prev.posted_date) (prev.posted_dates_seen ||= [prev.posted_date]).push(posted);
        continue;
      }
      byId.set(id, { id, title, company, card_location: location, posted_date: posted || null, first_seen: today, last_seen: today, hits: [hit] });
    }
  }
}
existing.collected_at = new Date().toISOString();
existing.cards = [...byId.values()];
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(existing, null, 2));
console.log(`cards.json: ${existing.cards.length} unique cards from ${Object.keys(existing.searches).length} searches`);
