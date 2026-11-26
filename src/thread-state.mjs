export function createThreadState(bridge) {
  const records = new Map();
  let goalSupported = true;

  function record(threadId) {
    if (!records.has(threadId)) records.set(threadId, { goal: null, completedGoal: null, clearedGoal: null, revision: 0, compactions: new Map() });
    return records.get(threadId);
  }

  function updateGoal(threadId, goal) {
    const entry = record(threadId);
    entry.goal = goal;
    entry.revision++;
    if (goal) {
      entry.completedGoal = goal.status === 'complete' ? goal : null;
      entry.clearedGoal = null;
    }
  }

  function onStatus(event) {
    const params = event.params || {};
    if (!params.threadId) return;
    if (event.method === 'thread/goal/updated') {
      const cleared = record(params.threadId).clearedGoal;
      const goal = params.goal;
      // 显式清除后的旧完成通知可能仍在队列中，不能让同一完成记录再次出现。
      if (cleared && goal?.status === 'complete' && goal.objective === cleared.objective &&
          goal.createdAt === cleared.createdAt && goal.updatedAt === cleared.updatedAt) return;
      updateGoal(params.threadId, params.goal);
    } else if (event.method === 'thread/goal/cleared') {
      // Desktop 达成目标后会立即清除当前目标；保留完成快照供网页展示。
      updateGoal(params.threadId, null);
    } else if (params.item?.type === 'contextCompaction') {
      const entry = record(params.threadId);
      const previous = entry.compactions.get(params.item.id);
      entry.compactions.set(params.item.id, {
        ...previous, ...params.item, turnId: params.turnId,
        completed: event.method === 'item/completed',
        startedAtMs: params.startedAtMs ?? previous?.startedAtMs ?? Date.now(),
        source: params.item.source ?? previous?.source ?? 'automatic',
      });
      if (entry.compactions.size > 100) entry.compactions.delete(entry.compactions.keys().next().value);
    } else if (event.method === 'turn/completed') {
      for (const item of record(params.threadId).compactions.values()) {
        if (item.turnId === params.turn?.id && !item.completed) item.interrupted = true;
      }
    }
  }

  function onDisconnect() {
    goalSupported = true;
    for (const entry of records.values()) {
      entry.revision++;
      // 断线不代表压缩成功；重新读取历史后再确认其结果。
      for (const [id, item] of entry.compactions) if (!item.completed) entry.compactions.delete(id);
    }
  }

  async function read(threadId) {
    const entry = record(threadId);
    const revision = entry.revision;
    let goalError = null;
    if (goalSupported) {
      try {
        const result = await bridge.request('thread/goal/get', { threadId });
        // 通知可能在请求等待期间到达，避免旧快照覆盖更新后的目标。
        if (revision === entry.revision) updateGoal(threadId, result.goal ?? null);
      } catch (error) {
        if (error.code === -32601) goalSupported = false;
        else goalError = '读取目标失败：' + error.message;
      }
    }
    return { goal: entry.goal, completedGoal: entry.completedGoal, goalSupported, goalError,
      compactions: [...entry.compactions.values()] };
  }

  function clearGoal(threadId) {
    const entry = record(threadId);
    entry.clearedGoal = entry.goal || entry.completedGoal;
    updateGoal(threadId, null);
    entry.completedGoal = null;
  }

  return { read, updateGoal, clearGoal, onStatus, onDisconnect };
}
