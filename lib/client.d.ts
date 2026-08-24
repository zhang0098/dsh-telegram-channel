export interface TelegramUser {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    username?: string;
}
export interface TelegramChat {
    id: number;
    type: string;
    title?: string;
    username?: string;
}
export interface TelegramMessage {
    message_id: number;
    date: number;
    chat: TelegramChat;
    from?: TelegramUser;
    text?: string;
}
export interface TelegramCallbackQuery {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
}
export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
}
export interface InlineKeyboardButton {
    text: string;
    callback_data: string;
}
export interface InlineKeyboardMarkup {
    inline_keyboard: InlineKeyboardButton[][];
}
export interface TelegramBotCommand {
    command: string;
    description: string;
}
export interface TelegramInputRichMessage {
    markdown: string;
    skip_entity_detection?: boolean;
}
export interface TelegramClientOptions {
    fetch?: typeof fetch;
    baseUrl?: string;
    pollingTimeoutSec?: number;
}
export interface TelegramClientLike {
    getMe(): Promise<TelegramUser>;
    getUpdates(offset?: number): Promise<TelegramUpdate[]>;
    sendMessage(chatId: number, text: string, parseMode?: string, replyMarkup?: InlineKeyboardMarkup): Promise<TelegramMessage>;
    sendRichMessage(chatId: number, markdown: string): Promise<TelegramMessage>;
    sendChatAction(chatId: number, action: string): Promise<boolean>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
    editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: InlineKeyboardMarkup): Promise<boolean>;
    setMyCommands(commands: TelegramBotCommand[]): Promise<boolean>;
    /** Abort any in-flight requests (long polling must not block teardown). */
    abort?(): void;
}
export declare class TelegramClient implements TelegramClientLike {
    private readonly token;
    private readonly fetchImpl;
    private readonly baseUrl;
    private readonly pollingTimeoutSec;
    private readonly abortController;
    constructor(token: string, options?: TelegramClientOptions);
    private redact;
    /** Abort all in-flight requests. Subsequent calls fail fast until replaced. */
    abort(): void;
    private call;
    getMe(): Promise<TelegramUser>;
    getUpdates(offset?: number): Promise<TelegramUpdate[]>;
    sendMessage(chatId: number, text: string, parseMode?: string, replyMarkup?: InlineKeyboardMarkup): Promise<TelegramMessage>;
    sendRichMessage(chatId: number, markdown: string): Promise<TelegramMessage>;
    sendChatAction(chatId: number, action: string): Promise<boolean>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
    editMessageReplyMarkup(chatId: number, messageId: number, replyMarkup: InlineKeyboardMarkup): Promise<boolean>;
    setMyCommands(commands: TelegramBotCommand[]): Promise<boolean>;
}
