// Paste/run inside the LinkedIn tab (any linkedin.com page). Fetches guest job postings for IDS,
// parses them, and returns an array to save as data/raw/linkedin/desc_N.json. Stops at the first
// 429 so the rate-limit bucket is not burned on failures.
const IDS = [/* ids from: node collect/ingest_browser_batch.mjs --todo --n 40 */];
(async () => {
  const out = [];
  for (const id of IDS) {
    try {
      const r = await fetch("/jobs-guest/jobs/api/jobPosting/" + id);
      if (r.status !== 200) { out.push({ id, error: "http " + r.status }); if (r.status === 429) break; continue; }
      const d = new DOMParser().parseFromString(await r.text(), "text/html");
      const q = (s) => d.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() || null;
      const criteria = {};
      d.querySelectorAll(".description__job-criteria-item").forEach((li) => {
        const k = li.querySelector(".description__job-criteria-subheader")?.textContent.trim();
        const v = li.querySelector(".description__job-criteria-text")?.textContent.trim();
        if (k) criteria[k] = v;
      });
      const desc = d.querySelector(".show-more-less-html__markup");
      let text = "";
      if (desc) {
        desc.querySelectorAll("br").forEach((b) => b.replaceWith("\n"));
        desc.querySelectorAll("li").forEach((l) => l.prepend("- "));
        desc.querySelectorAll("p,li,div,h1,h2,h3,h4,ul,ol").forEach((e) => e.append("\n"));
        text = desc.textContent.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, 7000);
      }
      out.push({ id, title: q(".topcard__title"), company: q(".topcard__org-name-link") || q(".topcard__flavor"), location: q(".topcard__flavor--bullet"), posted: q(".posted-time-ago__text"), applicants: q(".num-applicants__caption"), criteria, description: text });
    } catch (e) { out.push({ id, error: String(e) }); }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return out;
})();
