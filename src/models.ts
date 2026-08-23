import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveApiProxy } from './apiproxy.js'
import { loadSessionModelsLocal, selectSessionModelLocal } from './models-local.js'

export interface ModelOption {
  provider: string
  model: string
  label: string
  efforts?: Array<{ id: string; name: string }>
}

export interface ModelSnapshot {
  current: { provider: string; model: string; reasoningEffort?: string }
  routable: boolean
  options: ModelOption[]
}

type ApiFn = (req: { rpcId: string; payload: unknown }) => Promise<unknown>

function unwrap<T>(res: unknown): T | undefined {
  const r = res as { result?: { ok?: boolean; value?: T; error?: { message?: string } } } | undefined
  if (r?.result?.ok === true) return r.result.value
  return undefined
}

function unwrapError(res: unknown): string | undefined {
  const r = res as { result?: { ok?: boolean; error?: { message?: string; code?: string } } } | undefined
  if (r?.result && r.result.ok === false) {
    const err = r.result.error
    if (!err) return 'rpc failed'
    return err.code ? `${err.code}: ${err.message ?? ''}`.trim() : (err.message ?? 'rpc failed')
  }
  return undefined
}

async function call(fn: ApiFn | undefined, payload: unknown): Promise<unknown> {
  if (typeof fn !== 'function') throw new Error('apiProxy sessions API unavailable')
  return fn({ rpcId: randomUUID(), payload })
}

export async function loadSessionModels(
  ctx: Context,
  sessionId: string,
  agent?: Agent,
): Promise<ModelSnapshot> {
  const api = resolveApiProxy(ctx)
  if (api?.sessions?.models) {
    return loadSessionModelsViaApi(ctx, sessionId)
  }
  // Host without apiProxy (martty / ACP host): drive ctx.llm directly.
  if (!agent) {
    throw new Error('no live agent for local model catalog (resume the session first)')
  }
  return loadSessionModelsLocal(ctx, agent)
}

async function loadSessionModelsViaApi(ctx: Context, sessionId: string): Promise<ModelSnapshot> {
  const api = resolveApiProxy(ctx)
  if (!api?.sessions?.models) {
    throw new Error('apiProxy unavailable (use ctx.get / inject apiProxy)')
  }
  const raw = await call(api.sessions.models, { sessionId })
  const value = unwrap<{
    current: { provider: string; model: string; reasoningEffort?: string }
    routable: boolean
    groups: Array<{
      id: string
      name: string
      models: Array<{
        id: string
        name: string
        reasoning?: { efforts?: Array<{ id: string; name: string }> }
      }>
    }>
  }>(raw)
  if (!value) {
    throw new Error(unwrapError(raw) ?? 'failed to load session models')
  }

  const options: ModelOption[] = []
  for (const group of value.groups ?? []) {
    for (const m of group.models ?? []) {
      options.push({
        provider: group.id,
        model: m.id,
        label: `${group.name}/${m.name}`,
        efforts: m.reasoning?.efforts?.map((e) => ({ id: e.id, name: e.name })),
      })
    }
  }

  return {
    current: value.current,
    routable: value.routable,
    options,
  }
}

export async function selectSessionModel(
  ctx: Context,
  sessionId: string,
  selection: { provider: string; model: string; reasoningEffort?: string },
  agent?: Agent,
): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
  const api = resolveApiProxy(ctx)
  if (api?.sessions?.selectModel) {
    return selectSessionModelViaApi(ctx, sessionId, selection)
  }
  // Host without apiProxy (martty / ACP host): drive ctx.llm directly.
  if (!agent) {
    throw new Error('no live agent for local model selection (resume the session first)')
  }
  return selectSessionModelLocal(ctx, agent, selection)
}

async function selectSessionModelViaApi(
  ctx: Context,
  sessionId: string,
  selection: { provider: string; model: string; reasoningEffort?: string },
): Promise<{ provider: string; model: string; reasoningEffort?: string }> {
  const api = resolveApiProxy(ctx)
  if (!api?.sessions?.selectModel) {
    throw new Error('apiProxy unavailable (use ctx.get / inject apiProxy)')
  }
  // Omit undefined reasoningEffort — some validators treat explicit undefined as invalid.
  const payload: {
    sessionId: string
    provider: string
    model: string
    reasoningEffort?: string
  } = {
    sessionId,
    provider: selection.provider,
    model: selection.model,
  }
  if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== '') {
    payload.reasoningEffort = selection.reasoningEffort
  }
  const raw = await call(api.sessions.selectModel, payload)
  const value = unwrap<{ selected: { provider: string; model: string; reasoningEffort?: string } }>(raw)
  if (!value?.selected) {
    throw new Error(unwrapError(raw) ?? 'failed to select model')
  }
  return value.selected
}

export function formatModel(sel: { provider: string; model: string; reasoningEffort?: string }): string {
  const base = `${sel.provider}/${sel.model}`
  return sel.reasoningEffort ? `${base} (${sel.reasoningEffort})` : base
}
