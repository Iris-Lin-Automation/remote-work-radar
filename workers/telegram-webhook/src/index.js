/**
 * Cloudflare Worker — Telegram webhook for Remote Job Copilot
 *
 * Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ALLOWED_TELEGRAM_USER_ID
 *          (or TELEGRAM_CHAT_ID), SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *          GROQ_API_KEY, GROQ_MODEL
 */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_jobs',
      description: 'Search jobs in database by filters. Never invent jobs.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          status: { type: 'string', enum: ['apply_now', 'verify', 'skip'] },
          track: { type: 'string', enum: ['en', 'cn'] },
          china_eligible: { type: 'string', enum: ['true', 'false', 'unclear'] },
          limit: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_job',
      description: 'Get one job by uuid or apply_url',
      parameters: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'explain_job',
      description: 'Explain scoring and eligibility for a job',
      parameters: {
        type: 'object',
        properties: { job_id: { type: 'string' } },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_job_url',
      description: 'Analyze a manually submitted job URL or pasted JD text',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          pasted_text: { type: 'string' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_applications',
      description: 'List application pipeline statuses',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          limit: { type: 'integer' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_application_status',
      description: 'Update application status for a job',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string' },
          status: {
            type: 'string',
            enum: ['new', 'shortlisted', 'applied', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted'],
          },
        },
        required: ['job_id', 'status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_radar_stats',
      description: 'Radar/DB statistics for /status',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_preference',
      description: 'Propose preference change; requires /confirm',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          signal_value: { type: 'object' },
        },
        required: ['summary'],
      },
    },
  },
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json({
        ok: true,
        service: 'remote-job-copilot-tg',
        hasSupabase: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY),
        hasGroq: !!env.GROQ_API_KEY,
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const secret = env.TELEGRAM_WEBHOOK_SECRET || env.WEBHOOK_SECRET || '';
    if (secret) {
      const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      const pathOk = url.pathname.includes(secret) || url.searchParams.get('secret') === secret;
      if (header !== secret && !pathOk) {
        return new Response('Unauthorized webhook', { status: 401 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    try {
      await handleUpdate(update, env);
    } catch (err) {
      console.error('handleUpdate', err.message || err);
    }
    return json({ ok: true });
  },
};

function allowedUserId(env) {
  return String(env.ALLOWED_TELEGRAM_USER_ID || env.TELEGRAM_CHAT_ID || '');
}

async function handleUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;

  const chatId = String(msg.chat.id);
  const fromId = String(msg.from?.id || chatId);
  const allowed = allowedUserId(env);
  if (allowed && fromId !== allowed && chatId !== allowed) {
    await tgSend(env, chatId, '未授权用户。');
    return;
  }

  const text = String(msg.text).trim();
  const userKey = env.USER_KEY || 'iris';

  try {
    await sbInsert(env, 'conversations', {
      user_key: userKey,
      telegram_chat_id: chatId,
      role: 'user',
      content: text,
    });
  } catch (e) {
    // continue; will surface DB errors on commands
  }

  const fast = await tryFastCommands(text, env, userKey, chatId);
  if (fast != null) {
    await tgSend(env, chatId, fast);
    await sbInsert(env, 'conversations', {
      user_key: userKey,
      telegram_chat_id: chatId,
      role: 'assistant',
      content: fast,
    }).catch(() => {});
    return;
  }

  const reply = await runAgent(text, env, userKey, chatId);
  await tgSend(env, chatId, reply);
  await sbInsert(env, 'conversations', {
    user_key: userKey,
    telegram_chat_id: chatId,
    role: 'assistant',
    content: reply,
  }).catch(() => {});
}

async function tryFastCommands(text, env, userKey, chatId) {
  const lower = text.toLowerCase();

  if (/^\/?help$/i.test(text) || text === '帮助') {
    return [
      'Remote Job Copilot（云端）',
      '• /apply — china_eligible=true 且可投',
      '• /review — unclear / score_error / verify',
      '• /status — DB 与最近抓取统计',
      '• /check <url> — 人工提交链接分析',
      '• /prefs · /confirm <uuid>',
      '• 自然语言会走工具查库（不编造岗位）',
    ].join('\n');
  }

  if (/^\/?status$/i.test(text) || text === '状态') {
    return toolGetRadarStats(env);
  }

  if (/^\/?apply$/i.test(text) || /^(apply_now|立刻投)/i.test(text)) {
    return toolSearchJobs(env, {
      status: 'apply_now',
      china_eligible: 'true',
      limit: 10,
    });
  }

  if (/^\/?review$/i.test(text) || /^(verify|核实)/i.test(text)) {
    return toolReviewQueue(env);
  }

  if (/^\/?prefs$/i.test(text) || text === '偏好') {
    const prefs = await sbSelect(env, 'user_preferences', {
      user_key: `eq.${userKey}`,
      select: 'preference_summary,prefer_async,avoid_sales,require_china_eligible,updated_at',
      limit: '1',
    });
    if (prefs.error) return `DB 错误：${prefs.error}`;
    const r = prefs.data?.[0];
    if (!r) return '暂无偏好记录。';
    return `当前偏好：\n${r.preference_summary || '（无 summary）'}\nasync=${r.prefer_async} avoid_sales=${r.avoid_sales}\nupdated=${r.updated_at || ''}`;
  }

  const confirm = text.match(/^\/?confirm\s+([0-9a-f-]{36})$/i);
  if (confirm) return toolConfirmPreference(env, userKey, confirm[1]);

  const check = text.match(/^\/?check\s+(\S+)/i);
  if (check) {
    return toolCheckJobUrl(env, { url: check[1], pasted_text: '' }, userKey);
  }

  if (/^反馈[:：]/.test(text)) {
    const body = text.replace(/^反馈[:：]\s*/, '');
    const row = await sbInsert(env, 'application_feedback', {
      user_key: userKey,
      notes: body.slice(0, 2000),
      outcome: /面试/i.test(body) ? 'interview' : 'other',
    });
    if (row?.error) return `反馈写入失败：${row.error}`;
    return '已记录反馈。';
  }

  if (/我(更)?(喜欢|希望|不要|别再|讨厌)/.test(text)) {
    return toolProposePreference(env, userKey, {
      summary: text,
      signal_value: { preference_summary_append: text.slice(0, 240) },
    });
  }

  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return toolCheckJobUrl(env, { url: text.split(/\s+/)[0], pasted_text: text }, userKey);
  }

  return null;
}

async function runAgent(userText, env, userKey, chatId) {
  if (!env.GROQ_API_KEY) {
    return '未配置 GROQ_API_KEY。可用 /apply /review /status /check。';
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return '未配置 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，无法查库。';
  }

  const system = `你是 Iris 的 Remote Job Copilot。中文短回复。
候选人在中国 UTC+8。Worldwide≠中国可雇。
你只能通过工具查库返回岗位，禁止编造公司/链接/分数。
偏好只能 propose，需用户 /confirm。`;

  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userText },
  ];

  let data = await groqChat(env, messages, TOOLS);
  let choice = data?.choices?.[0];
  let guard = 0;

  while (choice?.message?.tool_calls?.length && guard < 4) {
    guard++;
    messages.push(choice.message);
    for (const tc of choice.message.tool_calls) {
      const name = tc.function?.name;
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* */ }
      const result = await dispatchTool(name, args, env, userKey);
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }
    data = await groqChat(env, messages, TOOLS);
    choice = data?.choices?.[0];
  }

  return choice?.message?.content?.trim() || '处理完成。';
}

