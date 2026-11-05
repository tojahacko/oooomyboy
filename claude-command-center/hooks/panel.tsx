// Claude Command Center panel: a pane beside the chat in Claude Code (desktop app Code tab,
// local sessions, and the terminal). It shows what the local Command Center backend measures:
// active tasks, predicted remaining time, cost, subagents and their models, alerts.
// It reads http://127.0.0.1:<port>/api/state; it never changes what Claude does.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PanelSnapshot, PanelTask } from '../types'

const PANE = 'command-center'
const EMPTY: PanelSnapshot = {
  isOnline: false, fetchedAt: 0, billingMode: 'unknown', costTodayUsd: 0, tokensToday: 0, requestsToday: 0,
  unread: 0, active: [], recent: [], notices: [], error: '',
}
const snapshot = atom({ plugin: 'command-center', key: 'snapshot' } as const, EMPTY, { shape: 'snapshot-1' })
const now = atom({ plugin: 'command-center', key: 'now' } as const, 0)

// ---------------------------------------------------------------- formatting
const usd = (v: number | null | undefined): string =>
  v == null || !isFinite(v) ? '—' : v === 0 ? '$0.00' : v < 0.01 ? '<$0.01' : '$' + (v < 100 ? v.toFixed(2) : v.toFixed(0))
const tok = (n: number): string => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)))
function dur(ms: number | null | undefined): string {
  if (ms == null || !isFinite(ms)) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)
const xml = (s: string): string => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Colors: model families use the dashboard's validated categorical slots; status colors are
// reserved and always come with an icon and a word.
const FAMILY: Record<string, string> = { opus: '#3987e5', sonnet: '#d95926', haiku: '#199e70', fable: '#c98500', other: '#8d8c99' }
const familyOf = (m: string | null): string => {
  const x = /(fable|mythos|opus|sonnet|haiku)/i.exec(m || '')
  const f = x && x[1] ? x[1].toLowerCase() : 'other'
  return f === 'mythos' ? 'fable' : f
}
const ACCENT = '#8b7cf6'
const STATUS: Record<string, [string, string, string]> = {
  running: ['●', 'Running', '#0ca30c'], blocked: ['⏸', 'Needs approval', '#fab219'], waiting: ['?', 'Waiting for you', '#fab219'],
  background: ['◐', 'Background agents', '#3987e5'], completed: ['✓', 'Completed', '#0ca30c'], failed: ['✗', 'Failed', '#d03b3b'],
  interrupted: ['■', 'Interrupted', '#8d8c99'],
}
const statusOf = (s: string): [string, string, string] => STATUS[s] ?? ['•', s, '#8d8c99']
const FONT = "'Segoe UI Variable Text','Segoe UI',-apple-system,BlinkMacSystemFont,system-ui,sans-serif"

// ---------------------------------------------------------------- backend
async function port($: EngineInterface, option: unknown): Promise<number> {
  // CCC_PORT (also read by the backend and the hooks) wins, then the plugin setting.
  const env = Number(await $.env.get('CCC_PORT'))
  if (env > 0) return env
  const fromOption = Number(option)
  return fromOption > 0 ? fromOption : 47821
}

