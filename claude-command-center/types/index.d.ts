// State contract of the Command Center panel mod (hooks/panel.tsx).

export type PanelTask = {
  id: string
  status: string
  prompt: string
  project: string
  startedAt: number
  elapsedMs: number
  modelName: string | null
  model: string | null
  toolCount: number
  toolErrors: number
  costUsd: number
  tokens: number
  /** Predicted remaining time; null when the backend has no honest estimate. */
  remainingMs: number | null
  remainingLowMs: number | null
  remainingHighMs: number | null
  predictionBasis: string
  predictionN: number
  predictionNote: string
  todoDone: number
  todoTotal: number
  todoNow: string | null
  agents: { type: string; description: string; modelName: string | null; model: string | null; status: string }[]
  runningTools: { name: string; summary: string }[]
  blockedOn: string | null
  adviceModel: string | null
  adviceEffort: string | null
  adviceWhy: string | null
}

export type PanelNotice = { kind: string; title: string; body: string; at: number }

export type PanelSnapshot = {
  isOnline: boolean
  fetchedAt: number
  billingMode: string
  costTodayUsd: number
  tokensToday: number
  requestsToday: number
  unread: number
  active: PanelTask[]
  recent: { id: string; status: string; prompt: string; elapsedMs: number; costUsd: number; modelName: string | null }[]
  notices: PanelNotice[]
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'command-center': {
      snapshot: Shaped<PanelSnapshot>
      now: number
    }
  }
}
