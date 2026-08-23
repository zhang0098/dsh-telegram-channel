export declare const MSG: {
    readonly DENIED: "无权限。";
    readonly WELCOME: string;
    readonly HELP: string;
    readonly NEED_BIND: "尚未绑定本机会话。请先发送 /sessions 选择一个。";
    readonly NO_SESSIONS: "当前没有可附着的本机会话（已排除归档与空白会话）。请先在 Web（dsh web）或 dsh-tui 打开/继续一个对话，再发 /sessions。";
    readonly NO_SESSIONS_IN_WS: (title: string) => string;
    /** @deprecated use NO_SESSIONS */
    readonly NO_LIVE: "当前没有可附着的本机会话。请先在 Web（dsh web）打开或继续一个对话，再发 /sessions。";
    readonly PICKER_STALE: "列表已过期，请重新发送 /sessions。";
    readonly RESUME_FAILED: "无法附着该会话（resume 失败）。请确认会话存在，或先在电脑端打开后再试。";
    readonly BOUND: (label: string) => string;
    readonly UNBOUND: "已断开绑定。本机会话仍在运行。";
    readonly STATUS_NONE: "当前未绑定任何本机会话。发送 /sessions 选择。";
    readonly STATUS_BOUND: (label: string) => string;
    readonly STATUS_BOUND_COLD: (label: string) => string;
    readonly GONE: "绑定的会话已不可用。请重新 /sessions。";
    readonly LAST_FAILED: "无法读取上次对话。请确认已绑定，且本机 dsh web / apiProxy（或运行中的会话）可用。";
    readonly MODEL_UNAVAILABLE: (detail?: string) => string;
    readonly MODEL_UNROUTABLE: (current: string) => string;
    readonly MODEL_EMPTY: (current: string) => string;
    readonly MODEL_SET: (selected: string) => string;
    readonly MODEL_FAILED: (detail?: string) => string;
    readonly unknown: (command: string) => string;
};
export type ParsedCommand = {
    type: 'start';
    text: string;
} | {
    type: 'help';
    text: string;
} | {
    type: 'sessions';
    text: string;
} | {
    type: 'last';
    text: string;
} | {
    type: 'model';
    text: string;
} | {
    type: 'status';
    text: string;
} | {
    type: 'unbind';
    text: string;
} | {
    type: 'unknown';
    command: string;
    text: string;
} | {
    type: 'plain';
    text: string;
};
export declare function parseCommand(text: string): ParsedCommand;
/** @deprecated Prefer short index callbacks (ws:/sid:); kept for old messages. */
export declare const BIND_CB_PREFIX = "bind:";
/** Inline button: fetch last Q/A for the bound session. */
export declare const LAST_CB = "last";
