import test from 'node:test';
import assert from 'node:assert/strict';

import { SillyViewConfig } from '../modules/config.js';
import { DataManager } from '../modules/core/dataManager.js';
import { PositionCalculator } from '../modules/services/positionCalculator.js';

function clone(value) {
    return structuredClone(value);
}

function createManager() {
    const notifications = [];
    const win = {
        _: { cloneDeep: clone },
        toastr: {
            success: message => notifications.push(['success', message]),
            warning: message => notifications.push(['warning', message]),
            error: message => notifications.push(['error', message]),
        },
    };
    const logger = { log() {}, warn() {}, error() {}, success() {} };
    const positionCalculator = new PositionCalculator({ config: SillyViewConfig });
    const manager = new DataManager({
        win,
        th: {},
        logger,
        config: SillyViewConfig,
        positionCalculator,
    });
    manager.updateState = async function updateState(key, updateFn) {
        const current = clone(this._stateCache.get(key) || {});
        this._stateCache.set(key, updateFn(current));
    };
    manager._stateCache.set(SillyViewConfig.world_book_keys.player_portfolio, {
        cash: 10000,
        starting_cash: 10000,
        debt: 0,
        assets: {},
        actions_this_turn: [],
        transaction_log: [],
        pending_orders: [],
        order_history: [],
    });
    manager._stateCache.set(SillyViewConfig.world_book_keys.global_market, {
        current_time_index: 10,
        minute_time_index: 600,
    });
    manager._stateCache.set(`${SillyViewConfig.world_book_keys.asset_prefix}EURUSD`, {
        current_price: 1.08,
        kline_minute: [{ time: 600, open: 1.08, high: 1.08, low: 1.08, close: 1.08, volume: 1 }],
        kline_hourly: [{ time: 10, open: 1.08, high: 1.08, low: 1.08, close: 1.08, volume: 1 }],
        kline_daily: [],
    });
    return { manager, positionCalculator, notifications };
}

test('buy limit fills when the candle crosses below its trigger', async () => {
    const { manager, positionCalculator } = createManager();
    const placed = await manager.placePendingOrder({
        assetCode: 'EURUSD',
        orderType: 'limit',
        intent: 'open_long',
        mode: 'leveraged',
        amount: 1000,
        leverage: 5,
        triggerPrice: 1.05,
        riskControls: { take_profit: 1.12, stop_loss: 1.01, trailing_stop_pct: 1 },
    });
    assert.equal(placed.ok, true);

    const events = await manager.triggerPendingOrdersForCandle('EURUSD', {
        time: 11,
        open: 1.08,
        high: 1.09,
        low: 1.04,
        close: 1.06,
    });
    const portfolio = manager.getState(SillyViewConfig.world_book_keys.player_portfolio);
    assert.equal(events.length, 1);
    assert.equal(events[0].success, true);
    assert.equal(portfolio.pending_orders.length, 0);
    assert.equal(portfolio.order_history[0].status, 'filled');
    const position = positionCalculator.calculate('EURUSD', portfolio, 'leveraged');
    assert.equal(position.type, 'long');
    assert.ok(position.avgEntryPrice <= 1.05);
});

test('OCO fill cancels its sibling order', async () => {
    const { manager } = createManager();
    const common = {
        assetCode: 'EURUSD',
        intent: 'open_long',
        mode: 'leveraged',
        amount: 500,
        leverage: 2,
    };
    const placed = await manager.placeOcoOrders([
        { ...common, orderType: 'limit', triggerPrice: 1.05 },
        { ...common, orderType: 'stop', triggerPrice: 1.10 },
    ]);
    assert.equal(placed.ok, true);

    await manager.triggerPendingOrdersForCandle('EURUSD', {
        time: 11,
        open: 1.08,
        high: 1.11,
        low: 1.07,
        close: 1.10,
    });
    const portfolio = manager.getState(SillyViewConfig.world_book_keys.player_portfolio);
    assert.equal(portfolio.pending_orders.length, 0);
    assert.deepEqual(new Set(portfolio.order_history.map(order => order.status)), new Set(['filled', 'cancelled']));
    assert.equal(portfolio.order_history.find(order => order.status === 'cancelled').cancel_reason, 'oco_peer_filled');
});

test('trailing stop follows a favorable extreme and triggers on reversal', () => {
    const { manager } = createManager();
    const position = { type: 'long', avgEntryPrice: 1 };
    const controls = { trailing_stop_pct: 1, trailing_anchor: 1 };

    const advanced = manager._evaluateTrailingStop({ open: 1, high: 1.02, low: 1, close: 1.02 }, position, controls);
    assert.equal(advanced.triggered, false);
    assert.equal(advanced.anchor, 1.02);

    const reversed = manager._evaluateTrailingStop({ open: 1.02, high: 1.05, low: 1.03, close: 1.03 }, position, {
        ...controls,
        trailing_anchor: advanced.anchor,
    });
    assert.equal(reversed.triggered, true);
    assert.ok(Math.abs(reversed.price - 1.0395) < 1e-10);
});

test('trailing stop trigger closes the position and records realized cash flow', async () => {
    const { manager, positionCalculator } = createManager();
    manager._stateCache.set(SillyViewConfig.world_book_keys.player_portfolio, {
        cash: 9000,
        starting_cash: 10000,
        debt: 0,
        assets: {
            EURUSD: {
                spot: { trades: [] },
                leveraged: {
                    trades: [{ time: 10, price: 1, amount: 1000, type: 'long', leverage: 5 }],
                    risk_controls: { take_profit: null, stop_loss: null, trailing_stop_pct: 1, trailing_anchor: 1.02 },
                },
            },
        },
        actions_this_turn: [],
        transaction_log: [],
        pending_orders: [],
        order_history: [],
    });

    const result = await manager.triggerRiskControlsForCandle('EURUSD', {
        time: 11,
        open: 1.02,
        high: 1.05,
        low: 1.03,
        close: 1.03,
    });
    const portfolio = manager.getState(SillyViewConfig.world_book_keys.player_portfolio);
    assert.equal(result.triggerType, 'trailing_stop');
    assert.equal(positionCalculator.calculate('EURUSD', portfolio, 'leveraged').type, null);
    assert.ok(portfolio.cash > 10000);
    assert.ok(portfolio.transaction_log.some(log => log.description.includes('移动止损平仓')));
});
