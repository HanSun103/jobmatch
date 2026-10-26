// Shared transport + text helpers for board providers (adapted from santifer/career-ops providers/_http.mjs, MIT).
// Files prefixed with _ are never loaded as providers.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

async function fetchWithTimeout(url, { timeoutMs = 20000, headers = {}, method = "GET", body = null, redirect = "follow" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: { "user-agent": UA, ...headers }, body, redirect, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`HTTP ${res.status}${text ? ": " + text.replace(/\s+/g, " ").trim().slice(0, 200) : ""}`);
      err.status = res.status; throw err;
    }
    return res;
  } finally { clearTimeout(timer); }
}
export async function fetchJson(url, opts = {}) { return (await fetchWithTimeout(url, opts)).json(); }
export async function fetchText(url, opts = {}) { return (await fetchWithTimeout(url, opts)).text(); }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function decode(s) {
  return String(s)
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
}
export function htmlToText(html) {
  return decode(
    String(html)
      .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div|h\d|ul|ol|tr)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ").replace(/<[^>]+>/g, "")
  ).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
export function makeCtx(extra = {}) { return { fetchJson, fetchText, sleep, htmlToText, decode, ...extra }; }
