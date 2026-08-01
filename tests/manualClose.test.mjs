import test from 'node:test';
import assert from 'node:assert/strict';

import { AssetsView } from '../modules/ui/assetsView.js';
import { EventHandler } from '../modules/ui/eventHandler.js';

function position(overrides = {}) {
    return {
        type: 'long',
        totalAmount: 1000,
        avgEntryPrice: 1.1,
        totalShares: 1000,
        leverage: 5,
        ...overrides,
    };
}

test('position cards render a manual close button', () => {
    const view = Object.create(AssetsView.prototype);
    Object.assign(view, {
        data: {
            getState: () => ({ current_price: 1.12 }),
        },
        positionCalculator: {
            calculateAll: () => ({
                spot: position(),
                leveraged: position({ type: null, totalAmount: 0 }),
            }),
        },
    });

    const html = view.renderPositions({
        assets: {
            EURUSD: {
                spot: { risk_controls: {} },
            },
        },
    });

    assert.match(html, /class="sv-button sv-button-red sv-position-close"/);
    assert.match(html, /data-asset-code="EURUSD"/);
    assert.match(html, /data-position-mode="spot"/);
    assert.match(html, />平仓<\/button>/);
});

for (const scenario of [
    { name: 'spot holding', mode: 'spot', side: 'long', action: 'spot_sell' },
    { name: 'leveraged long', mode: 'leveraged', side: 'long', action: 'close_long' },
    { name: 'leveraged short', mode: 'leveraged', side: 'short', action: 'close_short' },
]) {
    test(`manual close maps ${scenario.name} to ${scenario.action}`, async () => {
        const calls = [];
        let confirmationMessage = '';
        const heldPosition = position({ type: scenario.side });
        const handler = Object.create(EventHandler.prototype);
        Object.assign(handler, {
            dependencies: {
                config: {
                    world_book_keys: {
                        player_portfolio: 'portfolio',
                        asset_prefix: 'asset_',
                    },
                },
                win: {
                    toastr: {
                        warning: () => assert.fail('unexpected warning'),
                        error: () => assert.fail('unexpected error'),
                    },
                },
            },
            data: {
                getState: key => key === 'portfolio'
                    ? { assets: { EURUSD: {} } }
                    : { current_price: 1.12 },
            },
            positionCalculator: {
                calculate: (_assetCode, _portfolio, mode) => {
                    assert.equal(mode, scenario.mode);
                    return heldPosition;
                },
            },
            ui: { renderAll: () => {} },
            app: {
                executeTrade: (...args) => {
                    calls.push(args);
                    return Promise.resolve();
                },
            },
            modals: {
                showConfirmation: (message, onConfirm) => {
                    confirmationMessage = message;
                    onConfirm();
                },
            },
        });

        handler.closePosition('EURUSD', { dataset: { positionMode: scenario.mode } });
        await Promise.resolve();

        assert.match(confirmationMessage, /确认平仓/);
        assert.match(confirmationMessage, /1\.1200/);
        assert.deepEqual(calls, [[
            scenario.action,
            1000,
            'EURUSD',
            1.12,
            5,
            null,
            scenario.mode,
        ]]);
    });
}