// Lever public postings API (adapted from santifer/career-ops providers/lever.mjs, MIT).
// entry: { name, provider: "lever", slug }
export default {
  id: "lever",
  listUrl: (entry) => `https://api.lever.co/v0/postings/${entry.slug}?mode=json`,
  async list(entry, ctx) {
    const json = await ctx.fetchJson(this.listUrl(entry));
    if (!Array.isArray(json)) return [];
    return json.map((j) => ({
      board_id: `lv-${j.id}`, provider: "lever", title: j.text || "", url: j.hostedUrl || "",
      location: [j.categories?.location, ...(j.categories?.allLocations || [])].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join("; "),
      first_published: j.createdAt ? new Date(j.createdAt).toISOString() : null, updated_at: null, remote: j.workplaceType || null,
      description: [j.descriptionPlain, ...(j.lists || []).map((l) => `${l.text}\n${ctx.htmlToText(l.content || "")}`), j.additionalPlain].filter(Boolean).join("\n\n") || null,
    }));
  },
};
