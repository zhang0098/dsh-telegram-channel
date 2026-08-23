import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadSessionModelsLocal,
  selectSessionModelLocal,
  selectionFor,
} from '../src/models-local.ts'

type Listener = (...args: any[]) => unknown

function makeCtx(overrides: Record<string, unknown> = {}) {
  const ctx: any = {
    llm: {
      listProviders: () => [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'broken', name: 'Broken' },
      ],
      listModels: async (provider: string) => provider === 'deepseek'
        ? [
            { id: 'deepseek-chat', name: 'DeepSeek Chat' },
            { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
          ]
        : (() => { throw new Error('provider exploded') })(),
      resolveModelInfo: async (provider: string, model: string) => provider === 'deepseek'
        ? { reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }] } }
        : (() => { throw new Error('no info') })(),
      resolveCallConfig: async (config: any) => ({
        provider: config.provider,
        model: config.model,
        ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
      }),
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      saveSelection: async () => {},
    },
    logger: { warn() {}, error() {}, info() {} },
    ...overrides,
  }
  return ctx
}

function makeAgent(id: string, config?: { provider: string; model: string; reasoningEffort?: string }) {
  const listeners = new Map<string, Listener>()
  return {
    id,
    ctx: {
      on(name: string, listener: Listener) {
        listeners.set(name, listener)
        return () => listeners.delete(name)
      },
    },
    session: {
      requestHeader: () => config === undefined ? undefined : { config },
    },
    listeners,
  } as any
}

test('loadSessionModelsLocal builds catalog from ctx.llm and current from requestHeader', async () => {
  const ctx = makeCtx()
  const agent = makeAgent('a1', { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' })
  const snap = await loadSessionModelsLocal(ctx, agent)

  assert.equal(snap.routable, true)
  assert.deepEqual(snap.current, { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' })
  assert.equal(snap.options.length, 2)
  assert.deepEqual(snap.options[0], {
    provider: 'deepseek',
    model: 'deepseek-chat',
    label: 'DeepSeek/DeepSeek Chat',
    efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }],
  })
  // Broken provider is skipped, not fatal.
  assert.equal(snap.options.some((o) => o.provider === 'broken'), false)
})

test('loadSessionModelsLocal defaults current to agentDefaultModel when no requestHeader', async () => {
  const ctx = makeCtx()
  const agent = makeAgent('a2')
  const snap = await loadSessionModelsLocal(ctx, agent)
  assert.deepEqual(snap.current, { provider: 'deepseek', model: 'deepseek-chat' })
})

test('loadSessionModelsLocal marks unserved provider as unroutable', async () => {
  const ctx = makeCtx()
  const agent = makeAgent('a3', { provider: 'ghost', model: 'nope' })
  const snap = await loadSessionModelsLocal(ctx, agent)
  assert.equal(snap.routable, false)
})

test('selectSessionModelLocal applies selection through installModelSelection waterfall', async () => {
  const ctx = makeCtx()
  const agent = makeAgent('a4', { provider: 'deepseek', model: 'deepseek-chat' })
  const saved: unknown[] = []
  ctx.agentDefaultModel.saveSelection = async (next: unknown) => { saved.push(next) }

  const selected = await selectSessionModelLocal(ctx, agent, {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  })
  assert.deepEqual(selected, { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' })
  assert.deepEqual(saved, [{ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' }])

  // The installed selection now feeds prompt assembly and request routing.
  const assemble = agent.listeners.get('system-prompt/assemble')!
  const assembled = await assemble(
    {},
    {},
    async () => ({ variables: { provider: 'old', model: 'old-model' } }),
  )
  assert.deepEqual(assembled.variables, {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
  })

  const request = agent.listeners.get('agent/request')!
  const routed = await request(
    { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'off' },
    async () => ({ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'off' }),
  )
  assert.deepEqual(routed, {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  })
})

test('selectionFor is cached per agent', () => {
  const ctx = makeCtx()
  const agent = makeAgent('a5')
  assert.equal(selectionFor(ctx, agent), selectionFor(ctx, agent))
})
