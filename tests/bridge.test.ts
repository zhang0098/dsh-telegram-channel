import assert from 'node:assert/strict'
import test from 'node:test'
import type { UserMessage } from '@deepseek-ai/dsh-llm/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { TelegramBridge } from '../src/bridge.ts'
import type { InlineKeyboardMarkup, TelegramClientLike, TelegramUpdate } from '../src/client.ts'
import { BIND_CB_PREFIX, LAST_CB, MSG } from '../src/commands.ts'

type SentMessage = {
  chatId: number
  text: string
  parseMode?: string
  replyMarkup?: InlineKeyboardMarkup
}

function fakeClient(
  sent: SentMessage[],
  overrides: Partial<TelegramClientLike> = {},
): TelegramClientLike {
  return {
    getMe: async () => ({ id: 1 }),
    getUpdates: async () => [],
    sendMessage: async (chatId, text, parseMode, replyMarkup) => {
      sent.push({ chatId, text, parseMode, replyMarkup })
      return { message_id: 1, date: 0, chat: { id: chatId, type: 'private' }, text }
    },
    sendChatAction: async () => true,
    answerCallbackQuery: async () => true,
    editMessageReplyMarkup: async () => true,
    sendRichMessage: async (chatId, markdown) => {
      sent.push({ chatId, text: markdown, parseMode: 'rich' })
      return { message_id: 1, date: 0, chat: { id: chatId, type: 'private' }, text: markdown }
    },
    setMyCommands: async () => true,
    ...overrides,
  }
}

function messageUpdate(chatId: number, userId: number, text: string, updateId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 0,
      chat: { id: chatId, type: 'private' },
      from: { id: userId },
      text,
    },
  }
}

function makeAgent(id: string, followups: UserMessage[], opts?: {
  cwd?: string
  title?: string
}) {
  const cwd = opts?.cwd ?? `/proj/${id}`
  const events = opts?.title
    ? [{ type: 'session/title', data: { title: opts.title } }]
    : []
  return {
    id: SessionId(id),
    session: {
      header: { cwd },
      meta: { cwd },
      events,
    },
    followup(message: UserMessage) {
      followups.push(message)
    },
  }
}

function rpcOk<T>(value: T) {
  return { rpcId: 'x', result: { ok: true as const, value } }
}

test('unauthorized user gets denied', async () => {
  const sent: SentMessage[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(99, 99, 'hi'))
  assert.equal(sent[0]?.text, MSG.DENIED)
})

test('plain text without bind prompts NEED_BIND and does not create', async () => {
  const sent: SentMessage[] = []
  let createCalled = false
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [],
      roots: () => [],
      get: () => undefined,
      create: async () => { createCalled = true },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, 'do something'))
  assert.equal(createCalled, false)
  assert.equal(sent[0]?.text, MSG.NEED_BIND)
})

test('/sessions with no sessions shows NO_SESSIONS', async () => {
  const sent: SentMessage[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/sessions'))
  assert.equal(sent[0]?.text, MSG.NO_SESSIONS)
})

test('/sessions lists workspaces then sessions via callbacks', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-aaa', followups, {
    cwd: 'D:/gitData/demo-app',
    title: '演示会话',
  })
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (id: ReturnType<typeof SessionId>) => (String(id) === 'live-aaa' ? agent : undefined),
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/sessions'))
  assert.match(sent[0]!.text, /选择工作区/)
  assert.match(sent[0]!.text, /demo-app/)
  assert.equal(sent[0]!.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data, 'ws:0')

  await bridge.processUpdate({
    update_id: 2,
    callback_query: {
      id: 'cq-ws',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: 'ws:0',
    },
  })
  const sessionMsg = sent.at(-1)!
  assert.match(sessionMsg.text, /选择会话/)
  assert.match(sessionMsg.text, /演示会话/)
  assert.equal(sessionMsg.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data, 'sid:0')
})

