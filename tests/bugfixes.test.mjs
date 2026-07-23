import test from 'node:test';
import assert from 'node:assert/strict';

import { SillyViewApp } from '../modules/core/app.js';
import { UIRenderer } from '../modules/ui/uiRenderer.js';

test('liquidation line is rendered while the trade panel is in spot mode', () => {
    const createdLines = [];
    const elements = {
        'sillyview-panel': { classList: { contains: value => value === 'visible' } },
        'sillyview-data-pnl': { innerHTML: '', textContent: '' },
        'sillyview-data-pnl-details': { innerHTML: '', textContent: '' },
    };
    const renderer = Object.create(UIRenderer.prototype);
    Object.assign(renderer, {
        isInitialized: true,
        parentDoc: { getElementById: id => elements[id] || null },
        data: { getState: () => ({ assets: {} }) },
        currentAsset: 'EURUSD',
        tradeMode: 'spot',
        avgCostLine: null,
        liquidationLine: null,
        win: { LightweightCharts: { LineStyle: { Dashed: 2, Dotted: 1 } } },
        chartManager: {
            createPriceLine: options => {
                createdLines.push(options);
                return options;
            },
            removePriceLine: () => {},
        },
        positionCalculator: {
            calculate: (_assetCode, _portfolio, mode) => mode === 'leveraged'
                ? {
                    type: 'long',
                    totalAmount: 1000,
                    avgEntryPrice: 1.1,
                    totalShares: 10000,
                    isLeveraged: true,
                    liquidationPrice: 1.02,
                }
                : {
                    type: null,
                    totalAmount: 0,
                    avgEntryPrice: 0,
                    totalShares: 0,
                    isLeveraged: false,
                    liquidationPrice: 0,
                },
        },
    });

    renderer.updatePnlAndPriceLines(1.08);

    assert.equal(createdLines.length, 1);
    assert.equal(createdLines[0].price, 1.02);
    assert.match(createdLines[0].title, /^强平 @/);
    assert.equal(createdLines[0].lineVisible, true);
});

test('frontend role injection recovers the latest user context when capture event was missed', async () => {
    const injected = [];
    const context = { user_message_id: 7, user_content: '测试输入' };
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        pendingRoleTurnContext: null,
        roleDecision: {
            running: false,
            isEnabled: () => true,
            captureTurnContext: id => id === 7 ? context : null,
            run: async received => ({
                frontend_injection: `角色决策:${received.user_content}`,
            }),
        },
        th: {
            getLastMessageId: async () => 7,
            injectPrompts: (prompts, options) => injected.push({ prompts, options }),
        },
        logger: { warn: () => {}, success: () => {}, error: () => {} },
        dependencies: { win: { toastr: {} } },
        events: { refreshRoleDebugWindow: () => {} },
    });

    await app.prepareFrontendRoleInjection('normal', {}, false);

    assert.equal(injected.length, 1);
    assert.equal(injected[0].prompts[0].content, '角色决策:测试输入');
    assert.deepEqual(injected[0].options, { once: true });
    assert.equal(app.lastRoleDispatchStatus.status, 'injected');
});

test('role generation does not recursively recover and dispatch itself', async () => {
    let latestMessageReads = 0;
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        pendingRoleTurnContext: null,
        roleDecision: { running: true, isEnabled: () => true },
        th: { getLastMessageId: async () => { latestMessageReads += 1; return 7; } },
    });

    await app.prepareFrontendRoleInjection('normal', {}, false);

    assert.equal(latestMessageReads, 0);
});