function toTask(t: any): PanelTask {
  const p = t.prediction || {}
  const todos: { status: string }[] = t.todos || []
  return {
    id: String(t.id), status: String(t.status), prompt: String(t.prompt || ''), project: String(t.project || ''),
    startedAt: Number(t.startedAt), elapsedMs: Number(t.elapsedMs), modelName: t.modelName ?? null, model: t.model ?? null,
    toolCount: Number(t.toolCount || 0), toolErrors: Number(t.toolErrors || 0),
    costUsd: Number((t.usage && t.usage.costUsd) || 0), tokens: Number((t.usage && t.usage.tokens) || 0),
    remainingMs: p.remainingMs ?? null, remainingLowMs: p.remainingLowMs ?? null, remainingHighMs: p.remainingHighMs ?? null,
    predictionBasis: String(p.basis || 'none'), predictionN: Number(p.n || 0), predictionNote: String(p.note || ''),
    todoDone: todos.filter(x => x.status === 'completed').length, todoTotal: todos.length,
    todoNow: (t.progress && t.progress.current) || null,
    agents: (t.agents || []).slice(0, 6).map((a: any) => ({ type: String(a.type || 'agent'), description: String(a.description || ''), modelName: a.modelName ?? null, model: a.model ?? null, status: String(a.status || '') })),
    runningTools: (t.runningTools || []).slice(-3).map((c: any) => ({ name: String(c.name), summary: String(c.summary || '') })),
    blockedOn: t.blockedOn ? `${t.blockedOn.tool} ${t.blockedOn.summary || ''}`.trim() : null,
    adviceModel: (t.advice && t.advice.model && t.advice.model.name) || null, adviceEffort: (t.advice && t.advice.effort) || null,
    adviceWhy: (t.advice && (t.advice.reasons || []).filter((r: any) => r.w > 0).slice(0, 2).map((r: any) => r.why).join(', ')) || null,
  }
}

async function refresh($: EngineInterface, p: number): Promise<PanelSnapshot> {
  const at = await $.clock.now()
  try {
    const res = await $.http.fetch(`http://127.0.0.1:${p}/api/state`)
    if (!res.ok) throw new Error(`backend answered ${res.status}`)
    const s = JSON.parse(res.text)
    const next: PanelSnapshot = {
      isOnline: true, fetchedAt: at, billingMode: String((s.billing && s.billing.mode) || 'unknown'),
      costTodayUsd: Number(s.today.costUsd || 0), tokensToday: Number(s.today.tokens || 0), requestsToday: Number(s.today.requests || 0),
      unread: Number(s.unread || 0), active: (s.active || []).slice(0, 8).map(toTask),
      recent: (s.recent || []).slice(0, 6).map((t: any) => ({ id: String(t.id), status: String(t.status), prompt: String(t.prompt || ''), elapsedMs: Number(t.elapsedMs), costUsd: Number((t.usage && t.usage.costUsd) || 0), modelName: t.modelName ?? null })),
      notices: (s.notifications || []).slice(0, 4).map((n: any) => ({ kind: String(n.kind), title: String(n.title), body: String(n.body || ''), at: Number(n.at) })),
      error: '',
    }
    await update($, snapshot, () => next)
    return next
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return update($, snapshot, prev => ({ ...prev, isOnline: false, fetchedAt: at, error: msg }))
  }
}

let lastStartAttempt = 0
async function ensureBackend($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  if (at - lastStartAttempt < 30000) return
  lastStartAttempt = at
  try { await $.process.run(['node', `${$.plugin.root}/cli/ccc.js`, 'start'], { timeoutMs: 15000 }) } catch { /* node missing: the panel says so */ }
}

