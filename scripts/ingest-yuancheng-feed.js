/**
 * 把远程.work (https://yuancheng.work/feed) 的岗位接入国内大池子。
 * 抓取 RSS -> 清洗 -> 去重写入 jobs 表（market=domestic）。
 * 打分由 scripts/score-domestic.js 完成，看板由 scripts/generate-pool-view.js 生成。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Parser = require('rss-parser');

const FEED_URL = 'https://yuancheng.work/feed';
const SOURCE = 'yuancheng_work';
const root = path.resolve(__dirname, '..');

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#8211;|&ndash;/gi, '-')
    .replace(/&#8216;|&#8217;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeSql(value) {
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function sqlText(value) {
  return escapeSql(stripHtml(value));
}

function extractCompany(title) {
  const m = String(title || '').match(/^(.*?)(招聘|诚聘|急招|招募)/);
  if (m && m[1] && m[1].trim() && m[1].trim() !== '未提供公司名') {
    return m[1].trim();
  }
  return null;
}

function extractEmploymentType(title, content) {
  const text = `${title} ${content || ''}`;
  if (text.includes('兼职')) return 'part_time';
  if (text.includes('全职')) return 'full_time';
  if (text.includes('合同') || text.includes('外包')) return 'contract';
  return null;
}

async function main() {
  const parser = new Parser({
    customFields: {
      item: [['content:encoded', 'contentEncoded']],
    },
  });

  console.log(`🔄 抓取 ${FEED_URL} ...`);
  const feed = await parser.parseURL(FEED_URL);
  const items = feed.items || [];
  console.log(`📥 抓取到 ${items.length} 个岗位\n`);

  const statements = [];

  for (const item of items) {
    const title = (item.title || '').trim();
    const applyUrl = (item.link || '').trim();
    const contentRaw = item.contentEncoded || item['content:encoded'] || item.content || '';
    const contentClean = stripHtml(contentRaw);
    const company = extractCompany(title);
    const employmentType = extractEmploymentType(title, contentClean);

    // dedup key：用 WordPress post id（guid 里带 ?p=xxxx）
    const guid = item.guid || '';
    const postId = (guid.match(/[?&]p=(\d+)/) || [])[1] || applyUrl;
    const dedupKey = `${SOURCE}_p${postId}`;

    const published = item.isoDate ? `'${new Date(item.isoDate).toISOString()}'` : 'NOW()';

    const sql = `INSERT INTO jobs (
        source, title, company, apply_url, dedup_key,
        description_raw, description_clean, location_raw,
        region_bucket, china_eligible, employment_type,
        published_at, intent, market, pipeline_status
      ) VALUES (
        ${escapeSql(SOURCE)},
        ${escapeSql(title)},
        ${escapeSql(company)},
        ${escapeSql(applyUrl)},
        ${escapeSql(dedupKey)},
        ${escapeSql(contentRaw)},
        ${escapeSql(contentClean)},
        ${escapeSql('Remote')},
        'global',
        'true',
        ${escapeSql(employmentType)},
        ${published},
        'hiring',
        'domestic',
        'new'
      )
      ON CONFLICT (dedup_key) DO UPDATE SET
        title = EXCLUDED.title,
        description_raw = EXCLUDED.description_raw,
        description_clean = EXCLUDED.description_clean,
        company = EXCLUDED.company,
        employment_type = EXCLUDED.employment_type,
        last_seen_at = NOW(),
        is_stale = FALSE;`;

    statements.push(sql);
    console.log(`  ✅ ${title.slice(0, 42)}`);
  }

  const tmpFile = path.join(root, 'output', 'tmp_yuancheng_ingest.sql');
  fs.writeFileSync(tmpFile, statements.join('\n'), 'utf8');

  console.log(`\n💾 写入数据库（${statements.length} 条）...`);
  execSync(`docker exec -i remote-job-monitor-postgres psql -U job_monitor -d job_monitor < "${tmpFile}"`, {
    stdio: 'inherit',
  });
  fs.unlinkSync(tmpFile);

  console.log('\n✅ 接入完成。下一步：');
  console.log('   node scripts/score-domestic.js --limit=20');
  console.log('   node scripts/generate-pool-view.js');
}

main().catch(err => {
  console.error('❌ 接入失败:', err.message);
  process.exit(1);
});
