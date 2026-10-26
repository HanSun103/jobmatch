# jobmatch

Personal job-search pipeline: collect LinkedIn postings, model my capacity from
resume + projects + Q&A, match the two with an auditable trace, and render a "why I fit" report.

## Layout

```
collect/   LinkedIn collection (browser-driven card lists; description fetch), employer board APIs
           (collect/boards/: greenhouse, ashby, lever, workday), posting-quality rules (quality.mjs)
profile/   (reserved) capacity profile builder; today profile.json is hand-assembled from data/raw
match/     requirement extraction + evidence matching (Claude) -> data/matches/<id>.json
report/    renders ranked report with per-requirement verdicts and gaps -> report/out/
data/
  raw/       resume text dumps, resume-variant index, Q&A log, GitHub scan, LinkedIn card batches
  jobs/      cards.json (all cards seen) + one JSON per job (LinkedIn numeric id, or gh-/ab-/lv-/wd- board id)
  jobs/boards/  one listing per employer board (all postings + candidates with descriptions)
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

# 2b. Employer boards (collect/boards.json): one JSON call per Greenhouse/Ashby/Lever board, a few
#     per Workday site. Saves every posting (with its true first-published date) and the candidates
#     that fit the title/location rules, descriptions included. No LinkedIn rate limit involved.
node collect/fetch_boards.mjs [--only stripe,td]

# 2c. Posting quality: writes `quality` on every job file (original date, age, repost, excluded
#     company, applicants), links LinkedIn postings to their board record, and materialises board
#     postings LinkedIn never showed as new jobs. Re-run after 2/2b or after editing collect/quality.json.
node collect/assess_quality.mjs [--dry-run]

# 3. Match. Two equivalent runners (same schema, same scoring). Jobs that quality alone excludes
#    (excluded company, stale) get a `prefiltered` stub and never cost an evaluation.
#    a) on the Claude subscription via Claude Code headless mode (no API key; ~20 s/job):
node match/match_jobs_cli.mjs [--limit 5] [--concurrency 3]      # env JOBMATCH_MODEL=sonnet|opus, JOBMATCH_EFFORT=high
#    b) on the API (needs ANTHROPIC_API_KEY in .env; model default claude-opus-5-5):
node match/match_jobs.mjs [--limit 5] [--concurrency 3]

# 4. Report
node match/rescore.mjs              # only after changing score.mjs / quality rules; no API calls
node report/build_report.mjs        # -> report/out/report.md + report.html
```

Scoring is deterministic from the trace (match/score.mjs): must-have coverage 45%, nice-to-have 10%,
title-family fit 15%, seniority fit 10%, work mode 5%, domain fit 15%, minus a penalty per extra
must-have gap. Hard filters (seniority above band, senior engineering, >6 yrs, not Canada-eligible,
clearance/citizenship, French-required, off-location onsite, plus the quality rules below) move a job
to `filtered_out` regardless. Change weights and re-run `rescore.mjs` + `build_report.mjs` without any API calls.

## Posting quality (collect/quality.json)

LinkedIn's "posted N days ago" is refreshable, so it says nothing about how long an opening has
really existed. Three signals fix that, combined in `collect/quality.mjs`:

1. **LinkedIn id -> creation date.** Job ids are sequential. `collect/id_anchors.json` pairs ids with
   known dates (from board postings matched to the same opening); the estimate interpolates between
   anchors and the current frontier (newest card). Accuracy observed: within about a week.
2. **Board first-published date.** Greenhouse `first_published`, Ashby `publishedAt`, Lever `createdAt`,
   Workday `startDate`, for every company in `collect/boards.json` (matched by company name + title).
3. **Applicant count** from the LinkedIn page, shown in the report (200+ is itself a staleness hint).

`original_date` = earliest of the three. Rules: `max_age_days` (default 30) filters the posting out as
stale; `repost_days` (14) flags it as a repost (↻ in the report) when LinkedIn's date is that much later
than the original; `exclude_companies` drops gig / AI-training / freelance marketplaces (Alignerr,
Outlier, Mercor, Toptal, ...); `skip_title_pattern` never fetches titles outside the target band.
`cards.json` also records `first_seen` / `last_seen` per card, so repeated crawls reveal re-listings.

## Resume point (2026-10-26)

LinkedIn: 279 cards, 212 described, 67 skipped by title. Boards: 18 employers, ~2 400 postings,
44 LinkedIn postings linked to their board record, 62 board-only postings added (35 stale, 27 evaluated).
After the quality rules the LinkedIn set is strong 25 / good 24 / stretch 9 / weak 7 / filtered 147.
Weekly refresh: re-run the LinkedIn searches in the browser, `merge_cards` -> `fetch_descriptions`,
then `fetch_boards` -> `assess_quality` -> `match_jobs_cli` -> `build_report`. Every step skips what is
already on disk.

## Runtime

Node 24 (`uv` is also present; there is no system Python). Dependencies: `@anthropic-ai/sdk`, `zod`.
