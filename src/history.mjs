export async function readItemPage(bridge, { threadId, turnId, cursor = null }) {
  let limit = 100;
  for (;;) {
    let page;
    try {
      page = await bridge.request('thread/items/list', { threadId, turnId, cursor, limit, sortDirection: 'desc' });
    } catch (error) {
      if (!error.message?.includes('decoded message length too large')) throw error;
      if (limit === 1) throw new Error('单条过程内容过大，暂时无法读取');
      limit = Math.max(1, Math.floor(limit / 2));
      continue;
    }
    const nextCursor = page.nextCursor ?? null;
    if (nextCursor !== null && nextCursor === cursor) throw new Error('读取过程失败：分页游标未向前推进');
    const items = (page.data || []).flatMap((entry) => {
      if (entry.turnId && entry.turnId !== turnId) return [];
      if (!('item' in entry)) return [entry];
      return [{ ...entry.item,
        ...(entry.startedAtMs == null ? {} : { startedAtMs: entry.startedAtMs }),
        ...(entry.completedAtMs == null ? {} : { completedAtMs: entry.completedAtMs }),
      }];
    }).reverse();
    return { items, nextCursor };
  }
}

function retainSummary(turn, items) {
  const opening = turn.items?.find((item) => item.type === 'userMessage');
  const final = turn.items?.findLast((item) => item.type === 'agentMessage' && item.phase === 'final_answer') ??
    turn.items?.findLast((item) => item.type === 'agentMessage');
  const current = new Map(items.map((item) => [item.id, item]));
  const seen = new Set();
  // 条目页可能只含回合尾部，保留摘要首句与最终回复；相同 ID 采用较新的条目页。
  const merged = [opening, ...items, final].filter(Boolean).flatMap((item) => {
    if (seen.has(item.id)) return [];
    seen.add(item.id);
    return [current.get(item.id) || item];
  });
  const time = (item) => Number.isFinite(item.startedAtMs) ? item.startedAtMs :
    item.id === opening?.id ? -Infinity : item.id === final?.id ? Infinity : 0;
  return merged.sort((left, right) => time(left) - time(right));
}

export async function readTurnPage(bridge, { threadId, limit, cursor = null, itemsView = 'full' }) {
  const page = await bridge.request('thread/turns/list', { threadId, limit, cursor,
    itemsView: 'summary', sortDirection: 'desc' });
  // 首屏先返回提问和回复，避免折叠的工具过程拖住最新消息；展开时再从条目第一页读取。
  if (itemsView === 'summary') return { ...page, data: (page.data || []).map((turn) => ({
    ...turn, itemsView: 'summary', itemsDeferred: true, itemsCursor: null, itemsStartId: null,
  })) };
  const data = Array(page.data?.length || 0);
  let index = 0;
  // 每次最多四个回合读取过程，避免长历史挤占 Desktop 的其它请求。
  await Promise.all(Array.from({ length: Math.min(4, data.length) }, async () => {
    while (index < data.length) {
      const position = index++;
      const turn = page.data[position];
      try {
        const { items, nextCursor } = await readItemPage(bridge, { threadId, turnId: turn.id });
        data[position] = { ...turn, items: nextCursor === null ? items : retainSummary(turn, items),
          itemsCursor: nextCursor, itemsStartId: items[0]?.id ?? null, itemsDeferred: false,
          itemsView: nextCursor === null ? 'full' : 'summary' };
      } catch (error) {
        data[position] = { ...turn, itemsView: 'summary', itemsDeferred: false, itemsCursor: null, itemsStartId: null,
          itemsError: '读取回合过程失败：' + (error.message || 'Desktop 暂未返回过程内容') };
      }
    }
  }));
  return { ...page, data };
}
