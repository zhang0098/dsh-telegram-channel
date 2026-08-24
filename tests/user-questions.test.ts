import assert from 'node:assert/strict'
import test from 'node:test'
import type { InlineKeyboardMarkup, TelegramClientLike } from '../src/client.ts'
import {
  TelegramUserQuestions,
  userQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
  type UserQuestionServiceLike,
} from '../src/user-questions.ts'

type SentMessage = {
  chatId: number
  text: string
  replyMarkup?: InlineKeyboardMarkup
}

function fakeClient(
  sent: SentMessage[],
  edited: { chatId: number; messageId: number }[] = [],
): TelegramClientLike & { edits: typeof edited } {
  let messageId = 0
  return {
    edits: edited,
    getMe: async () => ({ id: 1 }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text, _parseMode, replyMarkup) => {
      messageId += 1
      sent.push({ chatId, text, replyMarkup })
      return { message_id: messageId, date: 0, chat: { id: chatId, type: 'private' }, text }
    },
    sendChatAction: async () => true,
    answerCallbackQuery: async () => true,
    editMessageReplyMarkup: async (chatId, id) => {
      edited.push({ chatId, messageId: id })
      return true
    },
    setMyCommands: async () => true,
  }
}

function requestWith(questions: AskUserQuestionRequest['questions'], overrides: Partial<AskUserQuestionRequest> = {}) {
  return {
    questions,
    agent: { id: 'sess-1' },
    ...overrides,
  }
}

function optionLabelsOf(message: SentMessage | undefined): string[] {
  return (message?.replyMarkup?.inline_keyboard ?? []).map((row) => row[0]!.text)
}

function callbackDataOf(message: SentMessage | undefined, row: number): string {
  return message!.replyMarkup!.inline_keyboard[row]![0]!.callback_data
}

/**
 * Host-UI (original provider) behavior for the mirror path:
 * - default: the host dialog stays open (pending) so Telegram answers win —
 *   this mirrors a real TUI waiting for the user
 * - `'answer'`: the host UI answers immediately (TUI-first scenarios)
 * - a function: full control (e.g. throw without a code = UI unavailable)
 */
type TuiBehavior = 'pending' | AskUserQuestionAnswer | ((request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>)

function installWith(fake: TelegramClientLike, bound: string[], tui: TuiBehavior = 'pending') {
  const service: UserQuestionServiceLike = {
    ask: async () => ({ answers: [] }),
  }
  let delegated = 0
  const original = service.ask.bind(service)
  service.ask = async (request) => {
    delegated += 1
    return original(request)
  }
  const tuiAsk = (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
    if (tui === 'pending') return new Promise<AskUserQuestionAnswer>(() => {})
    if (typeof tui === 'function') return tui(request)
    return Promise.resolve(tui)
  }
  service.ask = async (request) => {
    delegated += 1
    return tuiAsk(request)
  }
  const bridge = new TelegramUserQuestions({
    client: fake,
    boundChatsFor: (sessionId) => (bound.includes(sessionId) ? [10] : []),
  })
  bridge.install({ userQuestions: service } as any)
  return { bridge, service, delegated: () => delegated }
}

test('no bound chat delegates to the original provider', async () => {
  const sent: SentMessage[] = []
  const { bridge, service, delegated } = installWith(fakeClient(sent), [], { answers: [] })
  const answer = await service.ask(requestWith([
    { id: 'q1', question: '继续？', options: [{ label: '是' }, { label: '否' }] },
  ]))
  assert.deepEqual(answer, { answers: [] })
  assert.equal(delegated(), 1)
  assert.equal(sent.length, 0)
  bridge.dispose()
})

/** Cordis-like ctx: direct service access throws until the service is provided. */
function cordisLikeCtx() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  let service: UserQuestionServiceLike | undefined
  const base = {
    listeners,
    get(name: string) {
      return name === 'userQuestions' ? service : undefined
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? []
      listeners.set(event, [...list, listener])
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener))
      }
    },
    provideUserQuestions(next: UserQuestionServiceLike) {
      service = next
      for (const listener of listeners.get('internal/service') ?? []) {
        listener('userQuestions', next)
      }
    },
  }
  // Direct access throws like the Cordis proxy when the service is absent,
  // and ANY undeclared property read throws (e.g. there is no ctx.off).
  Object.defineProperty(base, 'userQuestions', {
    get() {
      if (service === undefined) throw new Error('cannot get property "userQuestions" without inject')
      return service
    },
    configurable: true,
  })
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  }) as any
}

