export const MSG = {
    DENIED: '无权限。',
    WELCOME: [
        '你好，这是 DeepSeek Harness 的手机遥控器。',
        '本机会话是真相源：请先在 Web 或 dsh-tui 打开对话，再用 /sessions 选择工作区 → 会话并附着。',
        '发送 /help 查看命令。',
    ].join('\n'),
    HELP: [
        '/sessions — 按工作区列出本机会话（与 Web 对齐，排除归档）并附着',
        '/last — 查看绑定会话的上次问答（便于续接）',
        '/model — 切换当前绑定会话的模型（下一回合生效）',
        '/status — 查看当前绑定',
        '/unbind — 断开绑定（不关闭本机会话）',
        '/help — 显示帮助',
        '',
        '绑定后直接发文字，消息会进入该本机会话；Web / dsh-tui 与手机看到同一条轨迹。',
        '仅白名单用户可用。无会话时请先在 dsh web 或 dsh-tui 开对话或保留历史会话。',
    ].join('\n'),
    NEED_BIND: '尚未绑定本机会话。请先发送 /sessions 选择一个。',
    NO_SESSIONS: '当前没有可附着的本机会话（已排除归档与空白会话）。请先在 Web（dsh web）或 dsh-tui 打开/继续一个对话，再发 /sessions。',
    NO_SESSIONS_IN_WS(title) {
        return `工作区「${title}」下没有可附着的会话。`;
    },
    /** @deprecated use NO_SESSIONS */
    NO_LIVE: '当前没有可附着的本机会话。请先在 Web（dsh web）打开或继续一个对话，再发 /sessions。',
    PICKER_STALE: '列表已过期，请重新发送 /sessions。',
    RESUME_FAILED: '无法附着该会话（resume 失败）。请确认会话存在，或先在电脑端打开后再试。',
    BOUND(label) {
        return `已附着本机会话：${label}\n此后消息将进入该会话（与 Web 同轨迹）。\n需要续接时可点「查看上次对话」，或发送 /last。`;
    },
    UNBOUND: '已断开绑定。本机会话仍在运行。',
    STATUS_NONE: '当前未绑定任何本机会话。发送 /sessions 选择。',
    STATUS_BOUND(label) {
        return `当前绑定：${label}`;
    },
    STATUS_BOUND_COLD(label) {
        return `当前绑定：${label}\n（会话当前未在内存中运行；发消息时会自动 resume。）`;
    },
    GONE: '绑定的会话已不可用。请重新 /sessions。',
    LAST_FAILED: '无法读取上次对话。请确认已绑定，且本机 dsh web / apiProxy（或运行中的会话）可用。',
    MODEL_UNAVAILABLE(detail) {
        const tip = '无法读取模型列表。请确认已绑定会话，且本机 dsh web（host-apiproxy）或 dsh-tui host（本地模型目录）可用。';
        if (!detail)
            return tip;
        return `${tip}\n详情：${detail}`;
    },
    MODEL_UNROUTABLE(current) {
        return `当前模型不可路由：${current}\n请在 Web 或本机配置可用 provider 后再试 /model。`;
    },
    MODEL_EMPTY(current) {
        return `当前：${current}\n没有可切换的模型选项。`;
    },
    MODEL_SET(selected) {
        return `已切换模型：${selected}\n下一回合生效。`;
    },
    MODEL_FAILED(detail) {
        const tip = '切换模型失败。请稍后重试或在 Web 中切换。';
        if (!detail)
            return tip;
        return `${tip}\n详情：${detail}`;
    },
    unknown(command) {
        return `未知命令 ${command}。发送 /help 查看可用命令。`;
    },
};
export function parseCommand(text) {
    if (!text.startsWith('/'))
        return { type: 'plain', text };
    const raw = text.split(/\s+/)[0] ?? text;
    const command = raw.includes('@') ? raw.slice(0, raw.indexOf('@')) : raw;
    switch (command) {
        case '/start':
            return { type: 'start', text };
        case '/help':
            return { type: 'help', text };
        case '/sessions':
        case '/list':
            return { type: 'sessions', text };
        case '/last':
        case '/context':
            return { type: 'last', text };
        case '/model':
            return { type: 'model', text };
        case '/status':
            return { type: 'status', text };
        case '/unbind':
        case '/disconnect':
            return { type: 'unbind', text };
        default:
            return { type: 'unknown', command, text };
    }
}
/** @deprecated Prefer short index callbacks (ws:/sid:); kept for old messages. */
export const BIND_CB_PREFIX = 'bind:';
/** Inline button: fetch last Q/A for the bound session. */
export const LAST_CB = 'last';
