import test from 'node:test';
import assert from 'node:assert/strict';

import { createSillyViewPublicAPI } from '../modules/services/publicApi.js';

const config = {
    multi_account: {
        control_worldbook_name: 'SillyView_accounts',
        role_memory_key: 'sv_role_decision_latest',
    },
    world_book_keys: {
        player_portfolio: 'portfolio',
        global_market: 'market',
        asset_prefix: 'asset_',
        config: 'config',
    },
    asset_definitions: {
        EURUSD: { name: '欧元/美元', trade_config: { fee_rate: 0.002 } },
    },
};

function createData(asset, managedStates = []) {
    const states = {
        portfolio: { cash: 10000, debt: 0, starting_cash: 10000, assets: {} },
        market: { current_datetime: 'test' },
        asset_EURUSD: asset,
    };
    return {
        config,
        positionCalculator: { calculateAll: () => ({}) },
        getState: key => structuredClone(states[key] || null),
        getManagedAccountStates: async () => structuredClone(managedStates),
        getManagedRoleProfiles: async () => [],
        getRoleDecisionMemory: async () => ({ version: 1, updated_at: 0, latest_run: null }),
        getArchivedNews: () => [],
        getActiveMarketNews: () => [],
        _calculatePortfolioMarkedValue: portfolio => portfolio.cash,
    };
}

test('mobile market change uses the earliest candle while history is under 24 hours', async () => {
    const data = createData({
        current_price: 1.09,
        change_pct: 0,
        kline_hourly: [
            { time: 0, close: 1.08 },
            { time: 1, close: 1.085 },
        ],
    });
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });
    const market = await api.getMarket();
    assert.equal(market.assets[0].change_pct, 0.9259);
});

test('mobile market change uses the close from 24 hours ago', async () => {
    const hourly = Array.from({ length: 30 }, (_, time) => ({ time, close: 1 + time * 0.001 }));
    const data = createData({ current_price: 1.04, kline_hourly: hourly });
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });
    const snapshot = await api.getSnapshot();
    assert.equal(snapshot.api_version, '2.7.1');
    assert.equal(snapshot.market.assets[0].change_pct, 3.4826);
});

test('managed account snapshots expose role pending orders', async () => {
    const order = {
        id: 'ord_role',
        asset_code: 'EURUSD',
        order_type: 'limit',
        side: 'buy',
        intent: 'open_long',
        mode: 'leveraged',
        amount: 1000,
        leverage: 5,
        trigger_price: 1.05,
        status: 'pending',
    };
    const managedStates = [{
        account_id: 'acct_role',
        owner_name: '测试角色',
        portfolio: {
            cash: 10000,
            debt: 0,
            starting_cash: 10000,
            assets: {},
            pending_orders: [order],
            order_history: [],
        },
    }];
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] }, managedStates);
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });
    const snapshot = await api.getSnapshot();
    assert.equal(snapshot.accounts[0].pending_orders[0].id, 'ord_role');
    assert.equal(snapshot.accounts[0].pending_orders[0].trigger_price, 1.05);
});

test('mobile role thoughts come from persisted worldbook memory after runtime state is lost', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    data.getRoleDecisionMemory = async () => ({
        version: 1,
        updated_at: 123,
        latest_run: {
            status: 'completed',
            completed_at: 120,
            raw_output: '<role_thought role="张三">我会先冷静判断。</role_thought><role_outline role="张三">下一步观察局势。</role_outline>',
        },
    });
    const roleDecision = {
        lastRun: null,
        running: false,
        isEnabled: () => true,
    };
    const api = createSillyViewPublicAPI({ data, roleDecision, config });

    const snapshot = await api.getSnapshot();

    assert.deepEqual(snapshot.roles, [{
        role_name: '张三',
        thought: '我会先冷静判断。',
        outline: '下一步观察局势。',
    }]);
    assert.equal(snapshot.role_status.completed_at, 120);
    assert.equal(snapshot.role_status.source, 'worldbook');
    assert.equal(snapshot.role_status.worldbook_name, 'SillyView_accounts');
});

