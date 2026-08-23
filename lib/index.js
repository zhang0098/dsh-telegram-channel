import Schema from '@deepseek-ai/schemastery';
import { TelegramBridge } from './bridge.js';
export const name = 'dsh-telegram-channel';
/**
 * agents: followup + live catalog + local /model.
 * apiProxy is NOT injected: it only exists on the web host (dsh-web-app mounts
 * dsh-host-apiproxy). Cordis inject is all-required — declaring it would park
 * this fiber forever on hosts without it (martty / ACP host, headless). We
 * probe it at runtime via ctx.get and fall back to ctx.llm / live agents.
 */
export const inject = ['agents'];
export const Config = Schema.object({
    token: Schema.string().default(''),
    allowedUserIds: Schema.array(Schema.number()).default([]),
    allowAllUsers: Schema.boolean().default(false),
    maxMessageLength: Schema.number().default(4096),
    pollingTimeoutSec: Schema.number().default(30),
    rendering: Schema.string().default('rich'),
});
function resolveAllowedUserIds(config) {
    if (config.allowedUserIds && config.allowedUserIds.length > 0) {
        return config.allowedUserIds;
    }
    const raw = process.env.DSH_TELEGRAM_ALLOWED_USER_IDS ?? '';
    return raw
        .split(/[,;\s]+/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => Number(part))
        .filter((n) => Number.isFinite(n) && n > 0);
}
export function apply(ctx, config) {
    const token = (config.token && config.token.length > 0)
        ? config.token
        : (process.env.DSH_TELEGRAM_TOKEN ?? '');
    if (!token) {
        ctx.logger.error('dsh-telegram-channel: missing bot token (set config.token or DSH_TELEGRAM_TOKEN); polling not started');
        return;
    }
    const bridge = new TelegramBridge(ctx, {
        token,
        allowedUserIds: resolveAllowedUserIds(config),
        allowAllUsers: config.allowAllUsers ?? false,
        maxMessageLength: config.maxMessageLength ?? 4096,
        pollingTimeoutSec: config.pollingTimeoutSec ?? 30,
        rendering: config.rendering === 'html' ? 'html' : 'rich',
    });
    ctx.effect(() => {
        bridge.start();
        return () => { void bridge.stop(); };
    }, 'dsh-telegram-channel.serve');
}
export * from './format.js';
export * from './client.js';
export * from './auth.js';
export * from './commands.js';
export * from './label.js';
export * from './bridge.js';