test('install never throws and adopts the service when it appears later', async () => {
  const sent: SentMessage[] = []
  const fake = fakeClient(sent)
  const ctx = cordisLikeCtx()
  const service: UserQuestionServiceLike = { ask: async () => ({ answers: [] }) }
  const bridge = new TelegramUserQuestions({
    client: fake,
    boundChatsFor: () => [10],
  })
  // Service not provided yet: must not throw and must not delegate yet.
  bridge.install(ctx)
  assert.equal(sent.length, 0)

  // The seam activates later → the internal/service event adopts it.
  ctx.provideUserQuestions(service)
  const promise = service.ask(requestWith([
    { id: 'q1', question: '稍后出现的服务', options: [{ label: '是' }] },
  ]))
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(sent.length, 1, 'ask must be mirrored after late adoption')
  assert.match(sent[0]!.text, /稍后出现的服务/)
  bridge.dispose()
  await promise.catch(() => {})
  assert.equal(ctx.listeners.get('internal/service')?.length ?? 0, 0, 'listener removed on dispose')
})

test('a replacement service instance is re-adopted (HMR)', async () => {
  const sent: SentMessage[] = []
  const fake = fakeClient(sent)
  const ctx = cordisLikeCtx()
  const first: UserQuestionServiceLike = { ask: async () => ({ answers: [] }) }
  const bridge = new TelegramUserQuestions({ client: fake, boundChatsFor: () => [10] })
  bridge.install(ctx)
  ctx.provideUserQuestions(first)
  assert.equal(sent.length, 0)

  const second: UserQuestionServiceLike = { ask: async () => ({ answers: [] }) }
  ctx.provideUserQuestions(second)
  const promise = second.ask(requestWith([
    { id: 'q1', question: '热更新后的服务', options: [{ label: '是' }] },
  ]))
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(sent.length, 1, 'new instance must be mirrored too')
  bridge.dispose()
  await promise.catch(() => {})
})

test('dispose during teardown never touches the ctx proxy (no ctx.off crash)', () => {
  const sent: SentMessage[] = []
  const ctx = cordisLikeCtx()
  const bridge = new TelegramUserQuestions({ client: fakeClient(sent), boundChatsFor: () => [10] })
  bridge.install(ctx)
  // Cordis has no ctx.off: the proxy throws on any undeclared property read.
  // dispose must only use the captured on() disposer.
  bridge.dispose()
  bridge.dispose() // idempotent
})

test('dispose restores the original ask on every interposed service', async () => {
  const sent: SentMessage[] = []
  const { bridge, service, delegated } = installWith(fakeClient(sent), ['sess-1'], { answers: [] })
  bridge.dispose()
  const answer = await service.ask(requestWith([
    { id: 'q1', question: '恢复后', options: [{ label: '是' }] },
  ]))
  assert.equal(delegated(), 1)
  assert.deepEqual(answer, { answers: [] })
  assert.equal(sent.length, 0, 'no Telegram delivery after restore')
  bridge.dispose()
})

test('send failure with nothing delivered falls back to the original provider', async () => {
  const sent: SentMessage[] = []
  const failing = fakeClient(sent)
  failing.sendMessage = async () => {
    throw new Error('Telegram API unavailable')
  }
  const { bridge, service, delegated } = installWith(failing, ['sess-1'], { answers: [] })
  const answer = await service.ask(requestWith([
    { id: 'q1', question: '继续？', options: [{ label: '是' }] },
  ]))
  assert.deepEqual(answer, { answers: [] }, 'host UI answers instead')
  assert.equal(delegated(), 1)
  assert.equal(sent.length, 0)
  bridge.dispose()
})

test('host UI answers first wins and clears the Telegram keyboards', async () => {
  const sent: SentMessage[] = []
  const edited: { chatId: number; messageId: number }[] = []
  const fake = fakeClient(sent, edited)
  // Telegram renders, but the host UI answers immediately → the Telegram
  // keyboards must be cleared via the abort path.
  const { bridge, service, delegated } = installWith(fake, ['sess-1'], { answers: [{ id: 'q1', selected: ['TUI'] }] })
  const answer = await service.ask(requestWith([
    { id: 'q1', question: '继续？', options: [{ label: '是' }, { label: '否' }] },
  ]))
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['TUI'] }] })
  assert.equal(delegated(), 1, 'host UI was asked in parallel')
  assert.equal(sent.length, 1, 'Telegram mirror still rendered')
  assert.ok(edited.length >= 1, 'Telegram keyboards cleared after the TUI answer')
  bridge.dispose()
})