test('mobile API delegates panel toggling and exposes mobile actions', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    let advanced = false;
    const api = createSillyViewPublicAPI({
        data,
        app: { commitAndAdvance: async options => { advanced = options.source === 'mobile'; } },
        roleDecision: null,
        config,
        togglePanel: async () => ({ visible: true }),
    });

    assert.equal(api.version, '2.7.1');
    assert.equal(api.readonly, false);
    assert.deepEqual(await api.togglePanel(), { visible: true });
    assert.deepEqual(await api.commitAndAdvance(), { ok: true });
    assert.equal(advanced, true);
});

test('mobile memo tasks use market time, account balance, and send completion prompts', async () => {
    const managedStates = [{
        account_id: 'acct_role',
        owner_name: '测试角色',
        portfolio: { cash: 6000, debt: 0, starting_cash: 6000, assets: {}, pending_orders: [], order_history: [] },
    }];
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] }, managedStates);
    const originalGetState = data.getState;
    let memoState = { tasks: [{
        id: 'rent',
        name: '支付房租',
        content: '在期限前准备房租。',
        deadline: '2026年08月08日-星期六-12:00',
        required_amount: 5000,
        account_id: 'acct_role',
        complete_prompt: '房租任务已经完成。',
        failed_prompt: '房租任务失败。',
    }] };
    data.getState = key => {
        if (key === 'market') return { current_datetime: '2026年08月06日-星期四-12:00' };
        if (key === 'sv_memo_tasks') return structuredClone(memoState);
        return originalGetState(key);
    };
    data.updateState = async (_key, updater) => { memoState = updater(structuredClone(memoState)); };
    const prompts = [];
    const api = createSillyViewPublicAPI({ data, app: { sendMemoPrompt: async prompt => prompts.push(prompt) }, roleDecision: null, config });

    const snapshot = await api.getSnapshot();
    assert.equal(snapshot.memo_tasks[0].status, 'active');
    assert.equal(snapshot.memo_tasks[0].remaining_label, '2天 0小时');
    assert.equal(snapshot.memo_tasks[0].current_balance, 6000);
    assert.equal(snapshot.memo_tasks[0].remaining_amount, 0);

    const result = await api.completeMemoTask('rent');
    assert.equal(result.ok, true);
    assert.equal(memoState.tasks[0].completed, true);
    assert.deepEqual(prompts, ['房租任务已经完成。']);
});

test('mobile memo task is disabled when balance is below required amount', async () => {
    const managedStates = [{
        account_id: 'acct_role',
        owner_name: '测试角色',
        portfolio: { cash: 5000, debt: 0, starting_cash: 5000, assets: {}, pending_orders: [], order_history: [] },
    }];
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] }, managedStates);
    const originalGetState = data.getState;
    data.getState = key => key === 'sv_memo_tasks'
        ? { tasks: [{ id: 'below', deadline: '2099-01-01 00:00', required_amount: 5001, account_id: 'acct_role' }] }
        : originalGetState(key);
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });

    const snapshot = await api.getSnapshot();
    assert.equal(snapshot.memo_tasks[0].status, 'insufficient');
});

test('expired mobile memo task sends its failure prompt when acknowledged', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    const originalGetState = data.getState;
    data.getState = key => {
        if (key === 'market') return { current_datetime: '2026-08-06 12:00' };
        if (key === 'sv_memo_tasks') return { tasks: [{ id: 'expired', deadline: '2026-08-05 12:00', required_amount: 1, failed_prompt: '任务已经失败。' }] };
        return originalGetState(key);
    };
    const prompts = [];
    const api = createSillyViewPublicAPI({ data, app: { sendMemoPrompt: async prompt => prompts.push(prompt) }, roleDecision: null, config });

    const result = await api.completeMemoTask('expired');
    assert.equal(result.status, 'failed');
    assert.deepEqual(prompts, ['任务已经失败。']);
});

