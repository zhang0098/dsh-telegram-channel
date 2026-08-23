import type { Context } from '@deepseek-ai/cordis';
import { type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent';
import type { ModelSnapshot } from './models.js';
/**
 * Local fallback for /model on hosts without apiProxy (dsh web host).
 *
 * The martty / ACP host tree (Base + ACP bridge) never provides `apiProxy`
 * — that service is mounted only by the web profile (`dsh-web-app` mounts
 * `@deepseek-ai/dsh-host-apiproxy`). The Telegram plugin must therefore not
 * list it in `inject` (Cordis inject is all-required; a missing service parks
 * the fiber forever). Instead we probe `ctx.get('apiProxy')` at runtime and,
 * when absent, drive the same harness services the web api-proxy wraps:
 * `ctx.llm` for the provider/model catalog and request-config resolution, and
 * `installModelSelection` (exported by `@deepseek-ai/dsh-agent`, the same
 * helper the web api-proxy uses) to couple the picked selection to the
 * agent's prompt assembly and request routing.
 */
export interface SelectedModel {
    provider: string;
    model: string;
    reasoningEffort?: string;
}
interface SelectionLike {
    current: ModelSelection | undefined;
    assembled: ModelSelection | undefined;
}
export declare function selectionFor(ctx: Context, agent: Agent): SelectionLike;
/** Local catalog + current selection for one live agent. */
export declare function loadSessionModelsLocal(ctx: Context, agent: Agent): Promise<ModelSnapshot>;
/** Apply a picked model to one live agent (local path). */
export declare function selectSessionModelLocal(ctx: Context, agent: Agent, selection: {
    provider: string;
    model: string;
    reasoningEffort?: string;
}): Promise<SelectedModel>;
export {};
