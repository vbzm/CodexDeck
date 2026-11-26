import assert from 'node:assert/strict';
import { modelCatalog, turnOptions } from '../src/models.mjs';

const bridge = { request: async (method) => method === 'model/list' ? {
  data: [{ id: 'test-model', displayName: 'Test Model', defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }],
} : { config: { model: 'test-model', model_reasoning_effort: 'medium' } } };

const catalog = await modelCatalog(bridge);
assert.deepEqual(catalog.defaults, { model: 'test-model', effort: 'medium' });
assert.deepEqual(catalog.models[0].supportedReasoningEfforts, ['low', 'medium']);
assert.deepEqual(await turnOptions({ model: 'test-model', effort: 'low' }, bridge),
  { model: 'test-model', effort: 'low' });
await assert.rejects(turnOptions({ model: 'test-model', effort: 'ultra' }, bridge),
  /不受当前 Desktop 支持/);
await assert.rejects(turnOptions({ model: 'unknown', effort: 'low' }, bridge),
  /不受当前 Desktop 支持/);
console.log('模型与思考等级校验通过');