test('completing a memo task loaded from the character worldbook updates and sends it', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    let entries = [{ name: 'sv_memo_tasks', content: JSON.stringify({ tasks: [{ id: 'external', deadline: '2099-01-01 00:00', required_amount: 1, complete_prompt: '外部任务完成。' }] }) }];
    data.th = {
        getCharWorldbookNames: async () => ({ primary: 'character_book', additional: [] }),
        getWorldbook: async () => structuredClone(entries),
        updateWorldbookWith: async (_book, updater) => { entries = updater(structuredClone(entries)); },
    };
    const prompts = [];
    const api = createSillyViewPublicAPI({ data, app: { sendMemoPrompt: async prompt => prompts.push(prompt) }, roleDecision: null, config });

    const result = await api.completeMemoTask('external');
    assert.equal(result.ok, true);
    assert.equal(JSON.parse(entries[0].content).tasks[0].completed, true);
    assert.deepEqual(prompts, ['外部任务完成。']);
});

test('memo task with completed_at is treated as completed', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    data.getState = key => key === 'sv_memo_tasks'
        ? { tasks: [{ id: 'timestamped', deadline: '2020-01-01 00:00', required_amount: 999999, completed_at: 123 }] }
        : null;
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });
    const snapshot = await api.getSnapshot();
    assert.equal(snapshot.memo_tasks[0].status, 'completed');
});

test('series memo tasks with no unlocked steps remain locked', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    data.getState = key => key === 'sv_memo_tasks'
        ? { tasks: [{ id: 'affection_locked', type: 'series', name: '好感任务', steps: [] }] }
        : null;
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });

    const snapshot = await api.getSnapshot();
    assert.equal(snapshot.memo_tasks[0].status, 'locked');
    assert.equal(snapshot.memo_tasks[0].current_step_id, null);

    const result = await api.completeMemoTask('affection_locked');
    assert.deepEqual(result, {
        ok: false,
        status: 'locked',
        message: '该任务尚未达到解锁所需的好感度。',
    });
});

test('character memo task kinds share the character category and keep subcategories', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    data.getState = key => key === 'sv_memo_tasks' ? { tasks: [
        { id: 'role_main', task_category: 'character_main', character_group: '角色甲' },
        { id: 'role_affection', task_category: 'affection', character_group: '角色甲' },
        { id: 'role_side', task_category: 'character_side', character_group: '角色甲' },
        { id: 'general_main', task_category: 'main' },
    ] } : null;
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });

    const tasks = (await api.getSnapshot()).memo_tasks;
    assert.deepEqual(tasks.map(task => [task.id, task.task_category, task.task_subcategory]), [
        ['role_main', 'character', 'main'],
        ['role_affection', 'character', 'affection'],
        ['role_side', 'character', 'side'],
        ['general_main', 'main', 'main'],
    ]);
});

test('memo character groups populate role directory when no role decision exists', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    data.getState = key => key === 'sv_memo_tasks' ? { tasks: [
        { id: 'role_task', task_category: 'character_side', character_group: '角色甲' },
    ] } : null;
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });

    const snapshot = await api.getSnapshot();
    assert.deepEqual(snapshot.roles, [{ role_name: '角色甲', thought: '', outline: '' }]);
});

test('series memo tasks expose only the current step and advance progress', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    let memoProgress = null;
    const memoState = { tasks: [{ id: 'series', type: 'series', name: '系列', stage_contents: ['第一阶段说明', '第二阶段说明'], steps: [
        { id: 'one', name: '第一步', deadline: '2099-01-01 00:00', required_amount: 100, complete_prompt: '第一步完成。' },
        { id: 'two', name: '第二步', deadline: '2099-01-01 00:00', required_amount: 200, complete_prompt: '第二步完成。' },
    ] }] };
    data.getState = key => key === 'sv_memo_tasks' ? structuredClone(memoState) : key === 'sv_memo_progress' ? structuredClone(memoProgress) : key === 'portfolio' ? { cash: 1000 } : null;
    data.updateState = async (key, updater) => { if (key === 'sv_memo_progress') memoProgress = updater(structuredClone(memoProgress)); else Object.assign(memoState, updater(structuredClone(memoState))); };
    const prompts = [];
    const api = createSillyViewPublicAPI({ data, app: { sendMemoPrompt: async prompt => prompts.push(prompt) }, roleDecision: null, config });
    let snapshot = await api.getSnapshot();
    assert.equal(snapshot.memo_tasks[0].type, 'series');
    assert.equal(snapshot.memo_tasks[0].current_step_id, 'one');
    assert.equal(snapshot.memo_tasks[0].content, '第一阶段说明');
    assert.equal(snapshot.memo_tasks[0].series_total_required_amount, 300);
    assert.equal(snapshot.memo_tasks[0].series_remaining_required_amount, 300);
    const result = await api.completeMemoTask('series');
    assert.equal(result.status, 'step_completed');
    assert.deepEqual(prompts, ['第一步完成。']);
    snapshot = await api.getSnapshot();
    assert.equal(snapshot.memo_tasks[0].current_step_id, 'two');
    assert.equal(snapshot.memo_tasks[0].content, '第二阶段说明');
    assert.equal(snapshot.memo_tasks[0].series_total_required_amount, 300);
    assert.equal(snapshot.memo_tasks[0].series_remaining_required_amount, 200);
});

