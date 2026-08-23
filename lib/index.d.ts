import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "dsh-telegram-channel";
/**
 * agents: followup + live catalog + local /model.
 * apiProxy is NOT injected: it only exists on the web host (dsh-web-app mounts
 * dsh-host-apiproxy). Cordis inject is all-required — declaring it would park
 * this fiber forever on hosts without it (martty / ACP host, headless). We
 * probe it at runtime via ctx.get and fall back to ctx.llm / live agents.
 */
export declare const inject: string[];
export interface TelegramChannelConfig {
    token?: string;
    allowedUserIds?: number[];
    allowAllUsers?: boolean;
    maxMessageLength?: number;
    pollingTimeoutSec?: number;
    rendering?: string;
}
export declare const Config: Schema<TelegramChannelConfig>;
export declare function apply(ctx: Context, config: TelegramChannelConfig): void;
export * from './format.js';
export * from './client.js';
export * from './auth.js';
export * from './commands.js';
export * from './label.js';
export * from './bridge.js';
