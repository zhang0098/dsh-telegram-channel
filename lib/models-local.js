import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
function llmOf(ctx) {
    const c = ctx;
    try {
        if (c.llm && typeof c.llm.listProviders === 'function')
            return c.llm;
    }
    catch {
        // llm not injected — local /model unsupported on this host
    }
    return undefined;
}
function agentDefaultModelOf(ctx) {
    const c = ctx;
    try {
        if (c.agentDefaultModel)
            return c.agentDefaultModel;
    }
    catch {
        return undefined;
    }
    return undefined;
}
/** One selection owner per live agent, mirroring the web api-proxy's selectionFor. */
const selections = new WeakMap();
function toSelection(sel) {
    if (!sel)
        return undefined;
    return {
        provider: sel.provider,
        model: sel.model,
        ...sel.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(sel.reasoningEffort) },
    };
}
function toPlain(sel) {
    if (!sel)
        return undefined;
    return {
        provider: sel.provider,
        model: sel.model,
        ...sel.reasoningEffort === undefined ? {} : { reasoningEffort: sel.reasoningEffort },
    };
}
function loggedConfig(agent) {
    try {
        const session = agent.session;
        const logged = session.requestHeader?.()?.config;
        if (!logged || typeof logged.provider !== 'string' || typeof logged.model !== 'string')
            return undefined;
        return {
            provider: logged.provider,
            model: logged.model,
            ...logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort },
        };
    }
    catch {
        return undefined;
    }
}
function defaultSelection(ctx) {
    try {
        return agentDefaultModelOf(ctx)?.currentSelection?.();
    }
    catch {
        return undefined;
    }
}
export function selectionFor(ctx, agent) {
    const existing = selections.get(agent);
    if (existing)
        return existing;
    let picked;
    const selection = {
        get current() {
            if (picked !== undefined)
                return toSelection(picked);
            return toSelection(loggedConfig(agent) ?? defaultSelection(ctx));
        },
        set current(next) {
            picked = toPlain(next);
        },
        assembled: undefined,
    };
    installModelSelection(agent.ctx, selection);
    selections.set(agent, selection);
    return selection;
}
/** Mirror of the web api-proxy's buildModelCatalog over ctx.llm. */
async function buildModelCatalog(ctx) {
    const llm = llmOf(ctx);
    if (!llm || typeof llm.listModels !== 'function' || typeof llm.resolveModelInfo !== 'function') {
        return { groups: [], failures: [] };
    }
    const catalog = await Promise.all((llm.listProviders?.() ?? []).map(async (provider) => {
        try {
            const models = await llm.listModels(provider.id);
            const entries = await Promise.all(models.map(async (model) => {
                const resolved = await llm.resolveModelInfo(provider.id, model.id);
                const reasoning = resolved.reasoning === undefined ? undefined : {
                    efforts: (resolved.reasoning.efforts ?? []).map((effort) => ({
                        id: effort.id,
                        name: effort.name ?? effort.id,
                        ...effort.description === undefined ? {} : { description: effort.description },
                    })),
                    ...resolved.reasoning.defaultEffort === undefined ? {} : { defaultEffort: resolved.reasoning.defaultEffort },
                };
                return {
                    id: model.id,
                    name: model.name ?? model.id,
                    ...model.description === undefined ? {} : { description: model.description },
                    ...reasoning === undefined ? {} : { reasoning },
                };
            }));
            return { kind: 'group', group: { id: provider.id, name: provider.name ?? provider.id, models: entries } };
        }
        catch (error) {
            return { kind: 'failure', failure: { id: provider.id, name: provider.name ?? provider.id, message: error instanceof Error ? error.message : String(error) } };
        }
    }));
    return {
        groups: catalog.flatMap((item) => item.kind === 'group' ? [item.group] : []).filter((group) => group.models.length > 0),
        failures: catalog.flatMap((item) => item.kind === 'failure' ? [item.failure] : []),
    };
}
function servedProviders(ctx) {
    try {
        return llmOf(ctx)?.listProviders?.().map((p) => p.id) ?? [];
    }
    catch {
        return [];
    }
}
/** Local catalog + current selection for one live agent. */
export async function loadSessionModelsLocal(ctx, agent) {
    const selection = selectionFor(ctx, agent);
    const current = selection.current ?? { provider: '', model: '' };
    const { groups, failures } = await buildModelCatalog(ctx);
    const served = servedProviders(ctx);
    const options = [];
    for (const group of groups) {
        for (const m of group.models) {
            options.push({
                provider: group.id,
                model: m.id,
                label: `${group.name}/${m.name}`,
                efforts: m.reasoning?.efforts?.map((e) => ({ id: e.id, name: e.name })),
            });
        }
    }
    if (failures.length > 0) {
        const detail = failures.map((f) => {
            const f2 = f;
            return f2.id ? `${f2.id}: ${f2.message ?? ''}` : String(f);
        }).join('; ');
        ctx.logger.warn(`dsh-telegram-channel: some model providers failed (local catalog): ${detail}`);
    }
    return {
        current,
        routable: served.length === 0 || served.includes(current.provider),
        options,
    };
}
/** Apply a picked model to one live agent (local path). */
export async function selectSessionModelLocal(ctx, agent, selection) {
    const llm = llmOf(ctx);
    if (!llm || typeof llm.resolveCallConfig !== 'function') {
        throw new Error('local model service unavailable (ctx.llm missing on this host)');
    }
    const resolved = await llm.resolveCallConfig({
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) },
    });
    const selected = {
        provider: resolved.provider,
        model: resolved.model,
        ...resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort },
    };
    const holder = selectionFor(ctx, agent);
    holder.current = toSelection(selected);
    try {
        await agentDefaultModelOf(ctx)?.saveSelection?.(selected);
    }
    catch (error) {
        ctx.logger.warn(`dsh-telegram-channel: model switch applied to this session but was not saved as default: ${String(error)}`);
    }
    return selected;
}