test('memo tasks enforce affection gates and prerequisite side tasks', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    let affection = 44;
    let memoProgress = null;
    let memoState = { tasks: [
        {
            id: 'affection_series', type: 'series', name: '好感系列', steps: [
                { id: 'stage_one', name: '第一阶段' },
                { id: 'stage_two', name: '第二阶段', prerequisite_task_ids: ['intimate_side'] },
            ],
        },
        {
            id: 'intimate_side', name: '亲密前置支线', unlock_affection: 45,
            unlock_affection_current: affection, complete_prompt: '前置完成。',
        },
    ] };
    data.getState = key => key === 'sv_memo_tasks'
        ? { ...structuredClone(memoState), tasks: memoState.tasks.map(task => task.id === 'intimate_side' ? { ...structuredClone(task), unlock_affection_current: affection } : structuredClone(task)) }
        : key === 'sv_memo_progress'
            ? structuredClone(memoProgress)
            : key === 'portfolio' ? { cash: 1000 } : null;
    data.updateState = async (key, updater) => {
        if (key === 'sv_memo_progress') memoProgress = updater(structuredClone(memoProgress));
        if (key === 'sv_memo_tasks') memoState = updater(structuredClone(memoState));
    };
    const api = createSillyViewPublicAPI({ data, app: { sendMemoPrompt: async () => {} }, roleDecision: null, config });

    let snapshot = await api.getSnapshot();
    assert.equal(snapshot.memo_tasks.find(task => task.id === 'intimate_side').status, 'locked');
    assert.equal((await api.completeMemoTask('intimate_side')).status, 'locked');

    affection = 45;
    assert.equal((await api.getSnapshot()).memo_tasks.find(task => task.id === 'intimate_side').status, 'active');
    await api.completeMemoTask('affection_series');
    snapshot = await api.getSnapshot();
    const lockedSeries = snapshot.memo_tasks.find(task => task.id === 'affection_series');
    assert.equal(lockedSeries.current_step_id, 'stage_two');
    assert.equal(lockedSeries.status, 'locked');
    assert.equal(lockedSeries.lock_reason, '需先完成：亲密前置支线');
    assert.equal(lockedSeries.content, '前置任务：亲密前置支线。');

    await api.completeMemoTask('intimate_side');
    snapshot = await api.getSnapshot();
    assert.equal(snapshot.memo_tasks.find(task => task.id === 'affection_series').status, 'active');
});

test('memo task prerequisites can target completed series steps and use explicit condition values', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    const memoProgress = { version: 1, entries: { 'internal::sv_memo_tasks': { tasks: {
        role_affection: { steps: { role_affection_85: { completed: true } } },
    } } } };
    data.getState = key => key === 'sv_memo_tasks' ? { tasks: [
        { id: 'role_affection', type: 'series', steps: [{ id: 'role_affection_85', name: '三阶段好感' }] },
        {
            id: 'hidden_ending', name: '隐藏结局', prerequisite_task_ids: ['role_affection_85'],
            conditions: [{ type: 'affection', current: 100, value: 100, label: '角色好感度 100' }],
        },
    ] } : key === 'sv_memo_progress' ? structuredClone(memoProgress) : null;
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });
    const task = (await api.getSnapshot()).memo_tasks.find(item => item.id === 'hidden_ending');

    assert.equal(task.status, 'active');
    assert.deepEqual(task.prerequisites, [{ id: 'role_affection_85', name: '三阶段好感', completed: true }]);
    assert.equal(task.content, '前置任务：三阶段好感。');
    assert.deepEqual(task.conditions.map(item => [item.current, item.target, item.met]), [[100, 100, true]]);
});