test('host UI unavailable falls back to the Telegram answer', async () => {
  const sent: SentMessage[] = []
  const { bridge, service, delegated } = installWith(
    fakeClient(sent),
    ['sess-1'],
    async () => { throw new Error('no UI provider on this host') },
  )
  const promise = service.ask(requestWith([
    { id: 'q1', question: '继续？', options: [{ label: '是' }, { label: '否' }] },
  ]))
  assert.equal(sent.length, 1, 'Telegram rendered even though the host UI failed')
  const tap = callbackDataOf(sent[0], 0)
  assert.equal(await bridge.handleCallback(tap, 10, 'cb-1'), true)
  const answer = await promise
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['是'] }] })
  assert.equal(delegated(), 1)
  bridge.dispose()
})

test('host UI cancellation propagates without waiting for Telegram', async () => {
  const sent: SentMessage[] = []
  const { bridge, service, delegated } = installWith(
    fakeClient(sent),
    ['sess-1'],
    async () => { throw userQuestionError('cancelled on the host', 'ASK_CANCELLED') },
  )
  await assert.rejects(
    service.ask(requestWith([{ id: 'q1', question: '继续？', options: [{ label: '是' }] }])),
    (err: Error & { code?: string }) => err.code === 'ASK_CANCELLED',
  )
  assert.equal(delegated(), 1)
  bridge.dispose()
})

test('ask with a pre-aborted signal rejects with ASK_ABORTED without sending', async () => {
  const sent: SentMessage[] = []
  const { bridge, service } = installWith(fakeClient(sent), ['sess-1'])
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    service.ask(requestWith([{ id: 'q1', question: '继续？', options: [{ label: '是' }] }], { signal: controller.signal })),
    (err: Error & { code?: string }) => err.code === 'ASK_ABORTED',
  )
  assert.equal(sent.length, 0)
  bridge.dispose()
})

test('question is delivered to every bound chat and answerable from any of them', async () => {
  const sent: SentMessage[] = []
  const bridge = new TelegramUserQuestions({
    client: fakeClient(sent),
    boundChatsFor: () => [10, 20],
  })
  // The host UI (original provider) stays open; Telegram answers win.
  const service: UserQuestionServiceLike = {
    ask: () => new Promise<AskUserQuestionAnswer>(() => {}),
  }
  bridge.install({ userQuestions: service } as any)

  const promise = service.ask(requestWith([
    { id: 'q1', question: '多端同步', options: [{ label: 'A' }, { label: 'B' }] },
  ]))
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(sent.length, 2)
  assert.equal(sent[0]!.chatId, 10)
  assert.equal(sent[1]!.chatId, 20)

  // Answer from the second chat.
  const tap = callbackDataOf(sent[1], 0)
  assert.equal(await bridge.handleCallback(tap, 20, 'cb-1'), true)
  const answer = await promise
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['A'] }] })
  bridge.dispose()
})

test('bound chat renders the question and resolves via option tap', async () => {
  const sent: SentMessage[] = []
  const edited: { chatId: number; messageId: number }[] = []
  const fake = fakeClient(sent, edited)
  const { bridge, service } = installWith(fake, ['sess-1'])

  const promise = service.ask(requestWith([
    { id: 'q1', question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] },
  ]))

  assert.equal(sent.length, 1)
  assert.match(sent[0]!.text, /选哪个？/)
  assert.match(sent[0]!.text, /1\. A/)
  assert.deepEqual(optionLabelsOf(sent[0]), ['A', 'B', '✖ 取消'])

  const tap = callbackDataOf(sent[0], 0)
  assert.equal(await bridge.handleCallback(tap, 10, 'cb-1'), true)

  const answer = await promise
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['A'] }] })
  assert.equal(edited.length, 1, 'keyboard cleared after answer')
  bridge.dispose()
})

test('multiple questions resolve only after every question is answered', async () => {
  const sent: SentMessage[] = []
  const { bridge, service } = installWith(fakeClient(sent), ['sess-1'])

  const promise = service.ask(requestWith([
    { id: 'q1', question: '第一问', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: '第二问', options: [{ label: 'C' }] },
  ]))

  // Both question messages are sent before any answer can arrive.
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(sent.length, 2)
  assert.match(sent[0]!.text, /问题 1\/2/)
  assert.match(sent[1]!.text, /问题 2\/2/)

  await bridge.handleCallback(callbackDataOf(sent[0], 0), 10, 'cb-1')
  let settled = false
  void promise.then(() => { settled = true })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(settled, false, 'must wait for the second question')

  await bridge.handleCallback(callbackDataOf(sent[1], 0), 10, 'cb-2')
  const answer = await promise
  assert.deepEqual(answer, {
    answers: [
      { id: 'q1', selected: ['A'] },
      { id: 'q2', selected: ['C'] },
    ],
  })
  bridge.dispose()
})

