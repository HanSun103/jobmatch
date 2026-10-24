// Structured-output schema for one job evaluation. The model extracts requirements and
// judges each one against the profile; the score itself is computed in code (score.mjs)
// from these verdicts so it is deterministic and auditable.
import { z } from "zod";

export const Verdict = z.enum(["met", "partial", "gap", "unknown"]);

export const Requirement = z.object({
  id: z.string().describe("short slug, e.g. r1, r2"),
  text: z.string().describe("the requirement as the posting states it, condensed"),
  kind: z.enum(["must", "nice"]).describe("must-have vs nice-to-have per the posting's wording"),
  category: z.enum(["skill", "experience", "education", "domain", "soft", "credential", "language"]),
  verdict: Verdict,
  evidence: z.array(z.string()).describe("evidence pointers copied verbatim from the profile (resume:..., variant:..., github:..., qa:...). Empty when verdict is gap or unknown."),
  reasoning: z.string().describe("one sentence: why this verdict, citing the evidence"),
});

export const JobEvaluation = z.object({
  job_summary: z.string().describe("two sentences: what the role actually does day to day"),
  title_family: z.enum([
    "data_scientist", "ml_ai_scientist", "ml_engineer", "data_engineer", "ai_engineer",
    "economist", "model_validation", "business_analyst", "analytics", "research_scientist", "other",
  ]),
  seniority: z.enum(["junior", "intermediate", "senior", "lead", "staff_principal", "manager", "unknown"])
    .describe("from the title and the years/scope described, not from LinkedIn's label"),
  years_required: z.number().nullable().describe("minimum years of experience explicitly stated, else null"),
  work_mode: z.enum(["remote", "hybrid", "onsite", "unknown"]),
  location_city: z.string().nullable(),
  canada_based_ok: z.boolean().describe("true if a Canada-based candidate is eligible (Canadian employer, or remote role that explicitly includes Canada)"),
  authorization_note: z.string().nullable().describe("any stated work-authorization, citizenship, clearance or language requirement"),
  employment_type: z.enum(["full_time", "contract", "internship", "part_time", "unknown"]),
  requirements: z.array(Requirement).min(3).max(18),
  domain_fit: z.object({
    verdict: Verdict,
    reasoning: z.string(),
    evidence: z.array(z.string()),
  }).describe("does the candidate's domain history (e-commerce, LLM eval, finance/AML, pricing, quant) overlap the role's domain"),
  pitch: z.string().describe("3-4 sentences in first person the candidate could adapt for a cover note; cite concrete evidence, no fluff"),
  red_flags: z.array(z.string()).describe("concrete reasons this may be a poor use of an application: seniority mismatch, hard requirement missing, location, clearance, etc."),
});
