import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { STATE } from './panel.fixture'

const PANE = {
  plugin: 'command-center',
  component: 'Pane',
  requestId: 'command-center',
  props: { title: 'Command Center', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

async function boot($: Engine, on: On, backend: 'up' | 'down') {
  const fetched: string[] = []
  const started: string[][] = []
  const closed: string[] = []
  const status: (string | undefined)[] = []
  mock.clock(on, { now: STATE.now })
  mock.env(on, {})
  on('command.register', () => ({ value: { command: 'cc-panel' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'command-center' }] }) as never)
  on('http.fetch', (_$, e: any) => {
    fetched.push(e.url)
    if (backend === 'down') throw new Error('connect ECONNREFUSED 127.0.0.1:47821')
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(STATE) } } as never
  })
  on('process.run', (_$, e: any) => { started.push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '' } } as never })
  on('ui.close', (_$, e: any) => { closed.push(e.id); return { value: undefined } as never })
  on('ui.status', (_$, e: any) => { status.push(e.text ?? e); return { value: undefined } as never })
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  return { fetched, started, closed, status }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: the panel shows live tasks, prediction, cost and alerts from the backend`, async ($, on) => {
    const { fetched } = await boot($, on, 'up')
    expect(fetched[0]).toBe('http://127.0.0.1:47821/api/state')
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Refactor the payment module/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Needs approval|Running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Explore · explore payments/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /suggested Sonnet 5\.5/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Task finished/ })).toBeDefined()
    expect(await ui.find({ key: 'open' })).toBeDefined()
    if (surface === 'desktop') {
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.length).toBeGreaterThan(1)
    } else {
      expect((await ui.findAll({ type: 'Svg' })).length).toBe(0)
      expect(await ui.find({ type: 'Text', text: /active · / })).toBeDefined()
    }
    await ui.unmount()
  })

  test(`${surface}: with the backend down it says so and starts it`, async ($, on) => {
    const { started } = await boot($, on, 'down')
    expect(started.some(a => a[0] === 'node' && String(a[1]).endsWith('/cli/ccc.js') && a[2] === 'start')).toBe(true)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Backend not reachable/ })).toBeDefined()
    expect(await ui.find({ key: 'start' })).toBeDefined()
    await ui.unmount()
  })
}

test('/cc-panel toggles the panel', async ($, on) => {
  const { closed, status } = await boot($, on, 'up')
  expect(String(status[status.length - 1])).toMatch(/1 running · .* today · 3 alerts/)
  const r = await $.command.run({ command: 'cc-panel', args: '' } as never)
  expect((r as any).text).toBe('Command Center panel closed.')
  expect(closed).toEqual(['command-center'])
})
