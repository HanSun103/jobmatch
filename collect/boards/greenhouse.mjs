// Greenhouse public board API (adapted from santifer/career-ops providers/greenhouse.mjs, MIT).
// One request per board returns every posting with first_published, updated_at and the description.
// entry: { name, provider: "greenhouse", slug }
const HOSTS = new Set(["boards-api.greenhouse.io"]);

export default {
  id: "greenhouse",
  listUrl: (entry) => `https://boards-api.greenhouse.io/v1/boards/${entry.slug}/jobs?content=true`,
  async list(entry, ctx) {
    const url = this.listUrl(entry);
    if (!HOSTS.has(new URL(url).hostname)) throw new Error(`greenhouse: untrusted host in ${url}`);
    const json = await ctx.fetchJson(url, { redirect: "error" });
    return (json?.jobs || []).filter((j) => j.absolute_url).map((j) => ({
      board_id: `gh-${j.id}`, provider: "greenhouse", title: j.title || "", url: j.absolute_url,
      location: j.location?.name || "", first_published: j.first_published || null, updated_at: j.updated_at || null,
      description: j.content ? ctx.htmlToText(ctx.decode(j.content)) : null,
    }));
  },
};
