const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outputPath = path.join(root, 'output', 'big-pool-view.html');

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function queryDb(sql) {
  const cmd = `docker exec -i remote-job-monitor-postgres psql -U job_monitor -d job_monitor -A -F "||" -c "${sql.replace(/\n/g, ' ')}"`;
  const result = execSync(cmd, { encoding: 'utf8' });
  const lines = result.trim().split('\n').filter(l => l && !l.startsWith('('));
  if (lines.length < 2) return [];
  const headers = lines[0].split('||');
  return lines.slice(1).map(line => {
    const values = line.split('||');
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (values[i] || '').trim(); });
    return obj;
  });
}

async function main() {
  console.log('Fetching data from database...');

  const stats = queryDb(`
    SELECT market, 
      COUNT(*) as total,
      COUNT(CASE WHEN intent != 'unknown' AND intent IS NOT NULL THEN 1 END) as scored,
      COUNT(CASE WHEN intent = 'hiring' THEN 1 END) as hiring,
      COUNT(CASE WHEN match_score >= 60 THEN 1 END) as high_score
    FROM jobs 
    GROUP BY market
    ORDER BY market
  `);

  const rows = queryDb(`
    SELECT title, source, market, intent, match_score, china_eligible, apply_url, 
      TO_CHAR(last_seen_at, 'MM-DD HH24:MI') as seen_time
    FROM jobs 
    ORDER BY 
      CASE WHEN intent = 'hiring' THEN 0 ELSE 1 END,
      CASE WHEN match_score IS NOT NULL THEN match_score ELSE -1 END DESC,
      last_seen_at DESC
    LIMIT 300
  `);

  const statCards = stats.map(s => `
    <div class="stat-card ${s.market}">
      <div class="stat-market">${s.market === 'domestic' ? '🇨🇳 国内市场' : '🌍 国外市场'}</div>
      <div class="stat-numbers">
        <div class="stat-item"><span class="stat-num">${s.total}</span><span class="stat-label">总条目</span></div>
        <div class="stat-item"><span class="stat-num scored">${s.scored}</span><span class="stat-label">已AI打分</span></div>
        <div class="stat-item"><span class="stat-num hiring">${s.hiring}</span><span class="stat-label">真实招聘</span></div>
        <div class="stat-item"><span class="stat-num high">${s.high_score}</span><span class="stat-label">高匹配(≥60)</span></div>
      </div>
      <div class="stat-pending">${Number(s.total) - Number(s.scored)} 条待AI分析</div>
    </div>
  `).join('');

  const intentMap = {
    hiring:    { label: '📋 招聘', cls: 'hiring' },
    seeking:   { label: '🙋 接单', cls: 'seeking' },
    sharing:   { label: '💡 分享', cls: 'sharing' },
    discussing:{ label: '💬 讨论', cls: 'discussing' },
    unknown:   { label: '⏳ 待分析', cls: 'unknown' },
  };

  const marketBadge = m => m === 'domestic'
    ? '<span class="market-badge domestic">国内</span>'
    : '<span class="market-badge global">国外</span>';

  const tableRows = rows.map(r => {
    const score = Number(r.match_score);
    const scoreClass = score >= 60 ? 'score-high' : score >= 30 ? 'score-mid' : (r.match_score ? 'score-low' : 'score-none');
    const scoreText = r.match_score ? score : '—';
    
    // 添加推荐等级标签
    let recommendationText = '';
    let recommendationClass = '';
    if (score >= 70) {
      recommendationText = '强烈推荐';
      recommendationClass = 'recommendation-strong';
    } else if (score >= 50) {
      recommendationText = '推荐';
      recommendationClass = 'recommendation-medium';
    } else if (score >= 30) {
      recommendationText = '考虑';
      recommendationClass = 'recommendation-weak';
    }
    
    const intent = intentMap[r.intent] || intentMap.unknown;
    const chinaIcon = r.china_eligible === 'true' ? '✅' : r.china_eligible === 'false' ? '❌' : '❓';
    return `
      <tr class="row-intent-${r.intent || 'unknown'} row-market-${r.market || 'global'} row-source-${r.source || 'unknown'}">
        <td>${marketBadge(r.market)}</td>
        <td><span class="badge badge-${intent.cls}">${intent.label}</span></td>
        <td class="title-cell">
          <a href="${escapeHtml((r.apply_url || '').replace(/#reply\d+$/, ''))}" target="_blank" title="${escapeHtml(r.title)}">${escapeHtml(r.title)}</a>
          <span class="source-tag">${escapeHtml(r.source)}</span>
        </td>
        <td>
          <span class="score-tag ${scoreClass}">${scoreText}</span>
          ${recommendationText ? `<span class="recommendation-tag ${recommendationClass}">${recommendationText}</span>` : ''}
        </td>
        <td class="china-cell">${chinaIcon}</td>
        <td class="time-cell">${r.seen_time}</td>
      </tr>
    `;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>远程工作雷达 · 大池子看板</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; background: #f5f7fa; color: #333; }
    .header { background: linear-gradient(135deg, #1890ff, #36cfc9); color: white; padding: 20px 30px; }
    .header h1 { font-size: 22px; font-weight: 600; }
    .header .sub { opacity: 0.85; font-size: 13px; margin-top: 4px; }
    .main { max-width: 1300px; margin: 0 auto; padding: 20px; }

    .stats-row { display: flex; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
    .stat-card { flex: 1; min-width: 260px; background: white; border-radius: 10px; padding: 16px 20px; box-shadow: 0 2px 8px rgba(0,0,0,0.07); border-left: 4px solid #1890ff; }
    .stat-card.global { border-left-color: #722ed1; }
    .stat-market { font-weight: 600; font-size: 15px; margin-bottom: 12px; color: #444; }
    .stat-numbers { display: flex; gap: 16px; }
    .stat-item { text-align: center; }
    .stat-num { display: block; font-size: 26px; font-weight: 700; color: #1890ff; line-height: 1; }
    .stat-num.scored { color: #52c41a; }
    .stat-num.hiring { color: #fa8c16; }
    .stat-num.high { color: #f5222d; }
    .stat-label { font-size: 11px; color: #8c8c8c; margin-top: 4px; display: block; }
    .stat-pending { margin-top: 10px; font-size: 12px; color: #faad14; background: #fffbe6; padding: 4px 10px; border-radius: 20px; display: inline-block; }

    .toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
    .toolbar-label { font-size: 13px; color: #666; margin-right: 4px; }
    .filter-btn { padding: 5px 14px; border: 1px solid #d9d9d9; border-radius: 20px; cursor: pointer; background: white; font-size: 13px; transition: all 0.2s; }
    .filter-btn:hover { border-color: #1890ff; color: #1890ff; }
    .filter-btn.active { background: #1890ff; color: white; border-color: #1890ff; }
    .filter-btn.market-domestic.active { background: #52c41a; border-color: #52c41a; }
    .filter-btn.market-global.active { background: #722ed1; border-color: #722ed1; }
    .divider { width: 1px; height: 20px; background: #e8e8e8; margin: 0 4px; }

    .table-wrap { background: white; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,0.07); overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; background: #fafafa; padding: 11px 14px; font-size: 12px; color: #666; font-weight: 600; border-bottom: 2px solid #f0f0f0; white-space: nowrap; }
    td { padding: 10px 14px; border-bottom: 1px solid #f5f5f5; vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafffe; }

    .market-badge { padding: 2px 7px; border-radius: 3px; font-size: 11px; font-weight: 600; }
    .market-badge.domestic { background: #f6ffed; color: #389e0d; border: 1px solid #b7eb8f; }
    .market-badge.global { background: #f0f5ff; color: #2f54eb; border: 1px solid #adc6ff; }

    .badge { padding: 3px 9px; border-radius: 4px; font-size: 12px; white-space: nowrap; }
    .badge-hiring { background: #e6f7ff; color: #1890ff; border: 1px solid #91d5ff; }
    .badge-seeking { background: #fff7e6; color: #d46b08; border: 1px solid #ffd591; }
    .badge-sharing { background: #f6ffed; color: #389e0d; border: 1px solid #b7eb8f; }
    .badge-discussing { background: #f5f5f5; color: #595959; border: 1px solid #d9d9d9; }
    .badge-unknown { background: #fffbe6; color: #ad6800; border: 1px solid #ffe58f; }

    .title-cell a { color: #262626; text-decoration: none; font-size: 13px; font-weight: 500; display: block; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title-cell a:hover { color: #1890ff; }
    .source-tag { font-size: 11px; color: #bbb; margin-top: 3px; display: block; }

    .score-tag { font-weight: 700; padding: 3px 10px; border-radius: 12px; font-size: 13px; }
    .score-high { background: #f6ffed; color: #389e0d; }
    .score-mid  { background: #fff7e6; color: #d46b08; }
    .score-low  { background: #fff1f0; color: #cf1322; }
    .score-none { background: #fafafa; color: #bbb; }

    .recommendation-tag { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; margin-left: 6px; white-space: nowrap; }
    .recommendation-strong { background: #ff4d4f; color: white; border: 1px solid #ff7875; }
    .recommendation-medium { background: #fa8c16; color: white; border: 1px solid #ffc53d; }
    .recommendation-weak { background: #1890ff; color: white; border: 1px solid #91d5ff; }

    .china-cell { text-align: center; font-size: 15px; }
    .time-cell { color: #bbb; font-size: 11px; white-space: nowrap; }

    .count-badge { background: #f0f0f0; color: #666; border-radius: 10px; padding: 1px 8px; font-size: 11px; margin-left: 6px; }
    .refresh-time { font-size: 12px; color: #bbb; margin-left: auto; }
  </style>
  <script>
    let activeIntent = 'all';
    let activeMarket = 'all';
    let activeSource = 'all';

    function applyFilters() {
      document.querySelectorAll('tbody tr').forEach(row => {
        const intentMatch = activeIntent === 'all' || row.classList.contains('row-intent-' + activeIntent);
        const marketMatch = activeMarket === 'all' || row.classList.contains('row-market-' + activeMarket);
        const sourceMatch = activeSource === 'all' || row.classList.contains('row-source-' + activeSource);
        row.style.display = intentMatch && marketMatch && sourceMatch ? '' : 'none';
      });
      const visible = [...document.querySelectorAll('tbody tr')].filter(r => r.style.display !== 'none').length;
      document.getElementById('visible-count').textContent = visible + ' 条';
    }

    function filterIntent(type, btn) {
      activeIntent = type;
      document.querySelectorAll('.intent-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilters();
    }

    function filterMarket(type, btn) {
      activeMarket = type;
      document.querySelectorAll('.market-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilters();
    }

    function filterSource(type, btn) {
      activeSource = type;
      document.querySelectorAll('.source-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      applyFilters();
    }
  </script>
</head>
<body>
  <div class="header">
    <h1>🎯 远程工作雷达 · 大池子看板</h1>
    <div class="sub">共 ${rows.length} 条数据 · 最后刷新: ${new Date().toLocaleString('zh-CN')}</div>
  </div>
  <div class="main">
    <div class="stats-row">
      ${statCards}
    </div>
    <div class="toolbar">
      <span class="toolbar-label">市场:</span>
      <button class="filter-btn market-btn active" onclick="filterMarket('all', this)">全部</button>
      <button class="filter-btn market-btn market-domestic" onclick="filterMarket('domestic', this)">🇨🇳 国内</button>
      <button class="filter-btn market-btn market-global" onclick="filterMarket('global', this)">🌍 国外</button>
      <div class="divider"></div>
      <span class="toolbar-label">类型:</span>
      <button class="filter-btn intent-btn active" onclick="filterIntent('all', this)">全部</button>
      <button class="filter-btn intent-btn" onclick="filterIntent('hiring', this)">📋 招聘</button>
      <button class="filter-btn intent-btn" onclick="filterIntent('sharing', this)">💡 分享</button>
      <button class="filter-btn intent-btn" onclick="filterIntent('discussing', this)">💬 讨论</button>
      <button class="filter-btn intent-btn" onclick="filterIntent('seeking', this)">🙋 接单</button>
      <button class="filter-btn intent-btn" onclick="filterIntent('unknown', this)">⏳ 待分析</button>
      <div class="divider"></div>
      <span class="toolbar-label">平台:</span>
      <button class="filter-btn source-btn active" onclick="filterSource('all', this)">全部</button>
      <button class="filter-btn source-btn" onclick="filterSource('yuancheng_work', this)">远程.work</button>
      <button class="filter-btn source-btn" onclick="filterSource('v2ex_jobs', this)">V2EX</button>
      <button class="filter-btn source-btn" onclick="filterSource('arbeitnow', this)">Arbeitnow</button>
      <button class="filter-btn source-btn" onclick="filterSource('jobicy', this)">Jobicy</button>
      <button class="filter-btn source-btn" onclick="filterSource('himalayas', this)">Himalayas</button>
      <button class="filter-btn source-btn" onclick="filterSource('eleduck', this)">Eleduck</button>
      <span class="refresh-time">显示 <strong id="visible-count">${rows.length} 条</strong></span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>市场</th>
            <th>类型</th>
            <th>标题 / 来源</th>
            <th>匹配分</th>
            <th>国内可用</th>
            <th>发现时间</th>
          </tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`\n✅ 看板已生成: ${outputPath}`);
  console.log(`\n📊 数据概览:`);
  stats.forEach(s => {
    console.log(`  ${s.market === 'domestic' ? '🇨🇳 国内' : '🌍 国外'}: 共 ${s.total} 条, 已打分 ${s.scored} 条, 真实招聘 ${s.hiring} 条`);
  });
}

main().catch(console.error);