async function dispatchTool(name, args, env, userKey) {
  switch (name) {
    case 'search_jobs':
      return toolSearchJobs(env, args);
    case 'get_job':
    case 'explain_job':
      return toolExplainJob(env, args.job_id || args.query || '');
    case 'check_job_url':
      return toolCheckJobUrl(env, args, userKey);
    case 'list_applications':
      return toolListApplications(env, userKey, args);
    case 'update_application_status':
      return toolUpdateApplication(env, userKey, args);
    case 'get_radar_stats':
      return toolGetRadarStats(env);
    case 'propose_preference':
      return toolProposePreference(env, userKey, args);
    default:
      return { error: `unknown tool ${name}` };
  }
}

function formatJobLines(rows, title) {
  if (!rows?.length) return `${title}\n（无匹配。若刚部署请先跑 radar-cycle / import-legacy。）`;
  return [
    title,
    '',
    ...rows.map((r, i) => {
      const bits = [
        `${i + 1}. ${r.match_score ?? '—'}分 [${r.recommendation_status || '?'}]`,
        r.title,
        `🇨🇳${r.china_eligible || '?'} · ${r.work_mode || ''} · ${r.hire_vehicle || ''} · ${r.source_bucket || r.source || ''}`,
        r.score_status === 'error' ? `⚠ score_error: ${r.score_error || ''}` : '',
        r.china_eligibility_reason || r.score_reason || '',
        r.apply_url || '',
      ].filter(Boolean);
      return bits.join('\n');
    }),
  ].join('\n\n');
}