function statusText(s: PanelSnapshot): string | undefined {
  if (!s.isOnline) return undefined
  const running = s.active.length
  const soonest = s.active.map(t => t.remainingMs).filter((x): x is number => x != null).sort((a, b) => a - b)[0]
  const parts = [`◆ ${running ? `${running} running` : 'idle'}`]
  if (soonest != null) parts.push(`~${dur(soonest)} left (pred.)`)
  parts.push(`${usd(s.costTodayUsd)} today`)
  if (s.unread) parts.push(`${s.unread} alert${s.unread === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------- desktop drawings (one Svg per row)
function kpiSvg(W: number, s: PanelSnapshot): string {
  const gap = 8, n = 3, w = (W - gap * (n - 1)) / n
  const label = s.billingMode === 'subscription' ? 'subscription-equiv.' : s.billingMode === 'api' ? 'API estimate' : 'estimate'
  const tiles: [string, string, string][] = [
    ['Active tasks', String(s.active.length), 'measured'],
    ['Cost today', usd(s.costTodayUsd), label],
    ['Tokens today', tok(s.tokensToday), `${s.requestsToday} requests`],
  ]
  const body = tiles.map(([k, v, hint], i) => {
    const x = i * (w + gap)
    return `<rect class="tile" x="${x}" y="0" width="${w}" height="62" rx="10"/>
<text class="m" x="${x + 12}" y="19" font-size="11">${xml(k)}</text>
<text class="t" x="${x + 12}" y="43" font-size="20" font-weight="650" font-variant-numeric="tabular-nums">${xml(v)}</text>
<text class="m" x="${x + 12}" y="56" font-size="9.5">${xml(hint)}</text>`
  }).join('')
  return svg(W, 62, body)
}

function etaSvg(W: number, t: PanelTask, elapsed: number): string {
  const H = 26
  if (t.remainingMs == null) {
    return svg(W, H, `<rect class="k" x="0" y="4" width="${W}" height="6" rx="3"/><text class="m" x="0" y="23" font-size="10.5">prediction: ${xml(clip(t.predictionNote || 'no estimate yet', 90))}</text>`)
  }
  const rem = Math.max(0, t.remainingMs), lo = Math.max(0, t.remainingLowMs ?? rem), hi = Math.max(rem, t.remainingHighMs ?? rem)
  const total = elapsed + hi || 1
  const fx = (v: number) => Math.max(0, Math.min(W, (W * v) / total))
  const basis = t.predictionBasis === 'progress' ? 'from todo progress' : t.predictionBasis === 'blend' ? `todo progress + ${t.predictionN} past tasks` : `${t.predictionN} past tasks`
  return svg(W, H, `<defs><pattern id="h" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="2" height="5" fill="${ACCENT}" opacity=".45"/></pattern><clipPath id="c"><rect x="0" y="4" width="${W}" height="6" rx="3"/></clipPath></defs>
<rect class="k" x="0" y="4" width="${W}" height="6" rx="3"/>
<g clip-path="url(#c)"><rect x="${fx(elapsed + lo)}" y="4" width="${fx(elapsed + hi) - fx(elapsed + lo)}" height="6" fill="url(#h)"/><rect x="0" y="4" width="${fx(elapsed)}" height="6" fill="${ACCENT}"/></g>
<text class="t" x="0" y="23" font-size="11"><tspan font-weight="600">~${dur(rem)} left</tspan><tspan class="m"> (${dur(lo)}–${dur(hi)}) · prediction, ${xml(basis)}</tspan></text>`)
}

function todoSvg(W: number, t: PanelTask): string {
  const frac = t.todoTotal ? t.todoDone / t.todoTotal : 0
  return svg(W, 24, `<rect class="k" x="0" y="3" width="${W}" height="5" rx="2.5"/><rect x="0" y="3" width="${Math.max(0, W * frac)}" height="5" rx="2.5" fill="#0ca30c"/>
<text class="t" x="0" y="21" font-size="11"><tspan font-weight="600">${t.todoDone}/${t.todoTotal}</tspan><tspan class="m"> todo list${t.todoNow ? ' · now: ' + xml(clip(t.todoNow, 60)) : ''}</tspan></text>`)
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}"><style>.t{fill:#1f1f24}.m{fill:#77767f}.k{fill:#e6e6ec}.tile{fill:#f3f3f7}@media (prefers-color-scheme: dark){.t{fill:#f0efec}.m{fill:#9a99a5}.k{fill:#2c2c36}.tile{fill:#1f1f29}}</style>${body}</svg>`

// ---------------------------------------------------------------- register
export const register: Register = (on, options) => {
  let p = 47821

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    p = await port($, options.port)
    await $.command.register({ name: 'cc-panel', description: 'Show or hide the Claude Command Center panel (live tasks, costs, predictions)' })
    let s = await refresh($, p)
    if (!s.isOnline) { await ensureBackend($); s = await refresh($, p) }
    $.ui.status(statusText(s))
    if (options.autoOpen !== false) void $.ui.open({ id: PANE, title: 'Command Center' })

    // Poll quickly while the panel is open or tasks run; slowly otherwise.
    let tick = 0
    $.clock.every(2000, () => {
      void (async () => {
        tick++
        const cur = await read($, snapshot)
        const isOpen = (await $.ui.panes()).some(x => x.id === PANE)
        if (!isOpen && !cur.active.length && tick % 5 !== 0) return
        const next2 = await refresh($, p)
        if (!next2.isOnline && isOpen) await ensureBackend($)
        $.ui.status(statusText(next2))
      })()
    })
    // Elapsed clocks tick once a second, only while something runs.
    $.clock.every(1000, () => {
      void (async () => {
        const cur = await read($, snapshot)
        if (!cur.active.length) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('command.run', { command: 'cc-panel' }, async $ => {
    const isOpen = (await $.ui.panes()).some(x => x.id === PANE)
    if (isOpen) { await $.ui.close({ id: PANE }); return { text: 'Command Center panel closed.' } }
    await refresh($, p)
    await $.ui.open({ id: PANE, title: 'Command Center' })
    return { text: 'Command Center panel opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const s = await read($, snapshot)
    const at = Math.max(await read($, now), s.fetchedAt)
    const hasSvg = e.surface !== 'terminal' && 'Svg' in ui
    const W = Math.max(220, Math.min(760, (e.props.bodyColumns || 40) * 8 - 16))
    const cols = Math.max(24, e.props.bodyColumns || 40)

    const openDashboard = (
      <Button key="open" label="Open full dashboard" onPress={async () => { await ensureBackend($); try { await $.process.run(['node', `${$.plugin.root}/cli/ccc.js`, 'open'], { timeoutMs: 20000 }) } catch { /* shown as offline */ } }} />
    )
    const refreshBtn = <Button key="refresh" label="Refresh" plain onPress={async () => { await refresh($, p) }} />

    if (!s.isOnline) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold" size="heading">Command Center</Text>
          <Text color="#fab219">⚠ Backend not reachable on 127.0.0.1:{p}</Text>
          <Text dimColor wrap="wrap">It starts by itself with your next prompt. If it doesn't, Node.js may be missing: run winget install OpenJS.NodeJS.LTS, then start a new session.</Text>
          {s.error ? <Text dimColor wrap="truncate-end">{s.error}</Text> : null}
          <Box flexDirection="row" gap={1}>
            <Button key="start" label="Start backend" onPress={async () => { lastStartAttempt = 0; await ensureBackend($); await refresh($, p) }} />
            {refreshBtn}
          </Box>
        </Box>
      )
    }

    const Svg = hasSvg ? (ui as any).Svg : null
    const card = (t: PanelTask) => {
      const [icon, word, color] = statusOf(t.status)
      const elapsed = t.status === 'running' || t.status === 'blocked' || t.status === 'waiting' || t.status === 'background' ? Math.max(t.elapsedMs, at - t.startedAt) : t.elapsedMs
      const fam = FAMILY[familyOf(t.model)]
      return (
        <Box key={t.id} flexDirection="column" gap={0} borderStyle="round" borderColor={t.status === 'blocked' || t.status === 'waiting' ? '#fab219' : '#3a3a48'} paddingX={1} paddingY={0}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text color={color} weight="semibold">{icon} {word}</Text>
            <Text weight="bold" tabular>{dur(elapsed)}</Text>
          </Box>
          <Text weight="medium" wrap="truncate-end">{clip(t.prompt, 160)}</Text>
          <Text dimColor wrap="truncate-end">
            {t.modelName ? <Text color={fam}>■ </Text> : null}{t.modelName ? `${t.modelName} · ` : ''}{t.toolCount} tools{t.toolErrors ? ` · ${t.toolErrors} errors` : ''} · {usd(t.costUsd)} so far (estimate) · {tok(t.tokens)} tok
          </Text>
          {t.blockedOn ? <Text color="#fab219" wrap="truncate-end">⏸ Waiting for your approval: {t.blockedOn}</Text> : null}
          {Svg ? <Svg source={etaSvg(W - 24, t, elapsed)} alt={t.remainingMs != null ? `about ${dur(t.remainingMs)} left (prediction)` : 'no time estimate yet'} width={W - 24} height={26} />
            : <Text dimColor wrap="truncate-end">{t.remainingMs != null ? `~${dur(t.remainingMs)} left (${dur(t.remainingLowMs)}–${dur(t.remainingHighMs)}, prediction)` : `prediction: ${t.predictionNote || 'no estimate yet'}`}</Text>}
          {t.todoTotal ? (Svg ? <Svg source={todoSvg(W - 24, t)} alt={`${t.todoDone} of ${t.todoTotal} todos done`} width={W - 24} height={24} />
            : <Text dimColor>{'█'.repeat(Math.round(12 * t.todoDone / t.todoTotal))}{'░'.repeat(12 - Math.round(12 * t.todoDone / t.todoTotal))} {t.todoDone}/{t.todoTotal} todos</Text>) : null}
          {t.agents.map((a, i) => (
            <Text key={`a${i}`} wrap="truncate-end"><Text color={FAMILY[familyOf(a.model || a.modelName)]}>■ </Text>{a.type}{a.description ? ` · ${a.description}` : ''} <Text dimColor>· {a.modelName || 'model pending'} · {a.status === 'running' ? '● running' : a.status === 'done' ? '✓ done' : a.status}</Text></Text>
          ))}
          {t.runningTools.map((c, i) => <Text key={`c${i}`} dimColor wrap="truncate-end" mono>▸ {c.name} {c.summary}</Text>)}
          {t.adviceModel ? <Text dimColor wrap="truncate-end">✦ suggested {t.adviceModel} · {t.adviceEffort}{t.adviceWhy ? ` — ${t.adviceWhy}` : ''} (heuristic)</Text> : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text weight="semibold" size="heading">◆ Command Center</Text>
          <Text dimColor>{s.billingMode === 'subscription' ? 'subscription' : s.billingMode === 'api' ? 'API billing' : ''}</Text>
        </Box>
        {Svg ? <Svg source={kpiSvg(W, s)} alt={`${s.active.length} active tasks, ${usd(s.costTodayUsd)} today, ${tok(s.tokensToday)} tokens`} width={W} height={62} />
          : <Text>{s.active.length} active · <Text weight="bold">{usd(s.costTodayUsd)}</Text> today (estimate) · {tok(s.tokensToday)} tokens</Text>}
        <Text dimColor size="caption">ACTIVE TASKS</Text>
        {s.active.length ? s.active.map(card) : <Text dimColor>Nothing running. Send a prompt and it shows up here live.</Text>}
        {s.notices.length ? <Text dimColor size="caption">ALERTS</Text> : null}
        {s.notices.slice(0, 3).map((n, i) => (
          <Text key={`n${i}`} wrap="truncate-end"><Text color={n.kind === 'finish' ? '#0ca30c' : n.kind === 'fail' || n.kind === 'errors' ? '#d03b3b' : '#fab219'}>{n.kind === 'finish' ? '✓' : n.kind === 'fail' ? '✗' : n.kind === 'errors' ? '!' : '⏸'} </Text>{n.title} <Text dimColor>· {clip(n.body, Math.max(20, cols - n.title.length - 8))}</Text></Text>
        ))}
        {s.recent.length ? <Text dimColor size="caption">RECENT</Text> : null}
        {s.recent.slice(0, 5).map(t => {
          const [icon, , color] = statusOf(t.status)
          return <Text key={`r${t.id}`} wrap="truncate-end"><Text color={color}>{icon} </Text>{clip(t.prompt, Math.max(16, cols - 26))} <Text dimColor tabular>· {dur(t.elapsedMs)} · {usd(t.costUsd)}</Text></Text>
        })}
        <Box flexDirection="row" gap={1}>{openDashboard}{refreshBtn}</Box>
        <Text dimColor size="footnote">Costs are estimates from measured tokens × list prices; time left is a prediction from your history.</Text>
      </Box>
    )
  })
}
