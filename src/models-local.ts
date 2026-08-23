import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelOption, ModelSnapshot } from './models.js'

/**
 * Local fallback for /model on hosts without apiProxy (dsh web host).
 *
 * The martty / ACP host tree (Base + ACP bridge) never provides `apiProxy`
 * — that service is mounted only by the web profile (`dsh-web-app` mounts
 * `@deepseek-ai/dsh-host-apiproxy`). The Telegram plugin must therefore not
 * list it in `inject` (Cordis inject is all-required; a missing service parks
 * the fiber forever). Instead we probe `ctx.get('apiProxy')` at runtime and,
 * when absent, drive the same harness services the web api-proxy wraps:
 * `ctx.llm` for the provider/model catalog and request-config resolution, and
 * `installModelSelection` (exported by `@deepseek-ai/dsh-agent`, the same
 * helper the web api-proxy uses) to couple the picked selection to the
 * agent's prompt assembly and request routing.
 */

export interface SelectedModel {
  provider: string
  model: string
  reasoningEffort?: string
}

interface LlmLike {
  listProviders?: () => Array<{ id: string; name?: string }>
  listModels?: (provider: string) => Promise<Array<{ id: string; name?: string; description?: string }>>
  resolveModelInfo?: (
    provider: string,
    model: string,
  ) => Promise<{
    reasoning?: {
      efforts?: Array<{ id: string; name?: string; description?: string }>
      defaultEffort?: string
    }
  }>
  resolveCallConfig?: (config: {
    provider: string
    model: string
    reasoningEffort?: string
  }) => Promise<SelectedModel>
}

interface AgentDefaultModelLike {
  currentSelection?: () => SelectedModel | undefined
  saveSelection?: (next: SelectedModel) => unknown
}

function llmOf(ctx: Context): LlmLike | undefined {
  const c = ctx as Context & { llm?: LlmLike }
  try {
    if (c.llm && typeof c.llm.listProviders === 'function') return c.llm
  } catch {
    // llm not injected — local /model unsupported on this host
  }
  return undefined
}

function agentDefaultModelOf(ctx: Context): AgentDefaultModelLike | undefined {
  const c = ctx as Context & { agentDefaultModel?: AgentDefaultModelLike }
  try {
    if (c.agentDefaultModel) return c.agentDefaultModel
  } catch {
    return undefined
  }
  return undefined
}

interface SelectionLike {
  current: ModelSelection | undefined
  assembled: ModelSelection | undefined
}

/** One selection owner per live agent, mirroring the web api-proxy's selectionFor. */
const selections = new WeakMap<object, SelectionLike>()

function toSelection(sel: SelectedModel | undefined): ModelSelection | undefined {
  if (!sel) return undefined
  return {
    provider: sel.provider,
    model: sel.model,
    ...sel.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(sel.reasoningEffort) },
  }
}

function toPlain(sel: ModelSelection | undefined): SelectedModel | undefined {
  if (!sel) return undefined
  return {
    provider: sel.provider,
    model: sel.model,
    ...sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort },
  }
}