async function toolSearchJobs(env, args) {
  const filters = {
    expired: 'eq.false',
    select: 'id,title,company,apply_url,match_score,recommendation_status,china_eligible,china_eligibility_reason,work_mode,hire_vehicle,source,source_bucket,score_status,score_error,score_reason,track',
    order: 'match_score.desc.nullslast',
    limit: String(Math.min(Number(args.limit) || 10, 20)),
  };
  if (args.status) filters.recommendation_status = `eq.${args.status}`;
  if (args.track) filters.track = `eq.${args.track}`;
  if (args.china_eligible) filters.china_eligible = `eq.${args.china_eligible}`;
  if (args.q) filters.title = `ilike.*${String(args.q).slice(0, 40)}*`;

  // apply_now hard filter
  if (args.status === 'apply_now') {
    filters.china_eligible = 'eq.true';
    filters.score_status = 'in.(ok,cached)';
  }

  const res = await sbSelect(env, 'jobs', filters);
  if (res.error) return `DB 查询失败：${res.error}`;
  return formatJobLines(res.data, args.status === 'apply_now' ? '✅ apply_now' : '检索结果');
}

async function toolReviewQueue(env) {
  const res = await sbSelect(env, 'jobs', {
    expired: 'eq.false',
    or: '(china_eligible.eq.unclear,score_status.eq.error,recommendation_status.eq.verify)',
    select: 'id,title,apply_url,match_score,recommendation_status,china_eligible,china_eligibility_reason,score_status,score_error,source,source_bucket,work_mode,hire_vehicle,score_reason',
    order: 'last_seen_at.desc',
    limit: '15',
  });
  if (res.error) return `DB 查询失败：${res.error}`;
  return formatJobLines(res.data, '🔎 /review（unclear / score_error / verify）');
}

async function toolExplainJob(env, jobId) {
  if (!jobId) return '缺少 job_id';
  let res = await sbSelect(env, 'jobs', {
    id: `eq.${jobId}`,
    select: '*',
    limit: '1',
  });
  if (!res.data?.length) {
    res = await sbSelect(env, 'jobs', {
      or: `(apply_url.eq.${jobId},dedup_key.eq.${jobId})`,
      select: '*',
      limit: '1',
    });
  }
  if (res.error) return `DB 错误：${res.error}`;
  const r = res.data?.[0];
  if (!r) return `未找到岗位 ${jobId}`;
  return [
    r.title,
    `id=${r.id}`,
    `status=${r.recommendation_status} score=${r.match_score} score_status=${r.score_status}`,
    `🇨🇳${r.china_eligible} — ${r.china_eligibility_reason || ''}`,
    `mode=${r.work_mode} vehicle=${r.hire_vehicle} bucket=${r.source_bucket}`,
    `六维 T${r.score_tech}/D${r.score_delivery}/L${r.score_level}/W${r.score_workstyle}/C${r.score_comp}/Tr${r.score_trust}`,
    r.score_error ? `error: ${r.score_error}` : '',
    r.score_reason || '',
    r.apply_url || '',
  ].filter(Boolean).join('\n');
}