test('multiSelect toggles and confirms', async () => {
  const sent: SentMessage[] = []
  const edited: { chatId: number; messageId: number }[] = []
  const fake = fakeClient(sent, edited)
  const { bridge, service } = installWith(fake, ['sess-1'])

  const promise = service.ask(requestWith([
    { id: 'q1', question: '多选', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }] },
  ]))

  assert.deepEqual(optionLabelsOf(sent[0]), ['X', 'Y', 'Z', '✅ 完成', '✖ 取消'])

  // toggle X on, then Y on, then X off → only Y remains
  await bridge.handleCallback(callbackDataOf(sent[0], 0), 10, 'cb-1')
  await bridge.handleCallback(callbackDataOf(sent[0], 1), 10, 'cb-2')
  await bridge.handleCallback(callbackDataOf(sent[0], 0), 10, 'cb-3')
  const confirm = callbackDataOf(sent[0], 3)
  await bridge.handleCallback(confirm, 10, 'cb-4')

  const answer = await promise
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['Y'] }] })
  assert.ok(edited.length >= 3, 'toggle and confirm edits the markup')
  bridge.dispose()
})

test('multiSelect confirm with nothing selected is rejected', async () => {
  const sent: SentMessage[] = []
  const { bridge, service } = installWith(fakeClient(sent), ['sess-1'])

  const promise = service.ask(requestWith([
    { id: 'q1', question: '多选', multiSelect: true, options: [{ label: 'X' }] },
  ]))

  let settled = false
  const tracked = promise.then(
    () => { settled = true },
    () => { settled = true },
  )
  await bridge.handleCallback(callbackDataOf(sent[0], 1), 10, 'cb-1') // ✅ 完成 row
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(settled, false, 'confirm with zero selections must not resolve')
  bridge.dispose()
  await tracked
})

test('cancel rejects with ASK_CANCELLED and clears keyboards', async () => {
  const sent: SentMessage[] = []
  const edited: { chatId: number; messageId: number }[] = []
  const fake = fakeClient(sent, edited)
  const { bridge, service } = installWith(fake, ['sess-1'])

  const promise = service.ask(requestWith([
    { id: 'q1', question: '继续？', options: [{ label: '是' }, { label: '否' }] },
  ]))

  const cancel = callbackDataOf(sent[0], 2)
  await bridge.handleCallback(cancel, 10, 'cb-1')
  await assert.rejects(promise, (err: Error & { code?: string }) => {
    assert.equal(err.code, 'ASK_CANCELLED')
    return true
  })
  assert.ok(edited.length >= 1, 'keyboards cleared after cancel')
  bridge.dispose()
})

test('abort signal rejects with ASK_ABORTED', async () => {
  const sent: SentMessage[] = []
  const controller = new AbortController()
  const { bridge, service } = installWith(fakeClient(sent), ['sess-1'])

  const promise = service.ask(requestWith(
    [{ id: 'q1', question: '继续？', options: [{ label: '是' }] }],
    { signal: controller.signal },
  ))

  controller.abort()
  await assert.rejects(promise, (err: Error & { code?: string }) => {
    assert.equal(err.code, 'ASK_ABORTED')
    return true
  })
  bridge.dispose()
})

test('stale nonce answers are consumed without resolving anything', async () => {
  const sent: SentMessage[] = []
  const { bridge, service } = installWith(fakeClient(sent), ['sess-1'])

  const promise = service.ask(requestWith([
    { id: 'q1', question: '继续？', options: [{ label: '是' }] },
  ]))

  assert.equal(await bridge.handleCallback('uq:no-such-nonce:0:0', 10, 'cb-1'), true)
  let settled = false
  void promise.finally(() => { settled = true })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(settled, false)

  await bridge.handleCallback(callbackDataOf(sent[0], 0), 10, 'cb-2')
  await promise
  bridge.dispose()
})

test('dispose rejects every pending question', async () => {
  const sent: SentMessage[] = []
  const { bridge, service } = installWith(fakeClient(sent), ['sess-1'])

  const promise = service.ask(requestWith([
    { id: 'q1', question: '继续？', options: [{ label: '是' }] },
  ]))

  bridge.dispose()
  await assert.rejects(promise, (err: Error & { code?: string }) => {
    assert.equal(err.code, 'ASK_ABORTED')
    return true
  })
})

test('unknown chat id on a valid nonce is treated as stale', async () => {
  const sent: SentMessage[] = []
  const { bridge, service } = installWith(fakeClient(sent), ['sess-1'])

  const promise = service.ask(requestWith([
    { id: 'q1', question: '继续？', options: [{ label: '是' }] },
  ]))

  assert.equal(await bridge.handleCallback(callbackDataOf(sent[0], 0), 99, 'cb-1'), true)
  let settled = false
  const tracked = promise.then(
    () => { settled = true },
    () => { settled = true },
  )
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(settled, false)
  bridge.dispose()
  await tracked
})