test('/sessions via apiProxy shows all workspaces excluding archived', async () => {
  const sent: SentMessage[] = []
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: { list: () => [], roots: () => [], get: () => undefined },
    apiProxy: {
      workspace: {
        list: async () => rpcOk({
          items: [
            {
              workspaceId: 'w1',
              path: 'D:/a',
              title: 'Alpha',
              sessionIds: ['s1', 's-archived'],
            },
            {
              workspaceId: 'w2',
              path: 'D:/b',
              title: 'Beta',
              sessionIds: ['s2'],
            },
          ],
          archivedSessionIds: ['s-archived'],
        }),
      },
      sessions: {
        list: async () => rpcOk({
          items: [
            {
              sessionId: 's1',
              updatedAt: 2,
              running: true,
              blank: false,
              cwd: 'D:/a',
              projections: { values: { title: '会话一' } },
            },
            {
              sessionId: 's-archived',
              updatedAt: 1,
              running: false,
              blank: false,
              cwd: 'D:/a',
              projections: { values: { title: '已归档' } },
            },
            {
              sessionId: 's2',
              updatedAt: 3,
              running: false,
              blank: false,
              cwd: 'D:/b',
              projections: { values: { title: '会话二' } },
            },
          ],
        }),
      },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/sessions'))
  assert.match(sent[0]!.text, /Alpha/)
  assert.match(sent[0]!.text, /Beta/)
  assert.equal(sent[0]!.replyMarkup?.inline_keyboard?.length, 2)
})

test('callback bind then plain text followups live agent; mirror assistant to chat', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-bbb', followups)
  let sessionListener: ((session: { id: ReturnType<typeof SessionId> }, event: unknown) => void) | undefined
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: (id: ReturnType<typeof SessionId>) => (String(id) === 'live-bbb' ? agent : undefined),
    },
    on(event: string, listener: (session: { id: ReturnType<typeof SessionId> }, event: unknown) => void) {
      if (event === 'session/event') sessionListener = listener
      return () => {}
    },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  bridge.start()

  await bridge.processUpdate({
    update_id: 2,
    callback_query: {
      id: 'cq1',
      from: { id: 1 },
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 10, type: 'private' },
        text: 'picker',
      },
      data: `${BIND_CB_PREFIX}live-bbb`,
    },
  })
  assert.match(sent.at(-1)!.text, /已附着/)
  assert.equal(sent.at(-1)!.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data, LAST_CB)

  await bridge.processUpdate(messageUpdate(10, 1, 'hello from phone', 3))
  assert.equal(followups.length, 1)
  assert.equal(followups[0]!.content[0]!.type, 'text')

  await sessionListener?.(
    { id: SessionId('live-bbb') },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'reply from agent' }] } },
    },
  )
  assert.ok(sent.some((m) => m.text.includes('reply from agent') || m.text.includes('reply')))

  await bridge.stop()
})

test('cold session bind resumes then followups', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('cold-1', followups, { cwd: 'D:/proj', title: '冷会话' })
  let resumed = false
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [],
      roots: () => [],
      get: () => (resumed ? agent : undefined),
      resume: async () => {
        resumed = true
        return { agent, dispose: async () => {} }
      },
    },
    apiProxy: {
      workspace: {
        list: async () => rpcOk({
          items: [{ workspaceId: 'w', path: 'D:/proj', title: 'proj', sessionIds: ['cold-1'] }],
          archivedSessionIds: [],
        }),
      },
      sessions: {
        list: async () => rpcOk({
          items: [{
            sessionId: 'cold-1',
            updatedAt: 1,
            running: false,
            blank: false,
            cwd: 'D:/proj',
            projections: { values: { title: '冷会话' } },
          }],
        }),
      },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/sessions'))
  await bridge.processUpdate({
    update_id: 2,
    callback_query: {
      id: 'cq-ws',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: 'ws:0',
    },
  })
  await bridge.processUpdate({
    update_id: 3,
    callback_query: {
      id: 'cq-sid',
      from: { id: 1 },
      message: { message_id: 2, date: 0, chat: { id: 10, type: 'private' } },
      data: 'sid:0',
    },
  })
  assert.equal(resumed, true)
  assert.match(sent.at(-1)!.text, /已附着/)
  await bridge.processUpdate(messageUpdate(10, 1, 'hi cold', 4))
  assert.equal(followups.length, 1)
})

