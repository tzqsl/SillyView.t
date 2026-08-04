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
    assert.equal(snapshot.api_version, '2.6.0');
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
    const api = createSillyViewPublicAPI({
        data,
        roleDecision: null,
        config,
        togglePanel: async () => ({ visible: true }),
    });

    assert.equal(api.version, '2.6.0');
    assert.equal(api.readonly, false);
    assert.deepEqual(await api.togglePanel(), { visible: true });
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
