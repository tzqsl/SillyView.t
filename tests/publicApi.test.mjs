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
    assert.equal(snapshot.api_version, '2.7.0');
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

    assert.equal(api.version, '2.7.0');
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

    const result = await api.completeMemoTask('rent');
    assert.equal(result.ok, true);
    assert.equal(memoState.tasks[0].completed, true);
    assert.deepEqual(prompts, ['房租任务已经完成。']);
});

test('mobile memo task is disabled when balance is not above required amount', async () => {
    const managedStates = [{
        account_id: 'acct_role',
        owner_name: '测试角色',
        portfolio: { cash: 5000, debt: 0, starting_cash: 5000, assets: {}, pending_orders: [], order_history: [] },
    }];
    const data = createData({ current_price: 1.08, kline_hourly: [{ time: 0, close: 1.08 }] }, managedStates);
    const originalGetState = data.getState;
    data.getState = key => key === 'sv_memo_tasks'
        ? { tasks: [{ id: 'equal', deadline: '2099-01-01 00:00', required_amount: 5000, account_id: 'acct_role' }] }
        : originalGetState(key);
    const api = createSillyViewPublicAPI({ data, roleDecision: null, config });

    const snapshot = await api.getSnapshot();
    assert.equal(snapshot.memo_tasks[0].status, 'insufficient');
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