test('charge memo task debits and rewards the player account', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    const portfolio = { cash: 1000, debt: 0, starting_cash: 1000, assets: {}, pending_orders: [], order_history: [], transaction_log: [] };
    data.getState = key => key === 'sv_memo_tasks' ? { tasks: [{ id: 'charge', deadline: '2099-01-01 00:00', completion_mode: 'charge_and_prompt', charge_amount: 300, reward_amount: 50, complete_prompt: '扣款完成。' }] } : key === 'portfolio' ? portfolio : null;
    data.updateState = async (key, updater) => { if (key === 'portfolio') Object.assign(portfolio, updater(structuredClone(portfolio))); };
    const api = createSillyViewPublicAPI({ data, app: { sendMemoPrompt: async () => {} }, roleDecision: null, config });
    const result = await api.completeMemoTask('charge');
    assert.equal(result.ok, true);
    assert.equal(portfolio.cash, 750);
    assert.deepEqual(portfolio.transaction_log.map(item => item.amount), [50, -300]);
});

test('memo tasks support profit and trade amount conditions', async () => {
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    const portfolio = { cash: 1200, debt: 0, starting_cash: 1000, assets: {}, pending_orders: [], order_history: [{ id: 'trade', amount: 600 }] };
    data._calculatePortfolioMarkedValue = () => 1200;
    data.getState = key => key === 'sv_memo_tasks' ? { tasks: [{ id: 'conditional', deadline: '2099-01-01 00:00', conditions: [
        { type: 'profit', value: 200 },
        { type: 'single_trade_amount', value: 500 },
        { type: 'trade_count', value: 1 },
    ] }] } : key === 'portfolio' ? portfolio : null;
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });
    const task = (await api.getSnapshot()).memo_tasks[0];
    assert.equal(task.status, 'active');
    assert.deepEqual(task.conditions.map(item => [item.current, item.met]), [[200, true], [600, true], [1, true]]);
});

test('mobile AI settings merge current config and persist partial updates', async () => {
    let configState = { background_ai: { enabled: true, apiurl: 'https://example.test', key: 'secret', model: 'old' }, role_ai: { enabled: true } };
    const persisted = {};
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] });
    data.getState = key => key === 'config' ? structuredClone(configState) : createData({}).getState(key);
    data.updateState = async (_key, updater) => { configState = updater(structuredClone(configState)); };
    data.getPersistentAISettings = kind => persisted[kind] || null;
    data.persistAISettings = async (kind, settings) => { persisted[kind] = structuredClone(settings); };
    data.getChartIndicatorSettings = () => ({ average: true, ma5: false, ma10: false, ma20: false });
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });

    const saved = await api.saveAISettings({ background_ai: { model: 'new' } });
    assert.equal(saved.background_ai.apiurl, 'https://example.test');
    assert.equal(saved.background_ai.key, 'secret');
    assert.equal(saved.background_ai.model, 'new');
});

test('mobile trading snapshot exposes intraday average and moving averages', async () => {
    const candles = Array.from({ length: 20 }, (_, time) => ({ time, open: 1 + time * 0.01, high: 1.02 + time * 0.01, low: 0.99 + time * 0.01, close: 1.01 + time * 0.01, volume: time + 1 }));
    const data = createData({ current_price: 1.2, kline_minute: candles, kline_hourly: candles });
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });
    const trading = await api.getTradingSnapshot('EURUSD', 'MINUTE');
    assert.equal(trading.average.length, 20);
    assert.equal(trading.ma5.length, 16);
    assert.equal(trading.ma10.length, 11);
    assert.equal(trading.ma20.length, 1);
    assert.equal(trading.candles[0].time, 0);
    assert.deepEqual(trading.trade_limits, { available_cash: 10000, fee_rate: 0.002 });
});
