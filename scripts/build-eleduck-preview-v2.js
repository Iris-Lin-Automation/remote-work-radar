const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const inputPath = path.join(root, 'research', 'eleduck-jobs-channel-authenticated.html');
const outputDir = path.join(root, 'output');
const outputPath = path.join(outputDir, 'eleduck-jobs-preview.html');
const jsonPath = path.join(outputDir, 'eleduck-jobs-preview.json');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

async function main() {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Missing captured page: ${inputPath}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const capturedHtml = fs.readFileSync(inputPath, 'utf8');

  // DOMParser reads the saved page without fetching its scripts, images, or styles again.
  const jobs = await page.evaluate((html) => {
    const document = new DOMParser().parseFromString(html, 'text/html');
    return [...document.querySelectorAll('.post-item')].map((card) => {
      const titleLink = card.querySelector('h2.post-title > a');
      if (!titleLink) return null;

      const category = card.querySelector('.meta-info a.category-link');
      const publisher = card.querySelector('.meta-info a[href^="/users/"] span[title]');
      const published = [...card.querySelectorAll('.meta-info span')]
        .map((node) => node.textContent.trim())
        .find((text) => text.includes('发布于')) || '';

      return {
        source: 'eleduck',
        title: titleLink.textContent.trim(),
        apply_url: new URL(titleLink.getAttribute('href'), 'https://eleduck.com').href,
        category: category?.textContent.trim() || '未标注',
        publisher: publisher?.getAttribute('title') || publisher?.textContent.trim() || '未显示',
        published_hint: published.replace(/^发布于\s*/, '') || '未显示',
      };
    }).filter(Boolean);
  }, capturedHtml);
  await browser.close();

  fs.writeFileSync(jsonPath, JSON.stringify(jobs, null, 2), 'utf8');
  const rows = jobs.map((job, index) => `<tr><td>${index + 1}</td><td>${escapeHtml(job.category)}</td><td><a href="${escapeHtml(job.apply_url)}" target="_blank" rel="noreferrer">${escapeHtml(job.title)}</a></td><td>${escapeHtml(job.publisher)}</td><td>${escapeHtml(job.published_hint)}</td></tr>`).join('');
  const pageHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>电鸭岗位预览</title><style>body{margin:32px;background:#f4f6f8;color:#1c2630;font:14px Arial,"Microsoft YaHei",sans-serif}main{max-width:1200px;margin:auto}h1{font-size:24px}p{color:#59636e}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:13px 12px;border-bottom:1px solid #e4e8eb;text-align:left;vertical-align:top}th{background:#eef2f4}tr:hover td{background:#f7fbfa}a{color:#1266c3;text-decoration:none}a:hover{text-decoration:underline}td:first-child{width:40px;color:#6c7782}</style></head><body><main><h1>电鸭招聘预览</h1><p>当前第一页 ${jobs.length} 条。点击职位标题打开电鸭原帖。</p><table><thead><tr><th>#</th><th>标签</th><th>职位</th><th>发布者</th><th>发布时间</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
  fs.writeFileSync(outputPath, pageHtml, 'utf8');
  console.log(`Extracted ${jobs.length} job cards.`);
  console.log(`Preview: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