async function toolCheckJobUrl(env, args, userKey) {
  const url = (args.url || '').trim();
  const pasted = (args.pasted_text || '').trim();
  if (!url && !pasted) return '请提供 URL 或粘贴 JD。用法：/check https://...';

  let text = pasted;
  let fetchNote = '';
  if (url && url.startsWith('http')) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'RemoteJobCopilot/1.0' },
        redirect: 'follow',
      });
      if (!res.ok) {
        fetchNote = `页面抓取 HTTP ${res.status}；`;
      } else {
        const html = await res.text();
        const stripped = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        text = `${text} ${stripped}`.slice(0, 8000);
      }
    } catch (e) {
      fetchNote = `抓取失败（${e.message}）；`;
    }
  }

  if (!text || text.length < 40) {
    return `${fetchNote}无法解析页面。请粘贴完整 JD 文本后再发：\n/check ${url || ''}\n然后下一条消息粘贴 JD。`;
  }

  // Lightweight hard rules (mirror quick-match essentials)
  const hay = text;
  let china_eligible = 'unclear';
  let china_eligibility_reason = '人工提交：Worldwide≠可雇，未确认雇佣载体';
  if (/\b(us\s*only|must be.*(us|usa|uk|eu)|h-?1b|green\s*card)\b/i.test(hay)) {
    china_eligible = 'false';
    china_eligibility_reason = '签证/地区硬限制';
  } else if (/\b(contractor|eor|independent\s+contractor)\b/i.test(hay) &&
             /\b(worldwide|all\s+countries|work\s+from\s+anywhere)\b/i.test(hay)) {
    china_eligible = 'true';
    china_eligibility_reason = 'Worldwide + contractor/EOR 信号';
  }

  let work_mode = /\b(fully\s+remote|remote[\s-]?first|work\s+from\s+anywhere)\b/i.test(hay)
    ? 'fully_remote'
    : (/\bhybrid|on[\s-]?site\b/i.test(hay) ? 'hybrid' : 'unknown');
  let hire_vehicle = /\beor\b/i.test(hay) ? 'eor'
    : (/\bcontractor|freelance\b/i.test(hay) ? 'contractor'
      : (/\bemployee|w-?2|full[\s-]?time\b/i.test(hay) ? 'employee' : 'unknown'));

  const titleMatch = hay.match(/(?:job title|职位|title)[:：\s]+([^\n]{5,80})/i);
  const title = titleMatch?.[1]?.trim() || (url ? `Manual: ${url.slice(0, 60)}` : 'Manual JD');
  const dedup = `manual|${url || title.slice(0, 80)}`;

  const row = await sbInsert(env, 'jobs', {
    source: 'manual',
    source_name: 'manual',
    source_bucket: 'manual',
    title: title.slice(0, 200),
    description_raw: text.slice(0, 15000),
    description_clean: text.slice(0, 15000),
    apply_url: url || `manual://${encodeURIComponent(title.slice(0, 40))}`,
    dedup_key: dedup,
    china_eligible,
    china_eligibility_reason,
    work_mode,
    hire_vehicle,
    track: 'en',
    recommendation_status: china_eligible === 'false' ? 'skip' : 'verify',
    score_status: 'skipped',
    score_reason: 'manual_check_pending_llm',
    intent: 'hiring',
    region_bucket: 'unknown',
    seniority: 'unknown',
  });

  if (row?.error) return `保存失败：${row.error}`;

  return [
    '🧾 人工提交已保存（source=manual，绕过自动时间窗）',
    `title: ${title}`,
    `🇨🇳 ${china_eligible} — ${china_eligibility_reason}`,
    `mode=${work_mode} vehicle=${hire_vehicle}`,
    `status=verify（待完整六维评分）`,
    `id=${row?.id || '?'}`,
    url || '',
    fetchNote ? `注：${fetchNote}` : '',
  ].filter(Boolean).join('\n');
}

async function toolListApplications(env, userKey, args) {
  const filters = {
    user_key: `eq.${userKey}`,
    select: '*',
    order: 'updated_at.desc',
    limit: String(Math.min(Number(args.limit) || 20, 50)),
  };
  if (args.status) filters.application_status = `eq.${args.status}`;
  const res = await sbSelect(env, 'applications', filters);
  if (res.error) return `DB 错误：${res.error}`;
  if (!res.data?.length) return '暂无申请记录。可用工具 update_application_status 添加。';
  return res.data.map((r, i) =>
    `${i + 1}. [${r.application_status}] ${r.title || r.job_id}\n${r.apply_url || ''}`
  ).join('\n\n');
}

async function toolUpdateApplication(env, userKey, args) {
  const job = await toolExplainJob(env, args.job_id);
  // fetch job row for fields
  const res = await sbSelect(env, 'jobs', {
    or: `(id.eq.${args.job_id},apply_url.eq.${args.job_id})`,
    select: 'id,title,company,apply_url,source,dedup_key',
    limit: '1',
  });
  if (res.error) return `DB 错误：${res.error}`;
  const j = res.data?.[0];
  if (!j) return `未找到岗位 ${args.job_id}`;

  const row = await sbUpsert(env, 'applications', {
    user_key: userKey,
    job_id: j.id,
    source: j.source,
    company: j.company,
    title: j.title,
    apply_url: j.apply_url,
    dedup_key: j.dedup_key || `job:${j.id}`,
    application_status: args.status,
    updated_at: new Date().toISOString(),
  }, 'user_key,dedup_key');

  if (row?.error) return `更新失败：${row.error}`;
  return `已更新申请状态 → ${args.status}\n${j.title}`;
}

async function toolGetRadarStats(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return 'DB 未配置：缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY';
  }
  const jobs = await sbSelect(env, 'jobs', {
    select: 'recommendation_status,score_status,china_eligible,legacy_import,expired',
    limit: '1000',
  });
  if (jobs.error) return `DB 连接失败：${jobs.error}`;

  const rows = jobs.data || [];
  const count = (fn) => rows.filter(fn).length;
  const runs = await sbSelect(env, 'radar_runs', {
    select: '*',
    order: 'started_at.desc',
    limit: '1',
  });
  const run = runs.data?.[0];
  return [
    '📡 /status',
    `DB: ok · jobs_sampled=${rows.length}`,
    `apply_now=${count((r) => r.recommendation_status === 'apply_now')} verify=${count((r) => r.recommendation_status === 'verify')}`,
    `score_error=${count((r) => r.score_status === 'error')} china_unclear=${count((r) => r.china_eligible === 'unclear')}`,
    `legacy=${count((r) => r.legacy_import)} expired=${count((r) => r.expired)}`,
    run
      ? `最近抓取：${run.finished_at || run.started_at} scraped=${run.scraped} scored_ok=${run.scored_ok} scored_error=${run.scored_error} pushed=${run.pushed}`
      : '最近抓取：尚无 radar_runs（跑一轮 Actions 后会出现）',
  ].join('\n');
}

