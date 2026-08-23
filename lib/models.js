import { randomUUID } from 'node:crypto';
import { resolveApiProxy } from './apiproxy.js';
import { loadSessionModelsLocal, selectSessionModelLocal } from './models-local.js';
function unwrap(res) {
    const r = res;
    if (r?.result?.ok === true)
        return r.result.value;
    return undefined;
}
function unwrapError(res) {
    const r = res;
    if (r?.result && r.result.ok === false) {
        const err = r.result.error;
        if (!err)
            return 'rpc failed';
        return err.code ? `${err.code}: ${err.message ?? ''}`.trim() : (err.message ?? 'rpc failed');
    }
    return undefined;
}
async function call(fn, payload) {
    if (typeof fn !== 'function')
        throw new Error('apiProxy sessions API unavailable');
    return fn({ rpcId: randomUUID(), payload });
}
export async function loadSessionModels(ctx, sessionId, agent) {
    const api = resolveApiProxy(ctx);
    if (api?.sessions?.models) {
        return loadSessionModelsViaApi(ctx, sessionId);
    }
    // Host without apiProxy (martty / ACP host): drive ctx.llm directly.
    if (!agent) {
        throw new Error('no live agent for local model catalog (resume the session first)');
    }
    return loadSessionModelsLocal(ctx, agent);
}
async function loadSessionModelsViaApi(ctx, sessionId) {
    const api = resolveApiProxy(ctx);
    if (!api?.sessions?.models) {
        throw new Error('apiProxy unavailable (use ctx.get / inject apiProxy)');
    }
    const raw = await call(api.sessions.models, { sessionId });
    const value = unwrap(raw);
    if (!value) {
        throw new Error(unwrapError(raw) ?? 'failed to load session models');
    }
    const options = [];
    for (const group of value.groups ?? []) {
        for (const m of group.models ?? []) {
            options.push({
                provider: group.id,
                model: m.id,
                label: `${group.name}/${m.name}`,
                efforts: m.reasoning?.efforts?.map((e) => ({ id: e.id, name: e.name })),
            });
        }
    }
    return {
        current: value.current,
        routable: value.routable,
        options,
    };
}
export async function selectSessionModel(ctx, sessionId, selection, agent) {
    const api = resolveApiProxy(ctx);
    if (api?.sessions?.selectModel) {
        return selectSessionModelViaApi(ctx, sessionId, selection);
    }
    // Host without apiProxy (martty / ACP host): drive ctx.llm directly.
    if (!agent) {
        throw new Error('no live agent for local model selection (resume the session first)');
    }
    return selectSessionModelLocal(ctx, agent, selection);
}
async function selectSessionModelViaApi(ctx, sessionId, selection) {
    const api = resolveApiProxy(ctx);
    if (!api?.sessions?.selectModel) {
        throw new Error('apiProxy unavailable (use ctx.get / inject apiProxy)');
    }
    // Omit undefined reasoningEffort — some validators treat explicit undefined as invalid.
    const payload = {
        sessionId,
        provider: selection.provider,
        model: selection.model,
    };
    if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== '') {
        payload.reasoningEffort = selection.reasoningEffort;
    }
    const raw = await call(api.sessions.selectModel, payload);
    const value = unwrap(raw);
    if (!value?.selected) {
        throw new Error(unwrapError(raw) ?? 'failed to select model');
    }
    return value.selected;
}
export function formatModel(sel) {
    const base = `${sel.provider}/${sel.model}`;
    return sel.reasoningEffort ? `${base} (${sel.reasoningEffort})` : base;
}
