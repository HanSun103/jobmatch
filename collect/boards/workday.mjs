// Workday career sites. No public listing of everything, but every site exposes the JSON the SPA
// uses: POST .../wday/cxs/<tenant>/<site>/jobs with {appliedFacets, limit, offset, searchText}
// (rows: title, externalPath, locationsText, postedOn "Posted N Days Ago", bulletFields[req id]), and
// GET .../wday/cxs/<tenant>/<site><externalPath> for the detail (jobPostingInfo.startDate = the real
// posting date, jobDescription HTML, location(s), remoteType, externalUrl).
// entry: { name, provider: "workday", tenant, site, wd: "wd3" }. ctx.searchTerms drives the queries.
const PAGE = 20, MAX_PER_TERM = 200;

export default {
  id: "workday",
  base: (entry) => `https://${entry.tenant}.${entry.wd}.myworkdayjobs.com`,
  listUrl(entry) { return `${this.base(entry)}/wday/cxs/${entry.tenant}/${entry.site}/jobs`; },
  async list(entry, ctx) {
    const api = this.listUrl(entry), seen = new Map();
    for (const term of entry.search_terms || ctx.searchTerms || [""]) {
      for (let offset = 0; offset < MAX_PER_TERM; offset += PAGE) {
        const json = await ctx.fetchJson(api, {
          method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: PAGE, offset, searchText: term }),
        });
        const rows = json?.jobPostings || [];
        for (const p of rows) {
          if (!p.externalPath || seen.has(p.externalPath)) continue;
          const req = (p.bulletFields || [])[0] || p.externalPath.split("_").pop();
          seen.set(p.externalPath, {
            board_id: `wd-${entry.tenant}-${String(req).replace(/[^A-Za-z0-9_-]/g, "")}`, provider: "workday",
            title: p.title || "", url: `${this.base(entry)}/${entry.site}${p.externalPath}`, location: p.locationsText || "",
            posted_on: p.postedOn || null, first_published: null, updated_at: null, description: null, external_path: p.externalPath,
          });
        }
        if (rows.length < PAGE || offset + PAGE >= (json?.total || 0)) break;
        await ctx.sleep(300);
      }
      await ctx.sleep(300);
    }
    return [...seen.values()];
  },
  // Detail fetch, only for candidates: fills first_published, description, full location.
  async detail(entry, rec, ctx) {
    const json = await ctx.fetchJson(`${this.base(entry)}/wday/cxs/${entry.tenant}/${entry.site}${rec.external_path}`, { headers: { accept: "application/json" } });
    const i = json?.jobPostingInfo || {};
    return {
      ...rec, first_published: i.startDate || rec.first_published, url: i.externalUrl || rec.url, req_id: i.jobReqId || null,
      location: [i.location, ...(i.additionalLocations || [])].filter(Boolean).join("; ") || rec.location,
      remote: i.remoteType || null, description: i.jobDescription ? ctx.htmlToText(i.jobDescription) : null,
    };
  },
};
