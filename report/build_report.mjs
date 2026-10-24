#!/usr/bin/env node
// Render data/matches/*.json into report/out/report.md and report/out/report.html.
// The "why I fit" section is read straight off each trace (requirement -> verdict -> evidence),
// so re-running this never calls the API.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATCH_DIR = path.join(ROOT, "data", "matches");
const OUT_DIR = path.join(ROOT, "report", "out");
fs.mkdirSync(OUT_DIR, { recursive: true });

const TIER_ORDER = { strong: 0, good: 1, stretch: 2, weak: 3, filtered_out: 4 };
const matches = fs.readdirSync(MATCH_DIR).filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(MATCH_DIR, f), "utf8")))
  .filter((m) => m.status === "ok")
  .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.score.total - a.score.total);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const mark = { met: "✅", partial: "🟡", gap: "❌", unknown: "❔" };
const counts = Object.fromEntries(Object.keys(TIER_ORDER).map((t) => [t, matches.filter((m) => m.tier === t).length]));

// ---------- Markdown ----------
let md = `# Job matches — ${new Date().toISOString().slice(0, 10)}\n\n`;
md += `${matches.length} evaluated · strong ${counts.strong} · good ${counts.good} · stretch ${counts.stretch} · weak ${counts.weak} · filtered out ${counts.filtered_out}\n\n`;
md += `| # | Tier | Score | Title | Company | Location | Mode | Seniority | Must gaps |\n|---|---|---|---|---|---|---|---|---|\n`;
matches.forEach((m, i) => {
  const ev = m.evaluation;
  md += `| ${i + 1} | ${m.tier} | ${m.score.total} | [${m.title}](${m.url}) | ${m.company} | ${ev.location_city ?? m.location} | ${ev.work_mode} | ${ev.seniority} | ${m.score.components.must_gaps} |\n`;
});
md += `\n---\n\n`;
for (const m of matches.filter((x) => x.tier !== "filtered_out")) {
  const ev = m.evaluation;
  md += `## ${m.title} — ${m.company}  (${m.tier}, ${m.score.total})\n\n`;
  md += `${m.url}  \n${ev.location_city ?? m.location} · ${ev.work_mode} · ${ev.seniority} · ${ev.employment_type}${ev.years_required ? ` · ${ev.years_required}+ yrs` : ""}\n\n`;
  md += `**Role.** ${ev.job_summary}\n\n**Why I fit.** ${ev.pitch}\n\n`;
  md += `| Requirement | Kind | Verdict | Evidence | Reasoning |\n|---|---|---|---|---|\n`;
  for (const r of ev.requirements) md += `| ${r.text} | ${r.kind} | ${mark[r.verdict]} ${r.verdict} | ${r.evidence.join(", ")} | ${r.reasoning} |\n`;
  md += `\nDomain fit: ${mark[ev.domain_fit.verdict]} ${ev.domain_fit.reasoning}\n\n`;
  if (ev.red_flags.length) md += `Red flags: ${ev.red_flags.join("; ")}\n\n`;
  md += `Score components: ${Object.entries(m.score.components).map(([k, v]) => `${k}=${v}`).join(", ")}\n\n---\n\n`;
}
if (counts.filtered_out) {
  md += `## Filtered out\n\n`;
  for (const m of matches.filter((x) => x.tier === "filtered_out")) md += `- [${m.title}](${m.url}) — ${m.company}: ${m.filters.join("; ")}\n`;
}
fs.writeFileSync(path.join(OUT_DIR, "report.md"), md);

