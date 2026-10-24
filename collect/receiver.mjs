#!/usr/bin/env node
// Local receiver for browser-side collection. The LinkedIn tab (logged-in or guest session,
// which is not rate-limited like a bare script) fetches job HTML and POSTs parsed jobs here;
// this writes data/jobs/<id>.json merged with the card record. Loopback only.
// usage: node collect/receiver.mjs [--port 8765]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const JOBS_DIR = path.join(ROOT, "data", "jobs");
const CARDS = path.join(JOBS_DIR, "cards.json");
const pi = process.argv.indexOf("--port");
const PORT = pi >= 0 ? Number(process.argv[pi + 1]) : 8765;
const cards = new Map(JSON.parse(fs.readFileSync(CARDS, "utf8")).cards.map((c) => [c.id, c]));

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "content-type", "Content-Type": "application/json" };
let received = 0;
const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (req.method === "GET" && req.url === "/ping") { res.writeHead(200, cors); return res.end(JSON.stringify({ ok: true, received })); }
  if (req.method === "GET" && req.url === "/todo") {
    // ids that still need a description: in cards.json, not yet on disk
    const todo = [...cards.values()].filter((c) => !fs.existsSync(path.join(JOBS_DIR, `${c.id}.json`))).map((c) => c.id);
    res.writeHead(200, cors); return res.end(JSON.stringify(todo));
  }
  if (req.method === "POST" && req.url === "/job") {
    let body = ""; req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const j = JSON.parse(body);
        if (!/^\d+$/.test(j.id)) throw new Error("bad id");
        const card = cards.get(j.id) || {};
        const out = { ...card, ...j, title: j.title || card.title, company: j.company || card.company, location: j.location || card.card_location, fetched_at: new Date().toISOString(), status: j.description ? "ok" : "no_description", source: "browser" };
        fs.writeFileSync(path.join(JOBS_DIR, `${j.id}.json`), JSON.stringify(out, null, 2));
        received++; console.log(`${received} ${j.id} ${out.status} ${j.description?.length ?? 0}ch  ${out.title} @ ${out.company}`);
        res.writeHead(200, cors); res.end(JSON.stringify({ ok: true }));
      } catch (e) { res.writeHead(400, cors); res.end(JSON.stringify({ error: String(e) })); }
    });
    return;
  }
  res.writeHead(404, cors); res.end("{}");
});
server.listen(PORT, "127.0.0.1", () => console.log(`receiver on http://127.0.0.1:${PORT}  (${cards.size} cards known)`));
