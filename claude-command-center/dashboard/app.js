/* Claude Command Center dashboard — vanilla JS, no build step, no external requests. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const view = $('#view');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const api = p => fetch(p, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
  const post = (p, body) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ccc': '1' }, body: JSON.stringify(body || {}) }).then(r => r.json());

  // ---------------------------------------------------------------- formatting
  const usd = v => v == null || isNaN(v) ? '—' : v === 0 ? '$0.00' : v < 0.01 ? '<$0.01' : '$' + (v < 100 ? v.toFixed(2) : v.toFixed(0));
  const tok = n => n == null ? '—' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n));
  const num = n => n == null ? '—' : Number(n).toLocaleString();
  const pct = v => v == null || isNaN(v) ? '—' : Math.round(v * 100) + '%';
  function dur(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }
  function ago(ts) {
    const d = Date.now() - ts;
    if (d < 45000) return 'just now';
    if (d < 3600000) return Math.round(d / 60000) + 'm ago';
    if (d < 86400000) return Math.round(d / 3600000) + 'h ago';
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  const fam = m => { const x = /(fable|mythos|opus|sonnet|haiku)/i.exec(m || ''); return x ? (x[1].toLowerCase() === 'mythos' ? 'fable' : x[1].toLowerCase()) : 'other'; };
  const famColor = m => `var(--${fam(m)})`;
  const tag = (k, label) => `<span class="tag ${k}" title="${esc(TAG_HELP[k] || '')}">${esc(label || k)}</span>`;
  const TAG_HELP = {
    measured: 'Read directly from Claude Code: hook events, transcript usage records or its todo list.',
    estimate: 'Computed from measured tokens × published list prices. Not a bill.',
    predicted: 'Forecast from your measured task history. Shows its sample size and basis.',
    heuristic: 'Rule-based recommendation from the prompt text. Suggestion only; nothing is changed.',
    reported: 'Cost Claude Code itself computed for the session.',
    invoiced: 'Invoiced amount from the Anthropic Admin API cost report.',
  };
  const STATUS = {
    running: ['●', 'Running'], blocked: ['⏸', 'Needs approval'], waiting: ['?', 'Waiting for you'], background: ['◐', 'Background agents'],
    completed: ['✓', 'Completed'], failed: ['✗', 'Failed'], interrupted: ['■', 'Interrupted'],
  };
  const statusPill = s => `<span class="status ${esc(s)}"><span class="i">${(STATUS[s] || ['•'])[0]}</span>${(STATUS[s] || [0, s])[1]}</span>`;
  const NOTIF_ICON = { finish: '✓', fail: '✗', errors: '!', attention: '?', blocked: '⏸' };

  // ---------------------------------------------------------------- state
  const st = { snapshot: null, range: localGet('range') || '30d', cfg: null, lastRender: 0 };
  function localGet(k) { try { return localStorage.getItem('ccc.' + k); } catch { return null; } }
  function localSet(k, v) { try { localStorage.setItem('ccc.' + k, v); } catch { /* private mode */ } }

  // theme
  const savedTheme = localGet('theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  $('#theme-btn').onclick = () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    const next = cur === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    localSet('theme', next);
  };

  // ---------------------------------------------------------------- tooltip
  const tipEl = $('#tooltip');
  document.addEventListener('mousemove', e => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t) { tipEl.hidden = true; return; }
    tipEl.innerHTML = t.getAttribute('data-tip');
    tipEl.hidden = false;
    const r = tipEl.getBoundingClientRect();
    let x = e.clientX + 14, y = e.clientY + 14;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
    if (y + r.height > innerHeight - 8) y = e.clientY - r.height - 14;
    tipEl.style.left = x + 'px'; tipEl.style.top = y + 'px';
  });
  const tipRows = (title, rows) => esc(`<div class="t">${esc(title)}</div>` + rows.map(([k, v]) => `<div class="r"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join(''));

  // ---------------------------------------------------------------- charts (SVG)
  function stackedBars(days, keys, { height = 200, value = (d, k) => d.byFamily[k] || 0, fmt = usd, label = 'Estimated cost' } = {}) {
    const W = 900, H = height, padL = 46, padB = 22, padT = 8;
    const totals = days.map(d => keys.reduce((s, k) => s + value(d, k), 0));
    const max = Math.max(...totals, 0) || 1;
    const nice = niceMax(max);
    const bw = (W - padL) / Math.max(1, days.length);
    const gap = Math.min(6, bw * 0.25);
    let g = '<g class="grid">';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (H - padB - padT) * (1 - i / 4);
      g += `<line x1="${padL}" x2="${W}" y1="${y}" y2="${y}"/><text x="${padL - 6}" y="${y + 4}" text-anchor="end">${esc(fmt(nice * i / 4))}</text>`;
    }
    g += '</g>';
    const every = Math.ceil(days.length / 10);
    days.forEach((d, i) => {
      const x = padL + i * bw + gap / 2;
      let y = H - padB;
      let segs = '';
      const visible = keys.filter(k => value(d, k) > 0);
      visible.forEach((k, j) => {
        const v = value(d, k);
        const h = (H - padB - padT) * v / nice;
        const top = j === visible.length - 1;
        // 2px surface gap between stacked segments
        const hh = Math.max(0, h - (j > 0 ? 2 : 0));
        y -= h;
        segs += top
          ? `<path class="seg" d="${roundTop(x, y, bw - gap, hh, 4)}" fill="var(--${k})"/>`
          : `<rect class="seg" x="${x}" y="${y}" width="${bw - gap}" height="${hh}" fill="var(--${k})"/>`;
      });
      const rows = keys.filter(k => value(d, k) > 0).map(k => [cap(k), fmt(value(d, k))]);
      rows.push(['Total', fmt(totals[i])]);
      g += `<g class="bar" data-tip="${tipRows(`${d.date} · ${label}`, rows)}"><rect class="hit" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padB - padT}"/>${segs}</g>`;
      if (i % every === 0) g += `<text x="${x + (bw - gap) / 2}" y="${H - 6}" text-anchor="middle">${esc(d.date.slice(5))}</text>`;
    });
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px" role="img" aria-label="${esc(label)} per day">${g}</svg>`
      + `<div class="chart-legend">${keys.map(k => `<span><span class="sw" style="background:var(--${k})"></span>${cap(k)}</span>`).join('')}</div>`;
  }
  function roundTop(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  function hbars(items, { value, label, color, fmt = usd, extra }) {
    const max = Math.max(...items.map(value), 0) || 1;
    return `<div style="display:flex;flex-direction:column;gap:9px">${items.map(it => {
      const v = value(it);
      return `<div data-tip="${tipRows(label(it), [['Value', fmt(v)], ...(extra ? extra(it) : [])])}">
        <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px"><span class="ell" style="max-width:70%">${esc(label(it))}</span><b style="font-variant-numeric:tabular-nums">${esc(fmt(v))}</b></div>
        <div style="height:8px;background:var(--line);border-radius:4px"><div style="height:100%;width:${Math.max(1.5, 100 * v / max)}%;background:${color(it)};border-radius:0 4px 4px 0"></div></div></div>`;
    }).join('')}</div>`;
  }

  // ---------------------------------------------------------------- shared pieces
  function etaBlock(t) {
    const p = t.prediction;
    if (!p) return '';
    if (p.basis === 'none' || p.remainingMs == null) {
      return `<div class="eta"><div class="eta-text"><span>${tag('predicted', 'prediction')} <span class="note">${esc(p.note || 'No estimate yet.')}</span></span><span class="muted">history n=${p.n}</span></div></div>`;
    }
    const el = t.elapsedMs;
    const rem = Math.max(0, p.remainingMs), lo = Math.max(0, p.remainingLowMs ?? rem), hi = Math.max(rem, p.remainingHighMs ?? rem);
    const total = el + hi || 1;
    const basis = { history: `history of ${p.n} tasks (${p.scope})`, progress: 'todo-list completion rate', blend: `todo progress + history (${p.n})` }[p.basis];
    return `<div class="eta" data-tip="${tipRows('Time prediction', [['Basis', basis], ['Confidence', p.confidence], ['Remaining (median)', dur(rem)], ['Range (p25–p80)', `${dur(lo)} – ${dur(hi)}`], ['Calibration', p.calibrationFactor ? `×${p.calibrationFactor} from ${p.calibrationN} past predictions` : 'not yet']])}">
      <div class="eta-bar"><div class="range" style="left:${100 * (el + lo) / total}%;width:${100 * (hi - lo) / total}%"></div><div class="fill" style="width:${100 * el / total}%"></div></div>
      <div class="eta-text"><span>${tag('predicted', 'prediction')} <b data-countdown="${Date.now() + rem}">~${dur(rem)}</b> left <span class="note">(${dur(lo)}–${dur(hi)})</span></span><span class="muted">${esc(p.confidence)} confidence · ${esc(basis)}</span></div></div>`;
  }

  function agentChips(agents) {
    if (!agents || !agents.length) return '';
    return `<div class="chips">${agents.map(a => `<span class="chip" data-tip="${tipRows(a.type || 'subagent', [['Task', a.description || '—'], ['Model', `${a.modelName || 'unknown'} (${a.modelSource || 'no data yet'})`], ['Requests', String(a.requests)], ['Est. cost', usd(a.costUsd)], ['Status', a.status]])}">
      <span class="sw" style="background:${famColor(a.model || a.modelName)}"></span><span class="ell">${esc(a.type || 'agent')}${a.description ? ' · ' + esc(a.description) : ''}</span>
      <b>${esc(a.modelName || 'model pending')}</b>${a.status === 'running' ? '<span class="status running" style="padding:0 4px"><span class="i">●</span></span>' : a.status === 'done' ? '<span class="muted">✓</span>' : ''}</span>`).join('')}</div>`;
  }

  function taskCard(t) {
    const prog = t.progress;
    const running = (t.runningTools || []).map(c => `<span class="chip tool running-tool"><b>${esc(c.name)}</b><span class="ell">${esc(c.summary)}</span></span>`).join('');
    return `<div class="task-card" data-href="#/task/${encodeURIComponent(t.id)}">
      <div class="row1"><div style="display:flex;flex-direction:column;gap:6px;min-width:0">${statusPill(t.status)}<div class="prompt">${esc(t.prompt)}</div></div>
        <div style="text-align:right;flex:none"><div style="font-size:22px;font-weight:650;font-variant-numeric:tabular-nums" data-since="${t.startedAt}">${dur(t.elapsedMs)}</div><div class="muted" style="font-size:12px">elapsed ${tag('measured')}</div></div></div>
      ${t.status === 'blocked' && t.blockedOn ? `<div class="callout"><b>Waiting for your approval:</b> ${esc(t.blockedOn.tool)} <span class="mono">${esc(t.blockedOn.summary)}</span></div>` : ''}
      <div class="meta">
        <span>${esc(t.project || '')}</span>
        ${t.modelName ? `<span><span class="sw" style="background:${famColor(t.model)}"></span><b>${esc(t.modelName)}</b>${t.effort ? ' · ' + esc(t.effort) : ''}</span>` : ''}
        <span><b>${t.toolCount}</b> tool calls</span>
        ${t.toolErrors ? `<span style="color:var(--critical)"><b>${t.toolErrors}</b> errors</span>` : ''}
        <span><b>${usd(t.usage.costUsd)}</b> so far ${tag('estimate')}</span>
        <span><b>${tok(t.usage.tokens)}</b> tokens</span>
      </div>
      ${etaBlock(t)}
      ${prog ? `<div><div class="eta-text" style="margin-bottom:5px"><span>${tag('measured', 'todo list')} <b>${prog.completed}/${prog.total}</b> done${prog.current ? ' · now: ' + esc(prog.current) : ''}</span><span>${pct(prog.completed / prog.total)}</span></div><div class="progress"><div style="width:${100 * prog.completed / prog.total}%"></div></div></div>` : ''}
      ${agentChips(t.agents)}
      ${running ? `<div class="chips">${running}</div>` : ''}
      ${t.advice && t.advice.model ? `<div class="advice">${tag('heuristic', 'advisor')}<span>Suggested <b>${esc(t.advice.model.name)}</b> · effort <b>${esc(t.advice.effort)}</b> <span class="muted">— ${esc((t.advice.reasons || []).filter(r => r.w > 0).slice(0, 2).map(r => r.why).join(', ') || t.advice.why)}</span></span></div>` : ''}
    </div>`;
  }

  function taskRow(t) {
    return `<tr class="click" data-href="#/task/${encodeURIComponent(t.id)}">
      <td>${statusPill(t.status)}</td>
      <td><span class="ell">${esc(t.prompt)}</span><span class="muted" style="font-size:12px">${esc(t.project || '')} · ${ago(t.startedAt)}</span></td>
      <td>${t.modelName ? `<span class="sw" style="background:${famColor(t.model)}"></span>${esc(t.modelName)}` : '<span class="muted">—</span>'}</td>
      <td class="num">${dur(t.elapsedMs)}</td>
      <td class="num">${t.toolCount}${t.toolErrors ? ` <span style="color:var(--critical)">(${t.toolErrors}✗)</span>` : ''}</td>
      <td class="num">${t.agents.length || ''}</td>
      <td class="num">${usd(t.usage.costUsd)}</td>
    </tr>`;
  }
  const taskTable = tasks => tasks.length ? `<table><thead><tr><th>Status</th><th>Prompt</th><th>Model</th><th class="num">Duration</th><th class="num">Tools</th><th class="num">Agents</th><th class="num">Est. cost</th></tr></thead><tbody>${tasks.map(taskRow).join('')}</tbody></table>` : '<div class="empty">No tasks yet.</div>';

  const billingLabel = b => b && b.mode === 'subscription' ? 'Subscription-equivalent' : b && b.mode === 'api' ? 'API cost (estimated)' : 'Token value';
  const kpi = (label, value, hint, tg) => `<div class="panel kpi"><div class="label"><span>${esc(label)}</span>${tg || ''}</div><div class="value">${value}</div>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  const rangeCtl = () => `<div class="seg-ctl" id="range">${['7d', '30d', '90d', 'all'].map(r => `<button data-r="${r}" class="${st.range === r ? 'on' : ''}">${r === 'all' ? 'All time' : 'Last ' + r.replace('d', ' days')}</button>`).join('')}</div>`;
  function bindRange(rerender) {
    $$('#range button').forEach(b => b.onclick = () => { st.range = b.dataset.r; localSet('range', st.range); rerender(); });
  }

  // ---------------------------------------------------------------- views
  const VIEWS = {
    async live() {
      const s = st.snapshot || await api('/api/state');
      const b = s.billing;
      const ccToday = s.sessions.reduce((x, se) => x + ((se.claudeCodeCost && se.claudeCodeCost.usd) || 0), 0);
      return `
      <div class="grid g-kpi">
        ${kpi('Active tasks', s.active.length, `${s.sessions.length} live session${s.sessions.length === 1 ? '' : 's'}`, tag('measured'))}
        ${kpi('Cost today', usd(s.today.costUsd), `${esc(billingLabel(b).toLowerCase())} · ${num(s.today.requests)} requests${s.today.unpriced ? ` · ${s.today.unpriced} unpriced` : ''}`, tag('estimate'))}
        ${kpi('Tokens today', tok(s.today.tokens), `${tok(s.today.output)} output · ${tok(s.today.cacheRead)} cache reads`, tag('measured'))}
        ${kpi('Live sessions', s.sessions.some(se => se.claudeCodeCost && se.claudeCodeCost.usd != null) ? usd(ccToday) : '—', s.sessions.some(se => se.claudeCodeCost) ? 'cost computed by Claude Code itself' : 'appears once Claude Code reports a session cost', tag('reported'))}
        ${kpi('Needs attention', s.active.filter(t => t.status === 'blocked' || t.status === 'waiting').length, `${s.unread} unread notification${s.unread === 1 ? '' : 's'}`, '')}
      </div>
      <div class="grid g-2">
        <div class="panel"><h2>Active tasks <span class="sub">live from Claude Code hooks</span></h2>
          <div class="tasks-live">${s.active.length ? s.active.map(taskCard).join('') : `<div class="empty"><span class="big">◎</span>Nothing running. Start a prompt in Claude Code and it appears here instantly.</div>`}</div></div>
        <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
          <div class="panel"><h2>Sessions</h2>${s.sessions.length ? `<table><tbody>${s.sessions.map(se => `<tr>
              <td><b>${esc(se.project || se.id.slice(0, 8))}</b><div class="muted" style="font-size:12px">${se.modelName ? `<span class="sw" style="background:${famColor(se.model)}"></span>${esc(se.modelName)}` : 'model unknown yet'}${se.effort ? ' · effort ' + esc(se.effort) : ''}${se.permissionMode && se.permissionMode !== 'default' ? ' · ' + esc(se.permissionMode) : ''}</div></td>
              <td class="num">${usd(se.estimate.costUsd)} ${tag('estimate', 'est')}<div class="muted" style="font-size:12px">${se.claudeCodeCost && se.claudeCodeCost.usd != null ? `${usd(se.claudeCodeCost.usd)} reported` : ''}</div></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No live sessions.</div>'}</div>
          <div class="panel"><h2>Notifications</h2>${notifList(s.notifications.slice(0, 6)) || '<div class="empty">No notifications yet.</div>'}</div>
        </div>
      </div>
      <div class="panel"><h2>Recent tasks <a class="link sub" href="#/tasks">All tasks →</a></h2>${taskTable(s.recent.slice(0, 10))}</div>`;
    },

    async tasks() {
      const q = st.taskQuery || '', status = st.taskStatus || '';
      const r = await api(`/api/tasks?limit=200&q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`);
      return `<div class="toolbar"><div class="seg-ctl" id="tstatus">${[['', 'All'], ['active', 'Active'], ['completed', 'Completed'], ['failed', 'Failed'], ['interrupted', 'Interrupted']].map(([k, l]) => `<button data-s="${k}" class="${status === k ? 'on' : ''}">${l}</button>`).join('')}</div>
        <input type="text" id="tq" placeholder="Search prompts or projects…" value="${esc(q)}" style="max-width:320px"></div>
        <div class="panel">${taskTable(r.tasks)}<div class="muted" style="font-size:12px;margin-top:10px">${r.tasks.length} of ${r.total} tracked tasks. Tasks from before installation are reconstructed from transcripts and appear in Analytics.</div></div>`;
    },

    async task(id) {
      const t = await api('/api/tasks/' + encodeURIComponent(id));
      const u = t.usage;
      const lanes = toolLanes(t);
      const pas = t.predictionAtStart;
      return `<a class="back" href="#/tasks">← All tasks</a>
      <div class="panel"><div style="display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap">${statusPill(t.status)}<span class="muted">${esc(t.project || '')} · started ${new Date(t.startedAt).toLocaleString()}${t.reason ? ' · ' + esc(t.reason) : ''}</span></div>
        <pre class="msg" style="margin-top:12px">${esc(t.prompt)}</pre></div>
      <div class="grid g-kpi">
        ${kpi('Duration', `<span ${t.endedAt ? '' : `data-since="${t.startedAt}"`}>${dur(t.elapsedMs)}</span>`, t.endedAt ? 'finished ' + ago(t.endedAt) : 'still running', tag('measured'))}
        ${kpi('Predicted at start', pas && pas.p50Ms ? dur(pas.p50Ms) : '—', pas && pas.p50Ms ? `range ${dur(pas.p25Ms)}–${dur(pas.p80Ms)} · n=${pas.n}` : esc(pas ? pas.note : ''), tag('predicted'))}
        ${kpi('Cost', usd(u.costUsd), `${esc(billingLabel(st.snapshot && st.snapshot.billing).toLowerCase())} · ${u.requests} requests${u.unpriced ? ` · ${u.unpriced} unpriced` : ''}`, tag('estimate'))}
        ${kpi('Tokens', tok(u.tokens), `${tok(u.input)} in · ${tok(u.output)} out · ${tok(u.cacheRead)} cache read · ${tok(u.cacheWrite)} cache write`, tag('measured'))}
        ${kpi('Tool calls', t.toolCount, t.toolErrors ? `<span style="color:var(--critical)">${t.toolErrors} errors</span>` : 'no errors', tag('measured'))}
      </div>
      ${t.prediction ? `<div class="panel"><h2>Remaining time</h2>${etaBlock(t)}</div>` : ''}
      <div class="grid g-2e">
        <div class="panel"><h2>Cost by model ${tag('estimate')}</h2>${u.byModel.length ? hbars(u.byModel, { value: m => m.costUsd, label: m => m.name, color: m => famColor(m.model), extra: m => [['Requests', String(m.requests)], ['Tokens', tok(m.tokens)]] }) : '<div class="empty">No usage recorded for this task yet.</div>'}</div>
        <div class="panel"><h2>Cost by agent ${tag('estimate')}</h2>${u.byAgent.length ? `<table><thead><tr><th>Agent</th><th>Models</th><th class="num">Req.</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>${u.byAgent.map(a => `<tr><td><span class="ell" style="max-width:260px">${esc(a.label)}</span></td><td>${Object.entries(a.models).map(([m, n]) => `<span class="sw" style="background:${famColor(m)}"></span>${esc(m)} <span class="muted">×${n}</span>`).join(' ')}</td><td class="num">${a.requests}</td><td class="num">${tok(a.tokens)}</td><td class="num">${usd(a.costUsd)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">—</div>'}</div>
      </div>
      ${t.agents.length ? `<div class="panel"><h2>Subagents</h2><table><thead><tr><th>Type</th><th>Task</th><th>Model</th><th>Status</th><th class="num">Duration</th><th class="num">Requests</th><th class="num">Cost</th></tr></thead><tbody>${t.agents.map(a => `<tr><td>${esc(a.type || '—')}</td><td><span class="ell" style="max-width:300px">${esc(a.description || '')}</span></td><td><span class="sw" style="background:${famColor(a.model || a.modelName)}"></span>${esc(a.modelName || '?')} <span class="muted" style="font-size:11px">${esc(a.modelSource || '')}</span></td><td>${esc(a.status)}</td><td class="num">${dur(a.durationMs)}</td><td class="num">${a.requests}</td><td class="num">${usd(a.costUsd)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="panel"><h2>Tool timeline <span class="sub">${t.tools.length} calls · hover a block</span></h2>${lanes}</div>
      ${t.advice ? `<div class="panel"><h2>Prompt intelligence ${tag('heuristic')}</h2>${adviceBlock(t.advice)}</div>` : ''}
      ${t.lastMessage ? `<div class="panel"><h2>Claude's last message</h2><pre class="msg">${esc(t.lastMessage)}</pre></div>` : ''}`;
    },

    async models() {
      const m = await api('/api/models?range=' + st.range);
      const a = await api('/api/analytics?range=' + st.range);
      return `<div class="toolbar">${rangeCtl()}<span class="muted">${num(m.total)} model requests ${tag('measured')}</span></div>
      <div class="panel"><h2>Models in use</h2>${m.models.length ? `<table><thead><tr><th>Model</th><th>Share of requests</th><th class="num">Requests</th><th class="num">Main / subagents</th><th class="num">Output tok.</th><th class="num">Cache read</th><th class="num">Est. cost</th><th>Used by</th><th>Last used</th></tr></thead><tbody>
        ${m.models.map(x => `<tr><td><span class="sw" style="background:${famColor(x.model)}"></span><b>${esc(x.name)}</b><div class="mono muted">${esc(x.model)}</div></td>
          <td><span class="share" style="width:${Math.max(2, x.share * 140)}px;background:${famColor(x.model)}"></span>${pct(x.share)}</td>
          <td class="num">${num(x.requests)}</td><td class="num">${num(x.mainRequests)} / ${num(x.subagentRequests)}</td><td class="num">${tok(x.output)}</td><td class="num">${tok(x.cacheRead)}</td>
          <td class="num">${x.unpriced ? '<span class="muted">unpriced</span>' : usd(x.costUsd)}</td>
          <td>${Object.entries(x.agentTypes).map(([k, n]) => `<span class="chip">${esc(k)} ×${n}</span>`).join(' ') || '<span class="muted">main only</span>'}</td><td class="muted">${ago(x.lastUsed)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No model usage in this range.</div>'}</div>
      <div class="panel"><h2>Which agent uses which model <span class="sub">share of requests per agent type</span></h2>
        ${a.byAgentType.length ? `<div style="display:flex;flex-direction:column;gap:12px">${a.byAgentType.map(t => {
          const total = Object.values(t.models).reduce((x, y) => x + y, 0);
          const entries = Object.entries(t.models).sort((p, q) => q[1] - p[1]);
          return `<div><div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px"><b>${esc(t.type)}</b><span class="muted">${num(t.requests)} requests · ${usd(t.costUsd)}</span></div>
            <div style="display:flex;height:12px;gap:2px">${entries.map(([mn, n], i) => `<div data-tip="${tipRows(t.type, [[mn, `${n} requests (${pct(n / total)})`]])}" style="flex:${n};background:${famColor(mn)};border-radius:${i === 0 ? '4px 0 0 4px' : '0'} ${i === entries.length - 1 ? '4px 4px 0' : ''}"></div>`).join('')}</div>
            <div class="chart-legend">${entries.map(([mn, n]) => `<span><span class="sw" style="background:${famColor(mn)}"></span>${esc(mn)} ${pct(n / total)}</span>`).join('')}</div></div>`;
        }).join('')}</div>` : '<div class="empty">No data.</div>'}</div>`;
    },

    async costs() {
      const a = await api('/api/analytics?range=' + st.range);
      const pr = await api('/api/pricing');
      const admin = await api('/api/admin-cost');
      const b = a.billing;
      const fams = ['opus', 'sonnet', 'haiku', 'fable', 'other'].filter(f => a.days.some(d => d.byFamily[f]));
      const modeText = b.mode === 'subscription'
        ? `<b>You are on a Claude subscription</b> (${esc(b.source)}). You are not billed per token, so token costs here are a <b>subscription-equivalent value</b>: what the same usage would cost at API list prices.`
        : b.mode === 'api'
          ? `<b>You pay per token</b> (${esc(b.source)}). Token costs here are an <b>estimate of your API spend</b> at list prices. The invoiced amount comes only from the Admin API (add a key in Settings).`
          : `<b>Billing mode unknown</b> (${esc(b.source)}). Choose it in Settings so costs are labelled correctly.`;
      return `<div class="toolbar">${rangeCtl()}</div>
      <div class="callout">${modeText}</div>
      <div class="grid g-kpi">
        ${kpi('At list prices', usd(a.totals.costUsd), `${esc(billingLabel(b).toLowerCase())} · ${num(a.totals.requests)} requests · ${tok(a.totals.tokens)} tokens${a.totals.unpriced ? ` · ${a.totals.unpriced} unpriced` : ''}`, tag('estimate'))}
        ${kpi('Reported by Claude Code', usd(a.claudeCodeReported.usd), `${a.claudeCodeReported.sessions} sessions · latest snapshot each`, tag('reported'))}
        ${kpi('Invoiced (Admin API)', admin.configured ? (admin.error ? '—' : usd(admin.totalUsd)) : '—', admin.configured ? (admin.error ? esc(admin.error) : 'last 30 days, organization-wide') : 'Not configured: API users can add an Admin key in Settings', tag('invoiced'))}
        ${kpi('Cache reads', tok(a.totals.cacheRead), `${pct(a.totals.cacheRead / Math.max(1, a.totals.cacheRead + a.totals.input + a.totals.cacheWrite))} of input tokens came from cache`, tag('measured'))}
      </div>
      <div class="panel"><h2>Daily ${esc(billingLabel(b).toLowerCase())} by model family ${tag('estimate')}</h2>${a.totals.requests ? stackedBars(a.days, fams.length ? fams : ['other']) : '<div class="empty">No usage in this range.</div>'}</div>
      <div class="grid g-2e">
        <div class="panel"><h2>By model ${tag('estimate')}</h2>${hbars(a.totals.byModel.slice(0, 10), { value: m => m.costUsd, label: m => m.name, color: m => famColor(m.model), extra: m => [['Requests', num(m.requests)], ['Output tokens', tok(m.output)]] })}</div>
        <div class="panel"><h2>By agent type ${tag('estimate')}</h2>${hbars(a.byAgentType.slice(0, 10), { value: x => x.costUsd, label: x => x.type, color: () => 'var(--accent)', extra: x => [['Requests', num(x.requests)]] })}</div>
      </div>
      <div class="grid g-2e">
        <div class="panel"><h2>By project ${tag('estimate')}</h2>${a.projects.length ? `<table><thead><tr><th>Project</th><th class="num">Sessions</th><th class="num">Requests</th><th class="num">Cost</th></tr></thead><tbody>${a.projects.map(p => `<tr><td>${esc(p.project)}</td><td class="num">${p.sessions}</td><td class="num">${num(p.requests)}</td><td class="num">${usd(p.costUsd)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">—</div>'}</div>
        <div class="panel"><h2>How costs are calculated <span class="sub">USD per million tokens · table ${esc(pr.date)}</span></h2>
          <table><thead><tr><th>Model</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache read</th><th class="num">Write 5m</th><th class="num">Write 1h</th></tr></thead><tbody>${pr.rows.map(r => `<tr><td>${esc(r.name)}${r.verified ? '' : ' <span class="muted" title="Legacy model: older published rate">†</span>'}</td><td class="num">${r.input}</td><td class="num">${r.output}</td><td class="num">${r.cacheRead}</td><td class="num">${r.cacheWrite5m}</td><td class="num">${r.cacheWrite1h}</td></tr>`).join('')}</tbody></table>
          <div class="muted" style="font-size:12px;margin-top:8px">Cache writes: 5-minute = 1.25× input, 1-hour = 2× input. Haiku 5.5 prompts over 100K tokens: $0.50 / $2.50. Fast mode ×${pr.fastMultiplier}. Models not in the table are shown as unpriced, never guessed. † legacy rate.</div></div>
      </div>`;
    },

    async analytics() {
      const a = await api('/api/analytics?range=' + st.range);
      const T = a.tasks, P = a.prediction, A = a.advisor;
      const done = T.tierStats.reduce((s, x) => s + x.completed, 0), all = T.tierStats.reduce((s, x) => s + x.n, 0);
      const maxHeat = Math.max(1, ...a.heat.flat());
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `<div class="toolbar">${rangeCtl()}<span class="muted">${T.tracked} tasks tracked live · ${T.reconstructed} reconstructed from transcripts</span></div>
      <div class="grid g-kpi">
        ${kpi('Tasks', num(all), `${T.tracked} live-tracked (${T.failed} failed, ${T.interrupted} interrupted) + ${T.reconstructed} from transcripts`, tag('measured'))}
        ${kpi('Completion rate', pct(all ? done / all : null), 'completed ÷ all finished tasks', tag('measured'))}
        ${kpi('Tool errors', num(T.toolErrors), 'failed tool calls in range', tag('measured'))}
        ${kpi('Prediction error', P.n >= 3 ? pct(P.medianAbsPctError) : '—', P.n >= 3 ? `median of ${P.n} predictions · ${pct(P.withinRangeRate)} landed in range` : `needs 3 finished predicted tasks (have ${P.n || 0})`, tag('predicted'))}
      </div>
      <div class="panel"><h2>Daily tokens ${tag('measured')}</h2>${stackedBars(a.days, ['opus'], { value: d => d.tokens, fmt: tok, label: 'Tokens' }).replace(/var\(--opus\)/g, 'var(--accent)').replace(/<div class="chart-legend">.*<\/div>$/, '')}</div>
      <div class="panel"><h2>Task performance by complexity tier <span class="sub">tier from the prompt advisor ${tag('heuristic')}</span></h2>
        ${T.tierStats.length ? `<table><thead><tr><th>Tier</th><th class="num">Tasks</th><th class="num">Completed</th><th class="num">Failed</th><th class="num">Interrupted</th><th class="num">Median duration</th><th class="num">p90 duration</th><th class="num">Median cost</th></tr></thead><tbody>${T.tierStats.map(x => `<tr><td><b>${esc(x.tier)}</b></td><td class="num">${x.n}</td><td class="num">${x.completed}</td><td class="num">${x.failed}</td><td class="num">${x.interrupted}</td><td class="num">${dur(x.medianDurationMs)}</td><td class="num">${dur(x.p90DurationMs)}</td><td class="num">${x.costSamples ? usd(x.medianCostUsd) : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">No finished tasks in this range.</div>'}</div>
      <div class="grid g-2e">
        <div class="panel"><h2>Is the time predictor improving? ${tag('predicted')}</h2>${P.n ? `<dl class="kv"><dt>Predictions checked</dt><dd>${P.n}</dd><dt>Median error, all</dt><dd>${pct(P.medianAbsPctError)}</dd><dt>Median error, earliest half</dt><dd>${P.earlyMedianAbsPctError != null ? pct(P.earlyMedianAbsPctError) : 'needs ≥6 predictions'}</dd><dt>Median error, recent half</dt><dd>${P.recentMedianAbsPctError != null ? pct(P.recentMedianAbsPctError) : '—'}</dd><dt>Landed inside predicted range</dt><dd>${pct(P.withinRangeRate)}</dd></dl><div class="muted" style="font-size:12px;margin-top:10px">Each finished task is compared with the prediction made when it started. The learned calibration factor per tier corrects later predictions.</div>` : '<div class="empty">Predictions are scored once predicted tasks finish. Until then, estimates come from transcript history.</div>'}</div>
        <div class="panel"><h2>Advisor vs the model you used ${tag('heuristic')}</h2>${A.compared ? `<dl class="kv"><dt>Tasks compared</dt><dd>${A.compared}</dd><dt>Same model family</dt><dd>${A.aligned}</dd><dt>You used a heavier model</dt><dd>${A.heavier}</dd><dt>You used a lighter model</dt><dd>${A.lighter}</dd><dt>Main-session cost, actual tokens</dt><dd>${usd(A.actualMainUsd)} ${tag('estimate')}</dd><dt>Same tokens at suggested model</dt><dd>${usd(A.whatIfRecommendedUsd)} ${tag('estimate')}</dd></dl><div class="muted" style="font-size:12px;margin-top:10px">The what-if figure re-prices the same tokens. A different model would use a different number of tokens, so treat it as a rough comparison only.</div>` : '<div class="empty">Appears after live-tracked tasks finish.</div>'}</div>
      </div>
      <div class="panel"><h2>When you work with Claude <span class="sub">model requests by weekday and hour</span></h2>
        <div class="heat"><span></span>${Array.from({ length: 24 }, (_, h) => `<span style="text-align:center">${h % 3 === 0 ? h : ''}</span>`).join('')}
        ${a.heat.map((row, d) => `<span>${days[d]}</span>${row.map((v, h) => `<span class="c" data-tip="${tipRows(`${days[d]} ${h}:00–${h + 1}:00`, [['Requests', String(v)]])}" style="${v ? `background:color-mix(in srgb, var(--opus) ${15 + 85 * v / maxHeat}%, var(--line))` : ''}"></span>`).join('')}`).join('')}</div></div>`;
    },

    async advisor() {
      return `<div class="grid g-2">
        <div class="panel"><h2>Try a prompt ${tag('heuristic')}</h2>
          <textarea id="adv-text" placeholder="Paste a prompt to see which model and effort Command Center would suggest, and why…">${esc(st.advText || '')}</textarea>
          <div style="margin-top:10px;display:flex;gap:8px"><button class="btn" id="adv-go">Analyze</button><span class="muted" style="align-self:center;font-size:12px">Runs locally. Every prompt you send in Claude Code is analyzed the same way.</span></div>
          <div id="adv-out" style="margin-top:16px"></div></div>
        <div class="panel"><h2>How the advisor decides</h2>
          <table><thead><tr><th>Tier</th><th>Suggests</th><th>Effort</th></tr></thead><tbody>
          ${[['trivial', 'Haiku 5.5', 'low', 'lookups, short questions, mechanical edits'], ['simple', 'Sonnet 5.5', 'low', 'small, well-specified changes'], ['moderate', 'Sonnet 5.5', 'medium', 'routine features and bug fixes'], ['complex', 'Opus 5.5', 'high', 'multi-step work, reasoning quality matters'], ['hard', 'Opus 5.5', 'xhigh', 'deep, long-horizon engineering'], ['frontier', 'Fable 5.1', 'high', 'very large autonomous builds and research']].map(([t, m, e, d]) => `<tr><td><b>${t}</b><div class="muted" style="font-size:12px">${d}</div></td><td><span class="sw" style="background:${famColor(m)}"></span>${m}</td><td>${e}</td></tr>`).join('')}
          </tbody></table>
          <div class="muted" style="font-size:12px;margin-top:10px">A transparent rule set scores length, structure, code or stack traces, and keywords for architecture, security, debugging, scope and autonomy. It only suggests. Claude Code keeps the model you picked, and you switch with <span class="mono">/model</span> if you agree.</div></div></div>`;
    },

    async settings() {
      const c = st.cfg = await api('/api/config');
      const s = st.snapshot || await api('/api/state');
      const n = c.notifications;
      const sw = (id, on, label, help) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span><b>${label}</b>${help ? `<div class="muted" style="font-size:12px">${help}</div>` : ''}</span></label>`;
      return `<div class="grid g-2e">
        <div class="panel"><h2>Costs</h2>
          <div class="field"><label>Billing mode</label><select id="billing">${[['auto', `Detect automatically (now: ${s.billing.mode})`], ['subscription', 'Claude subscription (Pro / Max / Team): show subscription-equivalent value'], ['api', 'API key / cloud provider: show estimated API spend']].map(([v, l]) => `<option value="${v}" ${c.billing === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select><div class="help">Detected: ${esc(s.billing.source)}</div></div>
          <div class="field"><label>Anthropic Admin API key (optional)</label><input type="password" id="admin" placeholder="sk-ant-admin…" value="${esc(c.adminApiKey)}"><div class="help">Only for API organizations. Used to read your invoiced cost from the Admin API cost report, stored locally in ~/.claude-command-center/config.json, and sent only to api.anthropic.com.</div></div>
        </div>
        <div class="panel"><h2>Notifications</h2>
          ${sw('n-desktop', n.desktop, 'Desktop notifications', 'Windows toast notifications (Action Center). The dashboard also shows them.')}
          ${sw('n-finish', n.onFinish, 'When a task finishes')}
          <div class="field" style="margin-left:46px"><label style="font-weight:400">…if it ran at least <input type="number" id="n-min" value="${n.finishMinSeconds}" min="0" style="width:80px;display:inline-block"> seconds</label></div>
          ${sw('n-fail', n.onFail, 'When a task fails', 'API errors that end the turn (StopFailure).')}
          ${sw('n-att', n.onAttention, 'When Claude needs you', 'Permission prompts, questions, plans to review, waiting for input.')}
          <div class="field"><label>Warn after this many tool errors in one task (0 = off)</label><input type="number" id="n-err" value="${n.onToolErrors}" min="0" style="width:100px"></div>
          ${sw('n-sound', n.sound, 'Play sound')}
          <button class="btn secondary" id="test-notify">Send a test notification</button> <span id="test-out" class="muted"></span>
        </div>
        <div class="panel"><h2>Prompt intelligence</h2>
          ${sw('adv-chat', c.advisor.showInChat, 'Show the suggestion in Claude Code', 'One line under each prompt (a hook systemMessage). It is shown to you and is not sent to the model.')}
        </div>
        <div class="panel"><h2>About the numbers</h2>
          <dl class="kv"><dt>${tag('measured')}</dt><dd>Read from Claude Code: hook events, transcript usage records, its todo list.</dd><dt>${tag('estimate')}</dt><dd>Measured tokens × published list prices.</dd><dt>${tag('reported')}</dt><dd>Cost Claude Code itself recorded for a session.</dd><dt>${tag('invoiced')}</dt><dd>From the Anthropic Admin API, if configured.</dd><dt>${tag('predicted')}</dt><dd>Forecast from your measured history, with sample size and basis shown.</dd><dt>${tag('heuristic')}</dt><dd>Rule-based suggestion. Nothing is changed automatically.</dd></dl>
          <div class="muted" style="font-size:12px;margin-top:10px">Data stays on this computer (~/.claude-command-center). The backend listens on 127.0.0.1 only. ${num(s.health.usageRecords)} usage records, ${num(s.health.events)} hook events.</div></div>
      </div>
      <div><button class="btn" id="save">Save settings</button> <span id="save-out" class="muted"></span></div>`;
    },
  };

  function adviceBlock(a) {
    return `<div class="big-rec"><span class="sw" style="width:16px;height:16px;border-radius:5px;background:${famColor(a.model.name)}"></span><div><div class="model">${esc(a.model.name)} · ${esc(a.effort)}</div><div class="muted">${esc(a.tier)} tier · score ${a.score} · ${esc(a.confidence)} confidence · ${esc(a.model.price)}</div></div></div>
      <p style="color:var(--text-2)">${esc(cap(a.why))}.</p>
      ${a.reasons.length ? `<ul class="reasons">${a.reasons.map(r => `<li><span class="${r.w > 0 ? 'w-pos' : 'w-neg'}">${r.w > 0 ? '+' : ''}${r.w}</span> ${esc(r.why)}</li>`).join('')}</ul>` : '<div class="muted">No strong signals; defaulting by length.</div>'}`;
  }

  function toolLanes(t) {
    if (!t.tools.length) return '<div class="empty">No tool calls.</div>';
    const start = t.startedAt, end = (t.endedAt || Date.now());
    const span = Math.max(1000, end - start);
    const groups = {};
    for (const c of t.tools.slice().reverse()) {
      const key = c.agentId ? (t.agents.find(a => a.id === c.agentId) || { type: 'subagent' }).type + ' · ' + c.agentId.slice(0, 6) : 'Main session';
      (groups[key] = groups[key] || []).push(c);
    }
    const rows = [];
    for (const [g, calls] of Object.entries(groups)) {
      const byName = {};
      for (const c of calls) (byName[c.name] = byName[c.name] || []).push(c);
      for (const [name, cs] of Object.entries(byName)) {
        rows.push(`<div class="lane"><div class="name" title="${esc(g)}">${esc(g === 'Main session' ? name : `${name} (${g})`)}</div><div class="track">${cs.map(c => {
          const s0 = Math.max(0, (c.startedAt - start) / span), w = Math.max(0.004, ((c.endedAt || end) - c.startedAt) / span);
          return `<div class="blk ${esc(c.status)}" style="left:${100 * s0}%;width:${100 * w}%" data-tip="${tipRows(c.name, [['Status', c.status], ['Duration', c.durationMs != null ? dur(c.durationMs) : c.endedAt ? dur(c.endedAt - c.startedAt) : 'running'], ['Detail', (c.summary || '').slice(0, 90)], ...(c.error ? [['Error', c.error.slice(0, 90)]] : [])])}"></div>`;
        }).join('')}</div></div>`);
      }
    }
    return `<div class="lanes">${rows.join('')}</div><div class="chart-legend"><span><span class="sw" style="background:var(--accent)"></span>completed</span><span><span class="sw" style="background:var(--critical)"></span>error</span><span><span class="sw" style="background:var(--muted)"></span>denied / interrupted</span><span class="muted">0 → ${dur(span)}</span></div>`;
  }

  function notifList(list) {
    if (!list.length) return '';
    return list.map(n => `<div class="notif ${n.read ? '' : 'unread'}" data-href="#/task/${encodeURIComponent(n.taskId)}"><div class="ni k-${esc(n.kind)}">${NOTIF_ICON[n.kind] || '•'}</div><div style="min-width:0"><div class="nt">${esc(n.title)}</div><div class="nb">${esc(n.body)}</div><div class="nw">${esc(n.project || '')} · ${ago(n.at)}</div></div></div>`).join('');
  }

  // ---------------------------------------------------------------- after-render wiring
  function wire(name) {
    $$('[data-href]', view).forEach(el => el.addEventListener('click', e => { if (!e.target.closest('a')) location.hash = el.dataset.href; }));
    if (['models', 'costs', 'analytics'].includes(name)) bindRange(() => render(true));
    if (name === 'tasks') {
      $$('#tstatus button').forEach(b => b.onclick = () => { st.taskStatus = b.dataset.s; render(true); });
      const q = $('#tq');
      let tmo;
      q.oninput = () => { clearTimeout(tmo); tmo = setTimeout(() => { st.taskQuery = q.value; render(true).then(() => { const n = $('#tq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }); }, 250); };
    }
    if (name === 'advisor') {
      const go = async () => {
        st.advText = $('#adv-text').value;
        const r = await post('/api/advise', { prompt: st.advText });
        const p = r.prediction;
        $('#adv-out').innerHTML = adviceBlock(r.advice) + `<div class="callout" style="margin-top:12px">${tag('predicted')} ${p.basis !== 'none' ? `Similar tasks took <b>${dur(p.p50Ms)}</b> (range ${dur(p.p25Ms)}–${dur(p.p80Ms)}, ${p.n} tasks, ${esc(p.scope)}).` : esc(p.note)}</div><div class="muted" style="font-size:12px;margin-top:10px">Shown in Claude Code as:<br><span class="mono">${esc(r.chatLine)}</span></div>`;
      };
      $('#adv-go').onclick = go;
      if (st.advText) go();
    }
    if (name === 'settings') {
      $('#test-notify').onclick = async () => { const r = await post('/api/notify/test'); $('#test-out').textContent = r.sent ? 'Sent. Check the bottom-right of your screen.' : 'Desktop notifications are off or unavailable.'; };
      $('#save').onclick = async () => {
        const patch = {
          billing: $('#billing').value,
          advisor: { showInChat: $('#adv-chat').checked },
          notifications: { desktop: $('#n-desktop').checked, onFinish: $('#n-finish').checked, finishMinSeconds: Number($('#n-min').value) || 0, onFail: $('#n-fail').checked, onAttention: $('#n-att').checked, onToolErrors: Number($('#n-err').value) || 0, sound: $('#n-sound').checked },
        };
        const k = $('#admin').value.trim();
        if (!k.startsWith('••••')) patch.adminApiKey = k;
        await post('/api/config', patch);
        $('#save-out').textContent = 'Saved.';
        refreshSnapshot();
      };
    }
  }

  // ---------------------------------------------------------------- router & render
  const TITLES = { live: 'Live', tasks: 'Tasks', task: 'Task', models: 'Models', costs: 'Costs', analytics: 'Analytics', advisor: 'Prompt advisor', settings: 'Settings' };
  let rendering = null;
  async function render(force) {
    const [name, arg] = (location.hash.replace(/^#\/?/, '') || 'live').split('/');
    const v = VIEWS[name] ? name : 'live';
    $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === v || (v === 'task' && a.dataset.view === 'tasks')));
    $('#title').textContent = TITLES[v];
    if (!force && (v === 'settings' || v === 'advisor') && view.dataset.view === v) return; // don't clobber forms
    const scroll = view.dataset.view === v + (arg || '') ? main().scrollTop : 0;
    if (view.dataset.view !== v + (arg || '')) view.innerHTML = '<div class="shimmer"></div><div class="shimmer" style="height:240px"></div>';
    const p = (async () => {
      try {
        const html = await VIEWS[v](arg && decodeURIComponent(arg));
        view.innerHTML = html;
        view.dataset.view = v + (arg || '');
        wire(v);
        main().scrollTop = scroll;
      } catch (e) {
        view.innerHTML = `<div class="panel"><div class="empty"><span class="big">⚠</span>Could not load this view (${esc(e.message)}). Is the backend running? Try <span class="mono">ccc start</span>.</div></div>`;
      }
    })();
    rendering = p;
    return p;
  }
  const main = () => document.querySelector('main');
  window.addEventListener('hashchange', () => render(true));

  async function refreshSnapshot() {
    try {
      st.snapshot = await api('/api/state');
      const b = st.snapshot.billing;
      $('#billing-pill').textContent = b.mode === 'subscription' ? '◇ Subscription · costs are equivalent value' : b.mode === 'api' ? '◇ API billing · costs are estimates' : '◇ Billing mode unknown';
      const u = st.snapshot.unread;
      $('#unread').hidden = !u; $('#unread').textContent = u;
      document.title = (st.snapshot.active.length ? `● ${st.snapshot.active.length} running · ` : '') + 'Claude Command Center';
      if (!$('#drawer').hidden) $('#drawer-list').innerHTML = notifList(st.snapshot.notifications) || '<div class="empty">No notifications.</div>';
    } catch { /* offline: connection indicator shows it */ }
  }

  // live data views refresh on server change signals (throttled)
  let refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      await refreshSnapshot();
      const v = (location.hash.replace(/^#\/?/, '') || 'live').split('/')[0];
      if (['live', 'tasks', 'task'].includes(v) && document.visibilityState === 'visible' && !document.activeElement.matches('input,textarea,select')) render();
    }, 700);
  }

  // ---------------------------------------------------------------- SSE + notifications
  function connect() {
    const es = new EventSource('/api/events');
    const conn = $('#conn');
    es.addEventListener('hello', () => { conn.className = 'conn on'; $('#conn-text').textContent = 'Live · connected'; });
    es.addEventListener('changed', scheduleRefresh);
    es.addEventListener('notification', e => {
      const n = JSON.parse(e.data);
      if (!n) return;
      toast(n);
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted' && !n.desktop) {
        try { new Notification(n.title, { body: n.body, icon: 'icon.svg', tag: n.id }); } catch { /* ignore */ }
      }
    });
    es.onerror = () => { conn.className = 'conn off'; $('#conn-text').textContent = 'Backend offline · retrying'; };
  }
  function toast(n) {
    const el = document.createElement('div');
    el.className = `toast k-${n.kind}`;
    el.innerHTML = `<div style="font-weight:600">${esc(n.title)}</div><div class="muted" style="font-size:12.5px">${esc(n.body)}</div>`;
    el.onclick = () => { location.hash = `#/task/${encodeURIComponent(n.taskId)}`; el.remove(); };
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }
  $('#bell').onclick = () => {
    const d = $('#drawer');
    d.hidden = !d.hidden;
    if (!d.hidden) $('#drawer-list').innerHTML = notifList((st.snapshot || { notifications: [] }).notifications) || '<div class="empty">No notifications.</div>';
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  };
  $('#drawer').addEventListener('click', e => { const n = e.target.closest('[data-href]'); if (n) { location.hash = n.dataset.href; $('#drawer').hidden = true; } });
  $('#mark-read').onclick = async () => { await post('/api/notifications/read'); refreshSnapshot(); };

  // ticking clocks: elapsed and countdowns update every second without refetching
  setInterval(() => {
    const now = Date.now();
    $$('[data-since]').forEach(el => { el.textContent = dur(now - Number(el.dataset.since)); });
    $$('[data-countdown]').forEach(el => { const left = Number(el.dataset.countdown) - now; el.textContent = left > 0 ? '~' + dur(left) : 'any moment'; });
  }, 1000);

  refreshSnapshot().then(() => render(true));
  connect();
})();