test('/model lists and selects via apiProxy', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-mdl', followups)
  let selected: unknown
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: () => agent,
    },
    apiProxy: {
      sessions: {
        models: async () => rpcOk({
          current: { provider: 'deepseek', model: 'chat' },
          routable: true,
          groups: [{
            id: 'deepseek',
            name: 'DeepSeek',
            models: [
              { id: 'chat', name: 'Chat' },
              { id: 'reasoner', name: 'Reasoner', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
            ],
          }],
        }),
        selectModel: async (req: { payload: unknown }) => {
          selected = req.payload
          return rpcOk({ selected: { provider: 'deepseek', model: 'chat' } })
        },
      },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'bind',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}live-mdl`,
    },
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/model', 2))
  assert.match(sent.at(-1)!.text, /当前模型/)
  assert.equal(sent.at(-1)!.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data, 'mdl:0')

  await bridge.processUpdate({
    update_id: 3,
    callback_query: {
      id: 'pick',
      from: { id: 1 },
      message: { message_id: 2, date: 0, chat: { id: 10, type: 'private' } },
      data: 'mdl:0',
    },
  })
  assert.deepEqual(selected, {
    sessionId: 'live-mdl',
    provider: 'deepseek',
    model: 'chat',
  })
  assert.match(sent.at(-1)!.text, /已切换模型/)
})

test('/model effort picker applies reasoningEffort', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-eff', followups)
  let selected: unknown
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: () => agent,
    },
    apiProxy: {
      sessions: {
        models: async () => rpcOk({
          current: { provider: 'deepseek', model: 'reasoner' },
          routable: true,
          groups: [{
            id: 'deepseek',
            name: 'DeepSeek',
            models: [{
              id: 'reasoner',
              name: 'Reasoner',
              reasoning: {
                efforts: [
                  { id: 'high', name: 'High' },
                  { id: 'max', name: 'Max' },
                ],
              },
            }],
          }],
        }),
        selectModel: async (req: { payload: unknown }) => {
          selected = req.payload
          const p = req.payload as { provider: string; model: string; reasoningEffort?: string }
          return rpcOk({
            selected: {
              provider: p.provider,
              model: p.model,
              reasoningEffort: p.reasoningEffort,
            },
          })
        },
      },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'bind',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}live-eff`,
    },
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/model', 2))
  await bridge.processUpdate({
    update_id: 3,
    callback_query: {
      id: 'pick-r',
      from: { id: 1 },
      message: { message_id: 2, date: 0, chat: { id: 10, type: 'private' } },
      data: 'mdl:0',
    },
  })
  assert.match(sent.at(-1)!.text, /reasoning effort|请选择/)
  assert.equal(sent.at(-1)!.replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data, 'eff:0')
  await bridge.processUpdate({
    update_id: 4,
    callback_query: {
      id: 'pick-eff',
      from: { id: 1 },
      message: { message_id: 3, date: 0, chat: { id: 10, type: 'private' } },
      data: 'eff:1',
    },
  })
  assert.deepEqual(selected, {
    sessionId: 'live-eff',
    provider: 'deepseek',
    model: 'reasoner',
    reasoningEffort: 'max',
  })
  assert.match(sent.at(-1)!.text, /已切换模型/)
})

test('/last returns previous Q/A via apiProxy history', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-last', followups, { title: '有历史' })
  ;(agent as any).session.events = [
    {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '手机续接前的问题' }] },
    },
    {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '电脑上的回答' }] } },
    },
  ]
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: () => agent,
    },
    apiProxy: {
      sessions: {
        history: async () => ({
          rpcId: 'h',
          result: {
            ok: true,
            value: {
              events: [
                {
                  event: {
                    type: 'user/message',
                    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '手机续接前的问题' }] },
                  },
                },
                {
                  event: {
                    type: 'assistant/message',
                    data: { message: { content: [{ type: 'text', text: '电脑上的回答' }] } },
                  },
                },
              ],
              hasMore: false,
            },
          },
        }),
      },
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'bind',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}live-last`,
    },
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/last', 2))
  const body = sent.at(-1)!.text
  assert.match(body, /上次对话|用户/)
  assert.match(body, /手机续接前的问题/)
  assert.match(body, /电脑上的回答/)
})

test('/unbind clears binding without needing create/dispose', async () => {
  const sent: SentMessage[] = []
  const followups: UserMessage[] = []
  const agent = makeAgent('live-ccc', followups)
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    agents: {
      list: () => [agent],
      roots: () => [agent],
      get: () => agent,
    },
    on() { return () => {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: fakeClient(sent),
    sleep: async () => {},
  })
  await bridge.processUpdate({
    update_id: 1,
    callback_query: {
      id: 'cq',
      from: { id: 1 },
      message: { message_id: 1, date: 0, chat: { id: 10, type: 'private' } },
      data: `${BIND_CB_PREFIX}live-ccc`,
    },
  })
  await bridge.processUpdate(messageUpdate(10, 1, '/unbind', 2))
  assert.equal(sent.at(-1)?.text, MSG.UNBOUND)
  await bridge.processUpdate(messageUpdate(10, 1, 'again', 3))
  assert.equal(sent.at(-1)?.text, MSG.NEED_BIND)
  assert.equal(followups.length, 0)
})

test('stop() aborts in-flight long polling instead of waiting for it', async () => {
  const sent: SentMessage[] = []
  let release: (() => void) | undefined
  const pending: Promise<never>[] = []
  const abortableClient: TelegramClientLike = {
    ...fakeClient(sent),
    getUpdates: () => new Promise<never>((_resolve, reject) => {
      pending.push(Promise.reject.bind(Promise))
      // Simulate a Telegram long poll: stays pending until aborted.
      void _resolve
      ;(async () => {
        await new Promise<void>((r) => { release = r })
        reject(new Error('aborted'))
      })()
    }),
    abort: () => release?.(),
  }
  const ctx = {
    on: () => () => {},
    logger: { info() {}, error() {}, warn() {} },
  }
  const bridge = new TelegramBridge(ctx as any, {
    token: 't',
    allowedUserIds: [1],
    allowAllUsers: false,
    client: abortableClient,
    sleep: async () => {},
  })
  bridge.start()
  // Let the polling loop reach the in-flight getUpdates.
  await new Promise((r) => setTimeout(r, 20))
  const t0 = Date.now()
  await bridge.stop()
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 2000, `stop() took ${elapsed}ms — long poll was not aborted`)
})
