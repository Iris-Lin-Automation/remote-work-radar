/**
 * fetch-ats-boards.js — Greenhouse + Ashby public job boards
 * Wellfound has no public API; these ATS feeds are the upstream source startups post to.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'ats-boards.json');
const UA = 'RemoteWorkRadar/1.0 (+https://github.com/Iris-Lin-Automation/remote-work-radar)';

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(25000, () => req.destroy(new Error('timeout')));
  });
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dedupKey(source, link, title) {
  return `${source}|${(link || title || '').trim()}`;
}

function titleOk(title, keepRe, dropRe) {
  const t = String(title || '');
  if (dropRe.test(t)) return false;
  return keepRe.test(t);
}

function looksRemote(hay) {
  // Prefer true remote / worldwide for CN applicants; skip SF/NY "remote-friendly travel-required"
  if (/\b(us only|united states only|must (be|reside|live) in (the )?(us|usa|united states))\b/i.test(hay)) return false;
  if (/\btravel[- ]required\b/i.test(hay)) return false;
  if (/\b(worldwide|work from anywhere|anywhere in the world|fully remote|100%\s*remote)\b/i.test(hay)) return true;
  if (/\bremote\b/i.test(hay) && !/\bsan francisco|new york city|seattle,?\s*wa|bay area\b/i.test(hay)) return true;
  if (/\bremote\b/i.test(hay) && /\b(canada|poland|europe|emea|apac|singapore|uk|united kingdom|india)\b/i.test(hay)) return true;
  return false;
}

async function fetchGreenhouseBoard(board, keepRe, dropRe, maxPerBoard) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${board.slug}/jobs?content=true`;
  const data = await fetchJson(url);
  const out = [];
  for (const job of data.jobs || []) {
    if (!titleOk(job.title, keepRe, dropRe)) continue;
    const loc = job.location?.name || '';
    const content = stripHtml(job.content || '');
    const hay = `${job.title} ${loc} ${content}`;
    // Prefer remote; still keep if title is strong AI match and location unclear
    if (!looksRemote(hay) && !/\bremote\b/i.test(job.title || '')) continue;

    const applyUrl = job.absolute_url || null;
    out.push({
      source: 'ats_greenhouse',
      sourceName: `Greenhouse·${board.name}`,
      title: job.title || '',
      url: applyUrl,
      content,
      contentText: content.slice(0, 4000),
      publishedAt: job.updated_at || job.created_at || null,
      location: loc || 'Remote',
      company: board.name,
      dedupKey: dedupKey('gh', applyUrl || job.id, job.title),
    });
    if (out.length >= maxPerBoard) break;
  }
  return out;
}

async function fetchAshbyBoard(board, keepRe, dropRe, maxPerBoard) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${board.slug}`;
  const data = await fetchJson(url);
  const out = [];
  for (const job of data.jobs || []) {
    if (job.isListed === false) continue;
    if (!titleOk(job.title, keepRe, dropRe)) continue;
    const loc = job.locationName || job.location || job.address?.postalAddress || '';
    const remote = job.isRemote === true || /remote/i.test(String(job.workplaceType || '')) || looksRemote(`${job.title} ${loc}`);
    if (!remote) continue;

    const content = String(job.descriptionPlain || stripHtml(job.descriptionHtml || '')).slice(0, 4000);
    const applyUrl = job.jobUrl || job.applyUrl || null;
    out.push({
      source: 'ats_ashby',
      sourceName: `Ashby·${board.name}`,
      title: job.title || '',
      url: applyUrl,
      content,
      contentText: content,
      publishedAt: job.publishedAt || null,
      location: loc || 'Remote',
      company: board.name,
      dedupKey: dedupKey('ashby', applyUrl || job.id, job.title),
    });
    if (out.length >= maxPerBoard) break;
  }
  return out;
}

async function fetchAllAtsBoards() {
  const cfg = loadConfig();
  const keepRe = new RegExp(cfg.titleKeep || 'ai', 'i');
  const dropRe = new RegExp(cfg.titleDrop || 'sales', 'i');
  const maxPerBoard = cfg.maxPerBoard || 20;
  const jobs = [];

  for (const board of cfg.greenhouse || []) {
    try {
      const part = await fetchGreenhouseBoard(board, keepRe, dropRe, maxPerBoard);
      jobs.push(...part);
    } catch (err) {
      console.log(`[ats] ⚠️  Greenhouse ${board.slug}: ${err.message}`);
    }
  }
  for (const board of cfg.ashby || []) {
    try {
      const part = await fetchAshbyBoard(board, keepRe, dropRe, maxPerBoard);
      jobs.push(...part);
    } catch (err) {
      console.log(`[ats] ⚠️  Ashby ${board.slug}: ${err.message}`);
    }
  }
  return jobs;
}

module.exports = { fetchAllAtsBoards, loadConfig };
