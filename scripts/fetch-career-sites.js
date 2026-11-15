/**
 * fetch-career-sites.js — HTML career boards for EN radar track
 * Growix evergreen AI/automation tracks + OpenTrain coding/AI roles
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

const UA = 'RemoteWorkRadar/1.0 (+https://github.com/Iris-Lin-Automation/remote-work-radar)';

/** Growix: only tracks that match Iris EN resume (Integration / Automation / Applied AI) */
const GROWIX_SLUGS = [
  'ai-integration-engineer',
  'ai-automation-engineer',
  'automation-engineer',
  'ai-ml-engineer',
  'api-integration-engineer',
  'data-engineer',
  'full-stack-engineer',
  'backend-software-engineer',
];

const OPENTRAIN_KEEP = /ai\s|llm|machine learning|\bml\b|software engineer|python|coding|automation|agent|backend|workflow|devops|data engineer|integration/i;
const OPENTRAIN_DROP = /legal|law|medicare|passport|veteran|poetry|underwriter|biology|patholog|finance advisor|sales and business|go-to-market|civil rights|antitrust|entertainment law|environmental law|image annotation|transcription|blender|physics|arabic|urdu|dermatolog|medical expert|packaging|annotation reviewer|safety annotation/i;

function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error('too many redirects'));
      return;
    }
    const lib = url.startsWith('http://') ? http : https;
    const req = lib.get(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        fetchText(next, redirects + 1).then(resolve, reject);
        return;
      }
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (code >= 400) reject(new Error(`HTTP ${code}`));
        else resolve(raw);
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
  });
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupKey(source, link, title) {
  const id = (link || title || '').replace(/#reply\d+$/, '').trim();
  return `${source}|${id}`;
}

function titleFromSlug(slug) {
  return slug
    .split('-')
    .map((w) => w.toUpperCase() === 'AI' || w.toUpperCase() === 'ML' || w.toUpperCase() === 'API'
      ? w.toUpperCase()
      : w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function fetchGrowixJobs(source) {
  const indexHtml = await fetchText(source.url || 'https://growix.com/careers');
  const found = new Set(
    [...indexHtml.matchAll(/href="(\/careers\/[a-z0-9-]+)"/gi)]
      .map((m) => m[1].replace(/^\/careers\//, ''))
      .filter((slug) => GROWIX_SLUGS.includes(slug))
  );

  const jobs = [];
  for (const slug of GROWIX_SLUGS) {
    if (!found.has(slug) && found.size > 0) continue; // index loaded but slug gone
    const url = `https://growix.com/careers/${slug}`;
    try {
      const html = await fetchText(url);
      const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
      const title = stripHtml(h1) || titleFromSlug(slug);
      const text = stripHtml(html).slice(0, 4000);
      jobs.push({
        source: source.key,
        sourceName: source.name,
        title,
        url,
        content: text,
        contentText: text,
        publishedAt: null, // evergreen → age filter passes
        location: 'Worldwide',
        dedupKey: dedupKey(source.key, url, title),
      });
    } catch (err) {
      // skip dead slug
    }
  }
  return jobs;
}

function parseOpenTrainJsonLd(html) {
  const jobs = [];
  const scripts = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of scripts) {
    try {
      const data = JSON.parse(m[1]);
      const nodes = Array.isArray(data) ? data : [data];
      for (const node of nodes) {
        const list = node?.mainEntity?.itemListElement || node?.itemListElement;
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const name = item.name || item.item?.name;
          const url = item.url || item.item?.url || item.item;
          if (!name || !url || typeof url !== 'string') continue;
          jobs.push({ title: name, url });
        }
      }
    } catch (_) { /* ignore bad json-ld */ }
  }
  return jobs;
}

async function fetchOpenTrainJobs(source) {
  const html = await fetchText(source.url || 'https://www.opentrain.ai/jobs/');
  let cards = parseOpenTrainJsonLd(html);

  if (!cards.length) {
    const urls = [...new Set(
      [...html.matchAll(/https:\/\/www\.opentrain\.ai\/jobs\/[a-z0-9-]+--[a-z0-9]+\//gi)].map((m) => m[0])
    )];
    cards = urls.map((url) => {
      const slug = url.split('/jobs/')[1] || '';
      const title = titleFromSlug(slug.split('--')[0] || slug);
      return { title, url };
    });
  }

  const filtered = cards.filter((c) => {
    const t = c.title || '';
    if (OPENTRAIN_DROP.test(t)) return false;
    return OPENTRAIN_KEEP.test(t);
  }).slice(0, 40);

  return filtered.map((c) => {
    const content = `${c.title} Remote AI training / evaluation / coding tasks. Check country eligibility on listing.`;
    return {
      source: source.key,
      sourceName: source.name,
      title: c.title,
      url: c.url,
      content,
      contentText: content,
      publishedAt: null,
      location: 'Remote (check listing countries)',
      dedupKey: dedupKey(source.key, c.url, c.title),
    };
  });
}

async function fetchCareerSite(source) {
  if (source.parser === 'growix') return fetchGrowixJobs(source);
  if (source.parser === 'opentrain') return fetchOpenTrainJobs(source);
  throw new Error(`unknown career parser: ${source.parser}`);
}

module.exports = {
  fetchCareerSite,
  GROWIX_SLUGS,
  fetchGrowixJobs,
  fetchOpenTrainJobs,
};
