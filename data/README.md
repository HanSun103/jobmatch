# data/

Local only; everything here except this file is git-ignored.

- `profile.json`  capacity profile (skills, projects, targets, constraints), every claim with evidence pointers
- `raw/`          resume text dumps, resume-variant index, Q&A log, GitHub scan, LinkedIn card batches, system prompt
- `jobs/`         `cards.json` plus one JSON per LinkedIn job id (description, criteria, status)
- `matches/`      one evaluation trace per job (requirements -> verdict -> evidence -> score -> tier)

Rebuild from scratch: write `profile.json` by hand following the evidence-pointer convention in the
root README, then run the Pipeline steps there.
