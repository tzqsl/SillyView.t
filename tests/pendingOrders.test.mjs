import test from 'node:test';
import assert from 'node:assert/strict';

import { SillyViewConfig } from '../modules/config.js';
import { DataManager } from '../modules/core/dataManager.js';
import { CommandParser } from '../modules/core/commandParser.js';
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

function attachManagedAccount(manager, portfolioOverrides = {}) {
    let state = {
        version: 3,
        account_id: 'acct_role',
        owner_name: '测试角色',
        bank_name: '测试银行',
        state_entry_name: 'sv_account_state_acct_role',
        portfolio: {
            cash: 10000,
            starting_cash: 10000,
            debt: 0,
            assets: {},
            actions_this_turn: [],
            transaction_log: [],
            pending_orders: [],
            order_history: [],
            ...portfolioOverrides,
        },
        recent_major_events: [],
    };
    manager._getManagedAccountStateById = async accountId => accountId === state.account_id ? clone(state) : null;
    manager.getManagedAccountStates = async () => [clone(state)];
    manager._writeManagedAccountState = async nextState => { state = clone(nextState); };
    manager.syncManagedAccountsWorldbook = async () => {};
    return () => clone(state);
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

test('role commands create and cancel a managed account limit order', async () => {
    const { manager } = createManager();
    const getManagedState = attachManagedAccount(manager);
    const placed = await manager.processManagedAccountTradeCommand({
        module: 'Trade',
        type: 'PlaceLimit',
        args: ['acct_role', 'EURUSD', 'buy', 'leveraged', 1000, 5, 1.05, 1.12, 1.01, 1],
    });
    assert.equal(placed, true);
    const order = getManagedState().portfolio.pending_orders[0];
    assert.equal(order.order_type, 'limit');
    assert.equal(order.risk_controls.trailing_stop_pct, 1);

    const cancelled = await manager.processManagedAccountTradeCommand({
        module: 'Trade',
        type: 'CancelOrder',
        args: ['acct_role', order.id],
    });
    const portfolio = getManagedState().portfolio;
    assert.equal(cancelled, true);
    assert.equal(portfolio.pending_orders.length, 0);
    assert.equal(portfolio.order_history[0].status, 'cancelled');
});

test('role command parser preserves side and mode arguments for pending orders', () => {
    const parser = new CommandParser();
    const commands = parser.parse('<command>[Trade.PlaceStop("acct_role", "EURUSD", "sell", "spot", 500, 1, 1.05, 1.01, 1.08, 0.5)]</command>');
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, 'PlaceStop');
    assert.equal(commands[0].args[2], 'sell');
    assert.equal(commands[0].args[3], 'spot');
    assert.equal(commands[0].args[9], 0.5);
});

test('role command guide advertises pending orders and trailing stops', () => {
    const { manager } = createManager();
    const guide = manager._buildManagedTradeCommandGuide([{
        account_id: 'acct_role',
        owner_name: '测试角色',
        bank_name: '测试银行',
    }]);
    for (const command of ['Trade.PlaceLimit', 'Trade.PlaceStop', 'Trade.PlaceOCO', 'Trade.CancelOrder']) {
        assert.match(guide, new RegExp(command.replace('.', '\\.')));
    }
    assert.match(guide, /trailing_stop_pct/);
    assert.match(guide, /不得编造订单编号/);
});

test('triggered managed order is archived when execution validation rejects it', async () => {
    const { manager } = createManager();
    const getManagedState = attachManagedAccount(manager, { cash: 100 });
    const placed = await manager.processManagedAccountTradeCommand({
        module: 'Trade',
        type: 'PlaceStop',
        args: ['acct_role', 'EURUSD', 'buy', 'leveraged', 1000, 5, 1.10, 1.15, 1.05, 0],
    });
    assert.equal(placed, true);

    const result = await manager.processManagedAccountPendingOrdersForCandle('EURUSD', {
        time: 11,
        open: 1.08,
        high: 1.11,
        low: 1.07,
        close: 1.10,
    });
    const state = getManagedState();
    assert.equal(result.events[0].success, false);
    assert.equal(state.portfolio.pending_orders.length, 0);
    assert.equal(state.portfolio.order_history[0].status, 'rejected');
    assert.equal(state.portfolio.order_history[0].reject_reason, 'execution_failed');
    assert.equal(state.recent_major_events.at(-1).type, 'pending_order_rejected');
});

test('role OCO command fills one managed order and cancels its peer', async () => {
    const { manager, positionCalculator } = createManager();
    const getManagedState = attachManagedAccount(manager);
    const placed = await manager.processManagedAccountTradeCommand({
        module: 'Trade',
        type: 'PlaceOCO',
        args: ['acct_role', 'EURUSD', 'buy', 'leveraged', 750, 3, 1.05, 1.10, 1.15, 1.01, 1],
    });
    assert.equal(placed, true);

    const result = await manager.processManagedAccountPendingOrdersForCandle('EURUSD', {
        time: 11,
        open: 1.08,
        high: 1.11,
        low: 1.07,
        close: 1.10,
    });
    const portfolio = getManagedState().portfolio;
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].success, true);
    assert.equal(portfolio.pending_orders.length, 0);
    assert.deepEqual(new Set(portfolio.order_history.map(order => order.status)), new Set(['filled', 'cancelled']));
    assert.equal(positionCalculator.calculate('EURUSD', portfolio, 'leveraged').type, 'long');
});

test('role SetRisk command applies a managed trailing stop that can close the position', async () => {
    const { manager, positionCalculator } = createManager();
    const getManagedState = attachManagedAccount(manager, {
        cash: 9000,
        assets: {
            EURUSD: {
                spot: { trades: [] },
                leveraged: { trades: [{ time: 10, price: 1, amount: 1000, type: 'long', leverage: 5 }] },
            },
        },
    });
    const updated = await manager.processManagedAccountTradeCommand({
        module: 'Trade',
        type: 'SetRisk',
        args: ['acct_role', 'EURUSD', 0, 0, 1],
    });
    assert.equal(updated, true);
    assert.equal(getManagedState().portfolio.assets.EURUSD.leveraged.risk_controls.trailing_stop_pct, 1);

    const result = await manager.processManagedAccountRiskForCandle('EURUSD', {
        time: 11,
        open: 1.08,
        high: 1.10,
        low: 1.08,
        close: 1.085,
    });
    const portfolio = getManagedState().portfolio;
    assert.equal(result.events[0].type, 'trailing_stop');
    assert.equal(positionCalculator.calculate('EURUSD', portfolio, 'leveraged').type, null);
});
