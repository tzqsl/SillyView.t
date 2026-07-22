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

function createData(asset) {
    const states = {
        portfolio: { cash: 10000, debt: 0, starting_cash: 10000, assets: {} },
        market: { current_datetime: 'test' },
        asset_EURUSD: asset,
    };
    return {
        config,
        positionCalculator: { calculateAll: () => ({}) },
        getState: key => structuredClone(states[key] || null),
        getManagedAccountStates: async () => [],
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
    assert.equal(snapshot.api_version, '2.1.1');
    assert.equal(snapshot.market.assets[0].change_pct, 3.4826);
});
