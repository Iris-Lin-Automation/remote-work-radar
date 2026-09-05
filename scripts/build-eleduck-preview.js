const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'research', 'eleduck-jobs-channel-authenticated.html');
const outputDir = path.join(root, 'output');
const jsonPath = path.join(outputDir, 'eleduck-jobs-preview.json');
const htmlPath = path.join(outputDir, 'eleduck-jobs-preview.html');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

async function main() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing captured Eleduck page: ${sourcePath}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(fs.readFileSync(sourcePath, 'utf8'));

  const jobs = await page.locator('.post-item').evaluateAll((cards) => cards.map((card) => {
    const titleLink = card.querySelector('h2.post-title > a');
    if (!titleLink) return null;

    const category = card.querySelector('.meta-info a.category-link');
    const publisher = card.querySelector('.meta-info a[href^="/users/"] span[title]');
    const metaText = [...card.querySelectorAll('.meta-info span')]
      .map((node) => node.textContent.trim())
      .find((text) => text.includes('发布于')) || '';

    return {
      source: 'eleduck',
      title: titleLink.textContent.trim(),
      apply_url: new URL(titleLink.getAttribute('href'), 'https://eleduck.com').href,
      category: category ? category.textContent.trim() : '',
      publisher: publisher ? publisher.getAttribute('title') || publisher.textContent.trim() : '',
      published_hint: metaText.replace(/^发布于\s*/, ''),
    };
  }).filter(Boolean));

  await browser.close();
  fs.writeFileSync(jsonPath, JSON.stringify(jobs, null, 2), 'utf8');

  const rows = jobs.map((job, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(job.category || '未标注')}</td>
      <td><a href="${escapeHtml(job.apply_url)}" target="_blank" rel="noreferrer">${escapeHtml(job.title)}</a></td>
      <td>${escapeHtml(job.publisher || '未显示')}</td>
      <td>${escapeHtml(job.published_hint || '未显示')}</td>
    </tr>`).join('');

  const document = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>电鸭招聘预览</title>
  <style>
    :root { color: #1c2630; background: #f4f6f8; font-family: Arial, "Microsoft YaHei", sans-serif; }
    body { margin: 0; }
    main { max-width: 1200px; margin: 32px auto; padding: 0 24px; }
    h1 { margin: 0; font-size: 24px; font-weight: 700; }
    p { color: #59636e; margin: 8px 0 24px; }
    .summary { display: inline-block; padding: 5px 9px; border: 1px solid #b7d8cf; background: #ecf8f3; color: #176b55; font-size: 14px; }
    table { width: 100%; border-collapse: collapse; background: #fff; font-size: 14px; }
    th, td { padding: 14px 12px; border-bottom: 1px solid #e4e8eb; text-align: left; vertical-align: top; }
    th { background: #eef2f4; color: #44515e; font-weight: 600; }
    tr:hover td { background: #f7fbfa; }
    a { color: #1266c3; text-decoration: none; }
    a:hover { text-decoration: underline; }
    td:nth-child(1) { width: 42px; color: #6c7782; }
    td:nth-child(2) { width: 220px; }
    td:nth-child(4), td:nth-child(5) { width: 150px; color: #59636e; }
  </style>
</head>
<body>
  <main>
    <h1>电鸭招聘预览</h1>
    <p><span class="summary">当前第一页：${jobs.length} 条</span> 点击职位标题即可打开电鸭原帖。此页只来自刚才保存的招聘列表，尚未写入数据库。</p>
    <table>
      <thead><tr><th>#</th><th>标签</th><th>职位</th><th>发布者</th><th>发布时间</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </main>
</body>
</html>`;

  fs.writeFileSync(htmlPath, document, 'utf8');
  console.log(`Extracted ${jobs.length} Eleduck job cards.`);
  console.log(`Preview: ${htmlPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
