# jobmatch

Personal job-search pipeline: collect LinkedIn postings, model my capacity from
resume + projects + Q&A, match the two with an auditable trace, and render a "why I fit" report.

## Layout

```
collect/   LinkedIn collection (browser-driven card lists; description fetch)
profile/   (reserved) capacity profile builder; today profile.json is hand-assembled from data/raw
match/     requirement extraction + evidence matching (Claude API) -> data/matches/<id>.json
report/    renders ranked report with per-requirement verdicts and gaps -> report/out/
data/
  raw/       resume text dumps, resume-variant index, Q&A log, GitHub scan, LinkedIn card batches
  jobs/      cards.json (all cards seen) + one JSON per LinkedIn job id
  matches/   one trace JSON per evaluated job (requirements -> verdict -> evidence -> score)
  profile.json
```

## Evidence pointer convention

Every skill / claim in `profile.json` carries `evidence: [...]` entries such as

- `resume:exp:jk:b3`        3rd bullet under J&K Scientific in the primary resume (data/raw/resume_han-sun-ds.md)
- `variant:han:jk:pricing`  a bullet in another resume variant (data/raw/variants/INDEX.md)
- `github:HanSun103/<repo>:README`  public repo README (data/raw/github/SCAN.md)
- `qa:2026-10-23:Q5`        answer given in a Q&A session (data/raw/qa_2026-10-23.md)

The matcher may only cite pointers that exist in the profile; invented ones are dropped and counted.
The report reads the trace, so "why I fit" is replayed, not re-generated.

## Pipeline

```bash
# 1. Card lists: run the searches in collect/searches.json in the in-app browser (guest job search
#    pages work without login) and save each result set as data/raw/linkedin/batchN.json, then:
node collect/merge_cards.mjs data/raw/linkedin/batch1.json data/raw/linkedin/batch2.json ...

# 2. Descriptions. Two channels, both rate-limited by LinkedIn (~45 quick requests, then 429s;
#    refills over ~10 min). Either runs unattended and skips ids already on disk:
node collect/fetch_descriptions.mjs --delay-ms 7000          # local guest endpoint, slow but hands-off
node collect/ingest_browser_batch.mjs --todo --n 40          # ids to fetch from the browser tab;
#    fetch+parse them in the LinkedIn tab (snippet in collect/browser_fetch.js), save the result
#    JSON, then:
node collect/ingest_browser_batch.mjs data/raw/linkedin/desc_N.json

# 3. Match. Two equivalent runners (same schema, same scoring):
#    a) on the Claude subscription via Claude Code headless mode (no API key; ~20 s/job):
node match/match_jobs_cli.mjs [--limit 5] [--concurrency 3]      # env JOBMATCH_MODEL=sonnet|opus, JOBMATCH_EFFORT=high
#    b) on the API (needs ANTHROPIC_API_KEY in .env; model default claude-opus-5-5):
node match/match_jobs.mjs [--limit 5] [--concurrency 3]

# 4. Report
node report/build_report.mjs        # -> report/out/report.md + report.html
```

Scoring is deterministic from the trace (match/score.mjs): must-have coverage 45%, nice-to-have 10%,
title-family fit 15%, seniority fit 10%, work mode 5%, domain fit 15%, minus a penalty per extra
must-have gap. Hard filters (seniority above band, senior engineering, >6 yrs, not Canada-eligible,
clearance/citizenship, French-required, off-location onsite) move a job to `filtered_out` regardless.
Change weights and re-run `build_report.mjs` without any API calls.

## Resume point (2026-10-23)

Collection complete: 279 cards, 212 with full descriptions, 67 skipped by title, 0 failures.
Next: steps 3 and 4 above once an API key is in `.env` (matcher on hold until Han says go).
Re-collecting later: re-run the searches, merge new batches, then `node collect/fetch_descriptions.mjs --delay-ms 7000`
(it only fetches ids not yet on disk).

## Runtime

Node 24 (`uv` is also present; there is no system Python). Dependencies: `@anthropic-ai/sdk`, `zod`.
