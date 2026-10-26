// Ashby public posting API (adapted from santifer/career-ops providers/ashby.mjs, MIT).
// entry: { name, provider: "ashby", slug }
export default {
  id: "ashby",
  listUrl: (entry) => `https://api.ashbyhq.com/posting-api/job-board/${entry.slug}`,
  async list(entry, ctx) {
    const json = await ctx.fetchJson(this.listUrl(entry));
    return (json?.jobs || []).filter((j) => j.isListed !== false).map((j) => ({
      board_id: `ab-${j.id}`, provider: "ashby", title: j.title || "", url: j.jobUrl || "",
      location: [j.location, ...(j.secondaryLocations || []).map((l) => l.location)].filter(Boolean).join("; "),
      first_published: j.publishedAt || null, updated_at: null, remote: j.isRemote ? "remote" : j.workplaceType || null,
      description: j.descriptionPlain || (j.descriptionHtml ? ctx.htmlToText(j.descriptionHtml) : null),
    }));
  },
};