function loggedConfig(agent: Agent): SelectedModel | undefined {
  try {
    const session = agent.session as {
      requestHeader?: () => { config?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined
    }
    const logged = session.requestHeader?.()?.config
    if (!logged || typeof logged.provider !== 'string' || typeof logged.model !== 'string') return undefined
    return {
      provider: logged.provider,
      model: logged.model,
      ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
    }
  } catch {
    return undefined
  }
}

function defaultSelection(ctx: Context): SelectedModel | undefined {
  try {
    return agentDefaultModelOf(ctx)?.currentSelection?.()
  } catch {
    return undefined
  }
}

export function selectionFor(ctx: Context, agent: Agent): SelectionLike {
  const existing = selections.get(agent)
  if (existing) return existing
  let picked: SelectedModel | undefined
  const selection: SelectionLike = {
    get current() {
      if (picked !== undefined) return toSelection(picked)
      return toSelection(loggedConfig(agent) ?? defaultSelection(ctx))
    },
    set current(next) {
      picked = toPlain(next)
    },
    assembled: undefined,
  }
  installModelSelection(agent.ctx, selection)
  selections.set(agent, selection)
  return selection
}

interface ModelGroup {
  id: string
  name: string
  models: Array<{
    id: string
    name: string
    description?: string
    reasoning?: {
      efforts?: Array<{ id: string; name: string; description?: string }>
      defaultEffort?: string
    }
  }>
}

/** Mirror of the web api-proxy's buildModelCatalog over ctx.llm. */
async function buildModelCatalog(ctx: Context): Promise<{ groups: ModelGroup[]; failures: unknown[] }> {
  const llm = llmOf(ctx)
  if (!llm || typeof llm.listModels !== 'function' || typeof llm.resolveModelInfo !== 'function') {
    return { groups: [], failures: [] }
  }
  const catalog = await Promise.all((llm.listProviders?.() ?? []).map(async (provider) => {
    try {
      const models = await llm.listModels!(provider.id)
      const entries = await Promise.all(models.map(async (model) => {
        const resolved = await llm.resolveModelInfo!(provider.id, model.id)
        const reasoning = resolved.reasoning === undefined ? undefined : {
          efforts: (resolved.reasoning.efforts ?? []).map((effort) => ({
            id: effort.id,
            name: effort.name ?? effort.id,
            ...effort.description === undefined ? {} : { description: effort.description },
          })),
          ...resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: resolved.reasoning.defaultEffort },
        }
        return {
          id: model.id,
          name: model.name ?? model.id,
          ...model.description === undefined ? {} : { description: model.description },
          ...reasoning === undefined ? {} : { reasoning },
        }
      }))
      return { kind: 'group' as const, group: { id: provider.id, name: provider.name ?? provider.id, models: entries } }
    } catch (error) {
      return { kind: 'failure' as const, failure: { id: provider.id, name: provider.name ?? provider.id, message: error instanceof Error ? error.message : String(error) } }
    }
  }))
  return {
    groups: catalog.flatMap((item) => item.kind === 'group' ? [item.group] : []).filter((group) => group.models.length > 0),
    failures: catalog.flatMap((item) => item.kind === 'failure' ? [item.failure] : []),
  }
}

function servedProviders(ctx: Context): string[] {
  try {
    return llmOf(ctx)?.listProviders?.().map((p) => p.id) ?? []
  } catch {
    return []
  }
}

/** Local catalog + current selection for one live agent. */
export async function loadSessionModelsLocal(ctx: Context, agent: Agent): Promise<ModelSnapshot> {
  const selection = selectionFor(ctx, agent)
  const current = selection.current ?? { provider: '', model: '' }
  const { groups, failures } = await buildModelCatalog(ctx)
  const served = servedProviders(ctx)
  const options: ModelOption[] = []
  for (const group of groups) {
    for (const m of group.models) {
      options.push({
        provider: group.id,
        model: m.id,
        label: `${group.name}/${m.name}`,
        efforts: m.reasoning?.efforts?.map((e) => ({ id: e.id, name: e.name })),
      })
    }
  }
  if (failures.length > 0) {
    const detail = failures.map((f) => {
      const f2 = f as { id?: string; message?: string }
      return f2.id ? `${f2.id}: ${f2.message ?? ''}` : String(f)
    }).join('; ')
    ctx.logger.warn(`dsh-telegram-channel: some model providers failed (local catalog): ${detail}`)
  }
  return {
    current,
    routable: served.length === 0 || served.includes(current.provider),
    options,
  }
}

/** Apply a picked model to one live agent (local path). */
export async function selectSessionModelLocal(
  ctx: Context,
  agent: Agent,
  selection: { provider: string; model: string; reasoningEffort?: string },
): Promise<SelectedModel> {
  const llm = llmOf(ctx)
  if (!llm || typeof llm.resolveCallConfig !== 'function') {
    throw new Error('local model service unavailable (ctx.llm missing on this host)')
  }
  const resolved = await llm.resolveCallConfig({
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
  })
  const selected: SelectedModel = {
    provider: resolved.provider,
    model: resolved.model,
    ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
  }
  const holder = selectionFor(ctx, agent)
  holder.current = toSelection(selected)
  try {
    await agentDefaultModelOf(ctx)?.saveSelection?.(selected)
  } catch (error) {
    ctx.logger.warn(`dsh-telegram-channel: model switch applied to this session but was not saved as default: ${String(error)}`)
  }
  return selected
}
