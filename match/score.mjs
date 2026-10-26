// Deterministic scoring and hard filters over a JobEvaluation + profile targets.
// Everything here is replayable from the trace: change weights, re-run, no API calls.
import { qualityFilters } from "../collect/quality.mjs";

const FAMILY_RANK = {
  data_scientist: 1, analytics: 1,
  ml_ai_scientist: 2, research_scientist: 2, model_validation: 2,
  ml_engineer: 3, data_engineer: 3, ai_engineer: 3,
  economist: 4,
  business_analyst: 5, other: 6,
};
const VERDICT_POINTS = { met: 1, partial: 0.5, gap: 0, unknown: 0.25 };

// `meta` carries posting-level facts the evaluation does not know: meta.quality is the block written by
// collect/assess_quality.mjs (original date, age, repost, excluded company, applicants).
export function hardFilters(ev, profile, meta = {}) {
  const out = qualityFilters(meta.quality);
  // Seniority band: mid-level target; engineering only junior/intermediate.
  const eng = ["ml_engineer", "data_engineer", "ai_engineer"].includes(ev.title_family);
  if (["staff_principal", "manager"].includes(ev.seniority)) out.push(`seniority ${ev.seniority} is above target band`);
  if (eng && ["senior", "lead"].includes(ev.seniority)) out.push(`senior engineering role; profile targets junior/intermediate engineering only`);
  if (ev.years_required != null && ev.years_required > 6) out.push(`${ev.years_required}+ years required vs ~3.5 available`);
  if (!ev.canada_based_ok) out.push("not open to Canada-based candidates");
  if (ev.employment_type === "internship") out.push("internship");
  // Authorization: the note is free text and often says "no requirement stated", so only a positive,
  // PR-excluding requirement filters: citizenship required, or a Secret-level clearance. Reliability
  // status is open to permanent residents, so it stays a red flag in the trace, not a filter.
  const auth = (ev.authorization_note || "").toLowerCase();
  const authSentences = auth.split(/[.;]/).filter((s) => !/\b(no|none|not|non-discrimination|equal opportunity|permanent resident)\b/.test(s));
  if (authSentences.some((s) => /(citizens? (only|required)|must be (a )?canadian citizen|canadian citizenship (is )?required|citizenship required|secret clearance|top secret)/.test(s)))
    out.push(`authorization: ${ev.authorization_note}`);
  // Language: filter only when French/bilingual is stated as required, and not as "English or French".
  if (authSentences.some((s) => /(bilingual|french|fran[cç]ais)/.test(s) && /\b(required|mandatory|essential|must|requis|obligatoire)\b/.test(s) && !/english or french|asset|preferred|nice to have|an advantage/.test(s)))
    out.push(`language: ${ev.authorization_note}`);
  // Location: Toronto / Ottawa / GTA / remote(Canada) acceptable; other cities only if remote.
  const city = (ev.location_city || "").toLowerCase();
  const okCity = /toronto|ottawa|gta|mississauga|north york|east york|markham|vaughan|scarborough|etobicoke|kanata|gatineau|richmond hill|brampton|whitby|oshawa|pickering|ajax|oakville|burlington|thornhill|nepean|orl[eé]ans/.test(city) || city === "" || /^canada$|remote/.test(city);
  if (!okCity && ev.work_mode !== "remote") out.push(`location ${ev.location_city} (${ev.work_mode}) outside Toronto/Ottawa and not remote`);
  return out;
}

export function score(ev, profile) {
  const musts = ev.requirements.filter((r) => r.kind === "must");
  const nices = ev.requirements.filter((r) => r.kind === "nice");
  const avg = (rs) => (rs.length ? rs.reduce((s, r) => s + VERDICT_POINTS[r.verdict], 0) / rs.length : 0.5);
  const mustCov = avg(musts);
  const niceCov = avg(nices);
  const gaps = musts.filter((r) => r.verdict === "gap").length;

  const rank = FAMILY_RANK[ev.title_family] ?? 6;
  const familyFit = { 1: 1, 2: 0.9, 3: 0.6, 4: 0.7, 5: 0.4, 6: 0.2 }[rank];

  const seniorityFit = { intermediate: 1, senior: 0.8, junior: 0.6, lead: 0.5, unknown: 0.7, staff_principal: 0, manager: 0 }[ev.seniority] ?? 0.5;
  const modeFit = { remote: 1, hybrid: 0.85, onsite: 0.7, unknown: 0.8 }[ev.work_mode];
  const domainFit = VERDICT_POINTS[ev.domain_fit.verdict];

  const weights = { must: 0.45, nice: 0.10, family: 0.15, seniority: 0.10, mode: 0.05, domain: 0.15 };
  const raw = weights.must * mustCov + weights.nice * niceCov + weights.family * familyFit
    + weights.seniority * seniorityFit + weights.mode * modeFit + weights.domain * domainFit;
  // Each must-have gap beyond the first knocks the score down; a posting with 3+ must gaps is a stretch.
  const gapPenalty = Math.max(0, gaps - 1) * 0.06;
  const total = Math.round(Math.max(0, raw - gapPenalty) * 100);

  return {
    total,
    components: { must_coverage: +mustCov.toFixed(2), nice_coverage: +niceCov.toFixed(2), family_fit: familyFit, seniority_fit: seniorityFit, mode_fit: modeFit, domain_fit: domainFit, must_gaps: gaps, gap_penalty: +gapPenalty.toFixed(2) },
    weights,
  };
}

export function tier(total, filters) {
  if (filters.length) return "filtered_out";
  if (total >= 75) return "strong";
  if (total >= 60) return "good";
  if (total >= 45) return "stretch";
  return "weak";
}
