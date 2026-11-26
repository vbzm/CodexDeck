import { HttpError } from './http.mjs';

export async function modelCatalog(bridge) {
  const [catalog, current] = await Promise.all([
    bridge.request('model/list', {}),
    bridge.request('config/read', {}),
  ]);
  const models = (catalog.data || catalog.models || []).map((model) => ({
    id: model.id || model.model,
    displayName: model.displayName || model.id || model.model,
    defaultReasoningEffort: model.defaultReasoningEffort,
    supportedReasoningEfforts: (model.supportedReasoningEfforts || []).map((item) => item.reasoningEffort),
  }));
  return {
    models,
    defaults: {
      model: current.config?.model || null,
      effort: current.config?.model_reasoning_effort || null,
    },
  };
}

export async function turnOptions(body, bridge) {
  if (body.model === undefined && body.effort === undefined) return {};
  if (typeof body.model !== 'string' || !body.model || typeof body.effort !== 'string' || !body.effort) {
    throw new HttpError(400, '请选择有效的模型和思考等级');
  }
  const catalog = await modelCatalog(bridge);
  const model = catalog.models.find((entry) => entry.id === body.model);
  if (!model || !model.supportedReasoningEfforts.includes(body.effort)) {
    throw new HttpError(400, '模型或思考等级不受当前 Desktop 支持');
  }
  return { model: body.model, effort: body.effort };
}