async function toolProposePreference(env, userKey, args) {
  const row = await sbInsert(env, 'preference_signals', {
    user_key: userKey,
    signal_type: 'chat_preference',
    signal_value: args.signal_value || { preference_summary_append: args.summary },
    raw_text: args.summary || '',
    status: 'pending',
  });
  if (row?.error) return `偏好提议失败：${row.error}`;
  return `偏好已提议（未写入）。确认：\n/confirm ${row?.id || '?'}\n${args.summary || ''}`;
}

async function toolConfirmPreference(env, userKey, signalId) {
  const sigs = await sbSelect(env, 'preference_signals', {
    id: `eq.${signalId}`,
    user_key: `eq.${userKey}`,
    status: 'eq.pending',
    select: '*',
    limit: '1',
  });
  if (sigs.error) return `DB 错误：${sigs.error}`;
  const s = sigs.data?.[0];
  if (!s) return '找不到待确认偏好。';

  const val = typeof s.signal_value === 'string' ? JSON.parse(s.signal_value) : (s.signal_value || {});
  const prefs = await sbSelect(env, 'user_preferences', {
    user_key: `eq.${userKey}`,
    select: 'preference_summary',
    limit: '1',
  });
  const prev = prefs.data?.[0]?.preference_summary || '';
  const append = val.preference_summary_append || s.raw_text || '';
  const patch = {
    updated_at: new Date().toISOString(),
    preference_summary: append ? `${prev}\n${append}`.trim() : prev,
  };
  for (const k of ['prefer_async', 'prefer_few_meetings', 'avoid_sales', 'avoid_oncall', 'require_china_eligible']) {
    if (typeof val[k] === 'boolean') patch[k] = val[k];
  }
  const p1 = await sbPatch(env, 'user_preferences', { user_key: `eq.${userKey}` }, patch);
  if (p1?.error) return `写入偏好失败：${p1.error}`;
  await sbPatch(env, 'preference_signals', { id: `eq.${signalId}` }, {
    status: 'confirmed',
    confirmed_at: new Date().toISOString(),
  });
  return `已确认偏好 ${signalId}`;
}

async function groqChat(env, messages, tools) {
  const body = {
    model: env.GROQ_MODEL || 'openai/gpt-oss-20b',
    messages,
    tools,
    tool_choice: 'auto',
    temperature: 0.2,
    max_tokens: 900,
  };
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Groq ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function tgSend(env, chatId, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN missing');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: String(text).slice(0, 4000),
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram send failed: ${data.description}`);
  return data;
}

function sbHeaders(env, prefer) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: prefer || 'return=representation',
  };
}

async function sbSelect(env, table, query) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { data: null, error: 'SUPABASE not configured' };
  }
  const u = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v != null) u.searchParams.set(k, v);
  }
  const res = await fetch(u.toString(), { headers: sbHeaders(env) });
  if (!res.ok) {
    const t = await res.text();
    return { data: null, error: t.slice(0, 300) };
  }
  return { data: await res.json(), error: null };
}

async function sbInsert(env, table, row) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return { error: 'SUPABASE not configured' };
  }
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: sbHeaders(env),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const t = await res.text();
    return { error: t.slice(0, 300) };
  }
  const data = await res.json();
  return Array.isArray(data) ? (data[0] || {}) : data;
}

async function sbPatch(env, table, filters, patch) {
  const u = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(filters || {})) u.searchParams.set(k, v);
  const res = await fetch(u.toString(), {
    method: 'PATCH',
    headers: sbHeaders(env),
    body: JSON.stringify(patch),
  });
  if (!res.ok) return { error: (await res.text()).slice(0, 300) };
  const data = await res.json();
  return Array.isArray(data) ? (data[0] || {}) : data;
}

async function sbUpsert(env, table, row, onConflict) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: {
      ...sbHeaders(env),
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) return { error: (await res.text()).slice(0, 300) };
  const data = await res.json();
  return Array.isArray(data) ? (data[0] || {}) : data;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
