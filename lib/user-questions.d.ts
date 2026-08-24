import type { Context, Logger } from '@deepseek-ai/cordis';
import type { TelegramClientLike } from './client.js';
/**
 * Wire types mirroring `@deepseek-ai/dsh-user-questions/types`, kept local so
 * this plugin never hard-imports the seam package (older hosts lack it). The
 * service itself is duck-typed at runtime.
 */
export interface AskUserQuestionOption {
    label: string;
    description?: string;
}
export interface AskUserQuestionItem {
    id: string;
    question: string;
    detail?: string;
    header?: string;
    options?: AskUserQuestionOption[];
    multiSelect?: boolean;
    intent?: {
        kind: string;
        approve?: string;
    };
}
export interface AskUserQuestionAnswerItem {
    id: string;
    selected: string[];
    custom?: string;
}
export interface AskUserQuestionAnswer {
    answers: AskUserQuestionAnswerItem[];
}
export interface AskUserQuestionRequest {
    questions: AskUserQuestionItem[];
    agent?: {
        id: unknown;
    };
    signal?: AbortSignal;
}
/** Duck-typed `@deepseek-ai/dsh-user-questions` service surface. */
export interface UserQuestionServiceLike {
    ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>;
}
/** Error shaped like the seam's `UserQuestionError` (message + stable code). */
export declare function userQuestionError(message: string, code: string): Error & {
    code: string;
};
export interface TelegramUserQuestionsOptions {
    client: TelegramClientLike;
    /** Bound Telegram chat ids for a live session id, in binding order. */
    boundChatsFor: (sessionId: string) => number[];
    logger?: Pick<Logger, 'info' | 'warn'>;
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
export declare class TelegramUserQuestions {
    private readonly client;
    private readonly boundChatsFor;
    private readonly logger?;
    private readonly pending;
    /** service → the interposing function installed as `service.ask`. */
    private readonly patches;
    /** service → original `ask` captured before interposing. */
    private readonly originals;
    private ctx;
    private serviceListener;
    private installed;
    constructor(options: TelegramUserQuestionsOptions);
    /** Interpose `ctx.userQuestions.ask` when the seam exists; no-op otherwise. */
    install(ctx: Context): void;
    /**
     * Handle a callback query that belongs to a pending question.
     * Returns true when `data` carried the `uq:` prefix (consumed, stale or not).
     */
    handleCallback(data: string, chatId: number, callbackId: string): Promise<boolean>;
    /**
     * Teardown: reject every pending question, restore the seam's original
     * `ask`, and stop listening for service replacements.
     */
    dispose(): void;
    private lookupService;
    private adopt;
    private interposed;
    private askViaTelegram;
    /** Record an answer for one question; resolve the whole request when all are in. */
    private answerQuestion;
    private refreshQuestionKeyboards;
    private settle;
    private keyboardFor;
}