// ---------- HTML ----------
const row = (m, i) => {
  const ev = m.evaluation;
  return `<tr class="t-${m.tier}"><td>${i + 1}</td><td><span class="tier ${m.tier}">${m.tier.replace("_", " ")}</span></td><td class="num">${m.score.total}</td>
<td><a href="#j${m.id}">${esc(m.title)}</a></td><td>${esc(m.company)}</td><td>${esc(ev.location_city ?? m.location)}</td><td>${ev.work_mode}</td><td>${ev.seniority}</td><td class="num">${m.score.components.must_gaps}</td></tr>`;
};
const detail = (m) => {
  const ev = m.evaluation;
  return `<section id="j${m.id}" class="job t-${m.tier}">
<h2>${esc(m.title)} <small>${esc(m.company)}</small> <span class="tier ${m.tier}">${m.tier.replace("_", " ")} · ${m.score.total}</span></h2>
<p class="meta"><a href="${m.url}" target="_blank" rel="noopener">LinkedIn ↗</a> · ${esc(ev.location_city ?? m.location)} · ${ev.work_mode} · ${ev.seniority} · ${ev.employment_type}${ev.years_required ? ` · ${ev.years_required}+ yrs` : ""}${m.posted_date ? ` · posted ${m.posted_date}` : ""}</p>
<p><b>Role.</b> ${esc(ev.job_summary)}</p>
<p class="pitch"><b>Why I fit.</b> ${esc(ev.pitch)}</p>
<table class="req"><thead><tr><th>Requirement</th><th>Kind</th><th>Verdict</th><th>Evidence</th><th>Reasoning</th></tr></thead><tbody>
${ev.requirements.map((r) => `<tr class="v-${r.verdict}"><td>${esc(r.text)}</td><td>${r.kind}</td><td>${mark[r.verdict]} ${r.verdict}</td><td class="ev">${r.evidence.map(esc).join("<br>")}</td><td>${esc(r.reasoning)}</td></tr>`).join("\n")}
</tbody></table>
<p><b>Domain fit:</b> ${mark[ev.domain_fit.verdict]} ${esc(ev.domain_fit.reasoning)}</p>
${m.filters.length ? `<p class="flag"><b>Filtered:</b> ${m.filters.map(esc).join("; ")}</p>` : ""}
${ev.red_flags.length ? `<p class="flag"><b>Red flags:</b> ${ev.red_flags.map(esc).join("; ")}</p>` : ""}
<p class="comp">score = ${Object.entries(m.score.components).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>
</section>`;
};
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job matches</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--line:#e3e3e3;--strong:#1b7f3b;--good:#2962ff;--stretch:#b26a00;--weak:#8a8a8a;--filtered:#c62828;--pitch:#f4f7fb}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#121212;--fg:#eee;--muted:#aaa;--line:#333;--pitch:#1c2430}}
:root[data-theme=dark]{--bg:#121212;--fg:#eee;--muted:#aaa;--line:#333;--pitch:#1c2430}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:1200px;margin-inline:auto}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
.num{text-align:right}.tier{padding:2px 8px;border-radius:12px;color:#fff;font-size:12px;white-space:nowrap}
.tier.strong{background:var(--strong)}.tier.good{background:var(--good)}.tier.stretch{background:var(--stretch)}.tier.weak{background:var(--weak)}.tier.filtered_out{background:var(--filtered)}
.job{border-top:2px solid var(--line);margin-top:32px;padding-top:12px}.job h2 small{color:var(--muted);font-weight:normal;font-size:.8em}
.meta,.comp{color:var(--muted);font-size:13px}.pitch{background:var(--pitch);padding:10px 12px;border-radius:8px}
.req .ev{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--muted)}
.v-gap td:nth-child(3){color:var(--filtered)}.v-met td:nth-child(3){color:var(--strong)}
.flag{color:var(--filtered)}.summary{color:var(--muted)}
.filters label{margin-right:12px}
@media(max-width:700px){.req{display:block;overflow-x:auto}}
</style></head><body>
<h1>Job matches <small class="summary">${new Date().toISOString().slice(0, 10)}</small></h1>
<p class="summary">${matches.length} evaluated · strong ${counts.strong} · good ${counts.good} · stretch ${counts.stretch} · weak ${counts.weak} · filtered out ${counts.filtered_out}</p>
<p class="filters">${Object.keys(TIER_ORDER).map((t) => `<label><input type="checkbox" data-tier="${t}" ${t === "weak" || t === "filtered_out" ? "" : "checked"}> ${t.replace("_", " ")}</label>`).join("")}</p>
<table id="list"><thead><tr><th>#</th><th>Tier</th><th>Score</th><th>Title</th><th>Company</th><th>Location</th><th>Mode</th><th>Seniority</th><th>Must gaps</th></tr></thead><tbody>
${matches.map(row).join("\n")}
</tbody></table>
${matches.map(detail).join("\n")}
<script>
const boxes=[...document.querySelectorAll('input[data-tier]')];
function apply(){const on=new Set(boxes.filter(b=>b.checked).map(b=>b.dataset.tier));for(const t of Object.keys(${JSON.stringify(TIER_ORDER)})){document.querySelectorAll('.t-'+t).forEach(el=>el.style.display=on.has(t)?'':'none')}}
boxes.forEach(b=>b.addEventListener('change',apply));apply();
</script></body></html>`;
fs.writeFileSync(path.join(OUT_DIR, "report.html"), html);
console.log(`report: ${matches.length} matches -> report/out/report.md, report/out/report.html  (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")})`);
