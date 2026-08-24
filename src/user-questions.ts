import { randomUUID } from 'node:crypto'
import type { Context, Logger } from '@deepseek-ai/cordis'
import type { InlineKeyboardMarkup, TelegramClientLike } from './client.js'
import { truncateButton } from './catalog.js'

/**
 * Wire types mirroring `@deepseek-ai/dsh-user-questions/types`, kept local so
 * this plugin never hard-imports the seam package (older hosts lack it). The
 * service itself is duck-typed at runtime.
 */
export interface AskUserQuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: AskUserQuestionOption[]
  multiSelect?: boolean
  intent?: { kind: string; approve?: string }
}

export interface AskUserQuestionAnswerItem {
  id: string
  selected: string[]
  custom?: string
}

export interface AskUserQuestionAnswer {
  answers: AskUserQuestionAnswerItem[]
}

export interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[]
  agent?: { id: unknown }
  signal?: AbortSignal
}

/** Duck-typed `@deepseek-ai/dsh-user-questions` service surface. */
export interface UserQuestionServiceLike {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

/** Error shaped like the seam's `UserQuestionError` (message + stable code). */
export function userQuestionError(message: string, code: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

const UQ_PREFIX = 'uq:'
const UQ_CANCEL = 'x'
const UQ_MULTI = 't'
const UQ_DONE = 'ok'
const CHECK = '✅'
const DONE = '✅ 完成'
const CANCEL = '✖ 取消'

interface DeliveredMessage {
  chatId: number
  messageId: number
}

interface PendingQuestion {
  chats: number[]
  nonce: string
  questions: AskUserQuestionItem[]
  /** question index → currently selected labels (multiSelect accumulates). */
  selected: Map<number, string[]>
  /** `${chatId}:${questionIndex}` → delivered Telegram message. */
  messages: Map<string, DeliveredMessage>
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: Error) => void
  settled: boolean
  signal?: AbortSignal
  abortListener?: () => void
}

const messageKey = (chatId: number, questionIndex: number) => `${chatId}:${questionIndex}`

export interface TelegramUserQuestionsOptions {
  client: TelegramClientLike
  /** Bound Telegram chat ids for a live session id, in binding order. */
  boundChatsFor: (sessionId: string) => number[]
  logger?: Pick<Logger, 'info' | 'warn'>
}

/**
 * Mirrors `ctx.userQuestions` asks into the bound Telegram chats with inline
 * keyboards and feeds the tapped answers back to the agent loop.
 *
 * The seam allows exactly ONE UI provider at a time — on martty the ACP
 * bridge owns it and renders the TUI dialog — so instead of fighting over
 * registration this interposes the service's `ask()` method: asks whose
 * calling agent has a bound chat are served here; everything else falls
 * through to the original provider (TUI/Web dialog).
 *
 * Activation order is service-availability driven (not row-ordered) and the
 * seam instance can be replaced by HMR, so installation adopts the service
 * lazily: it probes `ctx.get('userQuestions')` and re-adopts every instance
 * announced through the `internal/service` event. The whole install path is
 * safe even on hosts without the seam (no-op) and never throws.
 */
export class TelegramUserQuestions {
  private readonly client: TelegramClientLike
  private readonly boundChatsFor: (sessionId: string) => number[]
  private readonly logger?: Pick<Logger, 'info' | 'warn'>
  private readonly pending = new Map<string, PendingQuestion>()
  /** service → the interposing function installed as `service.ask`. */
  private readonly patches = new Map<UserQuestionServiceLike, (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>>()
  /** service → original `ask` captured before interposing. */
  private readonly originals = new Map<UserQuestionServiceLike, (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>>()
  private ctx: Context | undefined
  private serviceListener: ((name: string, value?: unknown) => void) | undefined
  private installed = false

  constructor(options: TelegramUserQuestionsOptions) {
    this.client = options.client
    this.boundChatsFor = options.boundChatsFor
    this.logger = options.logger
  }

  /** Interpose `ctx.userQuestions.ask` when the seam exists; no-op otherwise. */
  install(ctx: Context): void {
    if (this.installed) return
    this.installed = true
    this.ctx = ctx
    this.adopt(this.lookupService(ctx))
    // The seam may activate after this plugin or be replaced by HMR — adopt
    // every newly available instance.
    const listener = (name: string, value?: unknown) => {
      if (name === 'userQuestions') {
        this.adopt(value as UserQuestionServiceLike | undefined)
      }
    }
    this.serviceListener = listener
    if (typeof (ctx as { on?: unknown }).on === 'function') {
      ctx.on('internal/service', listener)
    }
  }

  /**
   * Handle a callback query that belongs to a pending question.
   * Returns true when `data` carried the `uq:` prefix (consumed, stale or not).
   */
  async handleCallback(data: string, chatId: number, callbackId: string): Promise<boolean> {
    if (!data.startsWith(UQ_PREFIX)) return false
    const parts = data.slice(UQ_PREFIX.length).split(':')
    const pending = this.pending.get(parts[0] ?? '')
    if (!pending || !pending.chats.includes(chatId)) {
      await this.client.answerCallbackQuery(callbackId, '问题已过期')
      return true
    }

    const flag = parts[1]
    if (flag === UQ_CANCEL) {
      await this.client.answerCallbackQuery(callbackId, '已取消')
      this.settle(pending, undefined, userQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED'))
      return true
    }

    const questionIndex = Number(flag)
    const question = pending.questions[questionIndex]
    if (!question) {
      await this.client.answerCallbackQuery(callbackId, '问题已过期')
      return true
    }

    const sub = parts[2]
    if (sub === UQ_DONE) {
      const selected = pending.selected.get(questionIndex) ?? []
      if (selected.length === 0) {
        await this.client.answerCallbackQuery(callbackId, '请至少选择一项')
        return true
      }
      await this.client.answerCallbackQuery(callbackId, '已确认')
      this.answerQuestion(pending, questionIndex, selected)
      return true
    }

    const optionIndex = Number(sub === UQ_MULTI ? parts[3] : sub)
    const label = question.options?.[optionIndex]?.label
    if (label === undefined) {
      await this.client.answerCallbackQuery(callbackId, '选项已过期')
      return true
    }

    if (question.multiSelect || sub === UQ_MULTI) {
      const selected = new Set(pending.selected.get(questionIndex) ?? [])
      if (selected.has(label)) {
        selected.delete(label)
      } else {
        selected.add(label)
      }
      const list = [...selected]
      pending.selected.set(questionIndex, list)
      await this.client.answerCallbackQuery(
        callbackId,
        list.length === 0 ? '已取消选择' : `已选 ${list.length} 项`,
      )
      // Refresh every bound chat's keyboard so all devices stay in sync.
      await this.refreshQuestionKeyboards(pending, questionIndex)
      return true
    }

    await this.client.answerCallbackQuery(callbackId, '已选择')
    this.answerQuestion(pending, questionIndex, [label])
    return true
  }

  /**
   * Teardown: reject every pending question, restore the seam's original
   * `ask`, and stop listening for service replacements.
   */
  dispose(): void {
    if (this.ctx !== undefined && this.serviceListener !== undefined) {
      const off = (this.ctx as unknown as { off?: (event: string, listener: (name: string, value?: unknown) => void) => void }).off
      try {
        off?.('internal/service', this.serviceListener)
      } catch {
        // context already disposing
      }
    }
    this.serviceListener = undefined
    this.installed = false
    // Restore the original ask so a reloaded host keeps working without us.
    for (const [service, original] of this.originals) {
      const patched = this.patches.get(service)
      if (patched !== undefined && service.ask === patched) {
        service.ask = original
      }
    }
    this.patches.clear()
    this.originals.clear()
    // Reject pending questions so the agent loop never blocks on the phone.
    for (const pending of [...this.pending.values()]) {
      this.settle(pending, undefined, userQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
    }
  }

  // ---- internals ----

  private lookupService(ctx: Context): UserQuestionServiceLike | undefined {
    // Direct property access works on plain ctx objects (tests) and on a
    // Cordis ctx once the service is provided; the proxy throws while the
    // service is not (yet) available, so it must be guarded.
    try {
      const direct = (ctx as unknown as { userQuestions?: UserQuestionServiceLike }).userQuestions
      if (direct !== undefined && typeof direct.ask === 'function') return direct
    } catch {
      // not provided yet — fall through to ctx.get()
    }
    const get = (ctx as unknown as { get?: (name: string) => unknown }).get
    if (typeof get === 'function') {
      const value = get.call(ctx, 'userQuestions')
      if (value !== undefined && typeof (value as UserQuestionServiceLike).ask === 'function') {
        return value as UserQuestionServiceLike
      }
    }
    return undefined
  }

  private adopt(service: UserQuestionServiceLike | undefined): void {
    if (service === undefined || typeof service.ask !== 'function') return
    if (this.interposed(service)) return
    const original = service.ask.bind(service)
    const interposedFn = async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
      if (request.signal?.aborted) {
        throw userQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
      }
      const sessionId = request.agent === undefined ? undefined : String(request.agent.id)
      const chats = sessionId === undefined ? [] : this.boundChatsFor(sessionId)
      if (chats.length === 0 || request.questions.length === 0) return original(request)
      return this.askViaTelegram(chats, request, original)
    }
    this.patches.set(service, interposedFn)
    this.originals.set(service, original)
    service.ask = interposedFn
    this.logger?.info(
      'dsh-telegram-channel: user-question dialogs for bound sessions now mirror to Telegram',
    )
  }

  private interposed(service: UserQuestionServiceLike): boolean {
    return this.patches.has(service)
  }

  private async askViaTelegram(
    chats: number[],
    request: AskUserQuestionRequest,
    fallback: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    const nonce = randomUUID()
    const pending: PendingQuestion = {
      chats,
      nonce,
      questions: request.questions,
      selected: new Map(),
      messages: new Map(),
      resolve: () => {},
      reject: () => {},
      settled: false,
      signal: request.signal,
    }
    const promise = new Promise<AskUserQuestionAnswer>((resolve, reject) => {
      pending.resolve = resolve
      pending.reject = reject
    })
    // Errors surface through the returned promise or the throw path below;
    // the internal promise must never linger as an unhandled rejection.
    void promise.catch(() => {})
    this.pending.set(nonce, pending)

    const onAbort = () => {
      this.settle(pending, undefined, userQuestionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
    }
    pending.abortListener = onAbort
    request.signal?.addEventListener('abort', onAbort, { once: true })

    try {
      for (const [index, question] of request.questions.entries()) {
        const text = formatQuestion(question, index + 1, request.questions.length)
        const keyboard = this.keyboardFor(pending, index)
        for (const chatId of chats) {
          const message = await this.client.sendMessage(chatId, text, undefined, keyboard)
          pending.messages.set(messageKey(chatId, index), { chatId, messageId: message.message_id })
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.settle(pending, undefined, error)
      // Nothing reached Telegram (bot blocked, network down): hand the ask
      // back to the host UI instead of failing the tool without a dialog.
      if (pending.messages.size === 0) return fallback(request)
      throw error
    }
    return promise
  }

  /** Record an answer for one question; resolve the whole request when all are in. */
  private answerQuestion(pending: PendingQuestion, questionIndex: number, selected: string[]): void {
    pending.selected.set(questionIndex, selected)
    const allAnswered = pending.questions.every((_, index) => pending.selected.has(index))
    if (!allAnswered) {
      // Keep the batch open: only the answered question's buttons die.
      void this.refreshQuestionKeyboards(pending, questionIndex, { inline_keyboard: [] })
    }
    if (allAnswered) {
      const answers: AskUserQuestionAnswerItem[] = pending.questions.map((question, index) => ({
        id: question.id,
        selected: pending.selected.get(index) ?? [],
      }))
      this.settle(pending, { answers }, undefined)
    }
  }

  private async refreshQuestionKeyboards(
    pending: PendingQuestion,
    questionIndex: number,
    keyboard: InlineKeyboardMarkup = this.keyboardFor(pending, questionIndex),
  ): Promise<void> {
    for (const chatId of pending.chats) {
      const delivered = pending.messages.get(messageKey(chatId, questionIndex))
      if (delivered !== undefined) {
        await this.client.editMessageReplyMarkup(chatId, delivered.messageId, keyboard).catch(() => {})
      }
    }
  }

  private settle(
    pending: PendingQuestion,
    answer: AskUserQuestionAnswer | undefined,
    error: Error | undefined,
  ): void {
    if (pending.settled) return
    pending.settled = true
    this.pending.delete(pending.nonce)
    if (pending.abortListener !== undefined && pending.signal !== undefined) {
      pending.signal.removeEventListener('abort', pending.abortListener)
    }
    // Dead buttons must not linger: clear every keyboard of this request.
    for (const { chatId, messageId } of pending.messages.values()) {
      void this.client.editMessageReplyMarkup(chatId, messageId, { inline_keyboard: [] }).catch(() => {})
    }
    if (error !== undefined) {
      pending.reject(error)
      return
    }
    pending.resolve(answer as AskUserQuestionAnswer)
  }

  private keyboardFor(pending: PendingQuestion, questionIndex: number): InlineKeyboardMarkup {
    const question = pending.questions[questionIndex]
    const selected = new Set(pending.selected.get(questionIndex) ?? [])
    const base = `${UQ_PREFIX}${pending.nonce}:${questionIndex}:`
    const rows = (question.options ?? []).map((option, optionIndex) => [{
      text: `${question.multiSelect && selected.has(option.label) ? `${CHECK} ` : ''}${truncateButton(option.label)}`,
      callback_data: question.multiSelect
        ? `${base}${UQ_MULTI}:${optionIndex}`
        : `${base}${optionIndex}`,
    }])
    if (question.multiSelect) {
      rows.push([{ text: DONE, callback_data: `${base}${UQ_DONE}` }])
    }
    rows.push([{ text: CANCEL, callback_data: `${UQ_PREFIX}${pending.nonce}:${UQ_CANCEL}` }])
    return { inline_keyboard: rows }
  }
}

function formatQuestion(question: AskUserQuestionItem, index: number, total: number): string {
  const lines: string[] = []
  if (total > 1) lines.push(`❓ 问题 ${index}/${total}`)
  if (question.header) lines.push(`📌 ${question.header}`)
  lines.push(question.question)
  if (question.detail) lines.push('', question.detail)
  const options = question.options ?? []
  if (options.length > 0) {
    lines.push('', ...options.map((option, i) => {
      const description = option.description ? ` — ${option.description}` : ''
      return `${i + 1}. ${option.label}${description}`
    }))
  }
  if (question.multiSelect) lines.push('', '可多选：点选项切换，完成后点下方 ✅。')
  return lines.join('\n')
}
