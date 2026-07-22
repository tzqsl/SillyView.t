import test from 'node:test';
import assert from 'node:assert/strict';

import { createSillyViewPublicAPI } from '../modules/services/publicApi.js';

const config = {
    world_book_keys: {
        player_portfolio: 'portfolio',
        global_market: 'market',
        asset_prefix: 'asset_',
    },
    asset_definitions: {
        EURUSD: { name: '欧元/美元' },
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
    assert.equal(snapshot.api_version, '2.2.0');
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
