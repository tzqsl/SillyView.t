import test from 'node:test';
import assert from 'node:assert/strict';

import { SillyViewApp } from '../modules/core/app.js';
import { DataManager } from '../modules/core/dataManager.js';
import { UIRenderer } from '../modules/ui/uiRenderer.js';

const cloneDeep = value => value == null ? value : structuredClone(value);

test('AI settings are persisted in extension settings', async () => {
    let saves = 0;
    const manager = Object.create(DataManager.prototype);
    manager.config = {
        extension_name: 'SillyView',
        extension_settings_key: 'SillyView',
        background_ai_defaults: { enabled: false, model: '' },
        role_ai_defaults: { enabled: false, model: '' },
    };
    manager.dependencies = { st: {
        extensionSettings: {},
        saveSettingsDebounced: async () => { saves += 1; },
    } };
    await manager.persistAISettings('background_ai', { enabled: true, model: 'market-model' });
    await manager.persistAISettings('role_ai', { enabled: true, model: 'role-model' });
    assert.equal(manager.dependencies.st.extensionSettings.SillyView.ai_settings.background_ai.model, 'market-model');
    assert.equal(manager.dependencies.st.extensionSettings.SillyView.ai_settings.role_ai.model, 'role-model');
    assert.equal(saves, 2);
});

test('persisted AI settings are restored after reload', async () => {
    const manager = Object.create(DataManager.prototype);
    const states = new Map([['sv_config', {
        background_ai: { enabled: false, model: '' },
        role_ai: { enabled: false, model: '' },
    }]]);
    manager.config = {
        extension_name: 'SillyView',
        extension_settings_key: 'SillyView',
        world_book_keys: { config: 'sv_config' },
        background_ai_defaults: { enabled: false, model: '' },
        role_ai_defaults: { enabled: false, model: '' },
    };
    manager.dependencies = { st: {
        extensionSettings: { SillyView: { ai_settings: {
            background_ai: { enabled: true, model: 'saved-market' },
            role_ai: { enabled: true, model: 'saved-role' },
        } } },
        saveSettingsDebounced: async () => {},
    } };
    manager.getState = key => cloneDeep(states.get(key));
    manager.updateState = async (key, updater) => states.set(key, updater(cloneDeep(states.get(key))));
    assert.equal(await manager.restorePersistentAISettings(), true);
    assert.equal(states.get('sv_config').background_ai.model, 'saved-market');
    assert.equal(states.get('sv_config').role_ai.model, 'saved-role');
});

test('sv_ai_context is visible to role AI by default', () => {
    const manager = Object.create(DataManager.prototype);
    manager.config = {
        world_book_keys: {
            config: 'sv_config',
            ai_context: 'sv_ai_context',
            asset_prefix: 'sv_asset_',
        },
    };
    assert.equal(manager._isWorldbookEntryVisibleToRoleAI('sv_ai_context'), true);
    assert.equal(manager._isWorldbookEntryVisibleToRoleAI('sv_config'), false);
});

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

    assert.equal(createdLines.length, 2);
    assert.equal(createdLines[0].price, 1.02);
    assert.match(createdLines[0].title, /^强平 @/);
    assert.equal(createdLines[0].lineVisible, true);

});
test('chart renders risk, pending-order, and trailing-stop lines without leaving stale handles', () => {
    const createdLines = [];
    const removedLines = [];
    const elements = {
        'sillyview-panel': { classList: { contains: value => value === 'visible' } },
        'sillyview-data-pnl': { innerHTML: '', textContent: '' },
        'sillyview-data-pnl-details': { innerHTML: '', textContent: '' },
    };
    const portfolio = {
        assets: {
            EURUSD: {
                spot: {
                    trades: [{}],
                    risk_controls: {
                        take_profit: 1.15,
                        stop_loss: 1.05,
                        trailing_stop_pct: 1,
                        trailing_anchor: 1.1,
                    },
                },
                leveraged: {
                    trades: [{}],
                    risk_controls: {
                        take_profit: 1.1,
                        stop_loss: 1.3,
                        trailing_stop_pct: 2,
                        trailing_anchor: 1.2,
                    },
                },
            },
        },
        pending_orders: [
            { id: 'buy-limit', status: 'pending', asset_code: 'EURUSD', side: 'buy', order_type: 'limit', trigger_price: 1.06 },
            { id: 'sell-stop', status: 'pending', asset_code: 'EURUSD', side: 'sell', order_type: 'stop', trigger_price: 1.25 },
            { id: 'filled', status: 'filled', asset_code: 'EURUSD', side: 'buy', order_type: 'limit', trigger_price: 1.01 },
            { id: 'other', status: 'pending', asset_code: 'GBPUSD', side: 'buy', order_type: 'limit', trigger_price: 1.2 },
        ],
    };
    const positions = {
        spot: {
            type: 'long',
            totalAmount: 1000,
            avgEntryPrice: 1.08,
            totalShares: 1000,
            isLeveraged: false,
            liquidationPrice: 0,
        },
        leveraged: {
            type: 'short',
            totalAmount: 500,
            avgEntryPrice: 1.2,
            totalShares: 2000,
            isLeveraged: true,
            liquidationPrice: 1.31,
        },
    };
    const renderer = Object.create(UIRenderer.prototype);
    Object.assign(renderer, {
        isInitialized: true,
        parentDoc: { getElementById: id => elements[id] || null },
        data: { getState: () => portfolio },
        currentAsset: 'EURUSD',
        tradeMode: 'spot',
        avgCostLine: null,
        liquidationLine: null,
        auxiliaryPriceLines: [],
        win: { LightweightCharts: { LineStyle: { Solid: 0, Dashed: 2, Dotted: 1 } } },
        chartManager: {
            createPriceLine: options => {
                const handle = { options };
                createdLines.push(options);
                return handle;
            },
            removePriceLine: handle => removedLines.push(handle),
        },
        positionCalculator: {
            calculate: (_assetCode, _portfolio, mode) => positions[mode],
        },
    });

    renderer.updatePnlAndPriceLines(1.09);
    assert.equal(createdLines.length, 11);
    assert.deepEqual(
        new Set(createdLines.map(line => Number(line.price.toFixed(4)))),
        new Set([1.08, 1.2, 1.31, 1.15, 1.05, 1.089, 1.1, 1.3, 1.224, 1.06, 1.25]),
    );
    assert.equal(createdLines.filter(line => /\u6302\u5355/.test(line.title)).length, 2);
    assert.equal(createdLines.filter(line => /\u79fb\u52a8\u6b62\u635f/.test(line.title)).length, 2);

    renderer.updatePnlAndPriceLines(1.09);
    assert.equal(removedLines.length, 11);
    assert.equal(createdLines.length, 22);
});

test('core listeners are registered before panel HTML finishes loading', async () => {
    let resolvePanel;
    let setupCount = 0;
    let bindCount = 0;
    const app = Object.create(SillyViewApp.prototype);
    app.setupEventListeners = () => { setupCount += 1; };

    let roleMemoryInitCount = 0;
    const data = { ensureRoleDecisionMemoryEntry: async () => { roleMemoryInitCount += 1; } };
    const ui = {
        dependencies: {},
        loadPanelHtml: () => new Promise(resolve => { resolvePanel = resolve; }),
    };
    const tradeView = {};
    const events = { bindInitialEvents: () => { bindCount += 1; } };
    const logger = { log: () => {}, success: () => {} };

    app.init({
        data,
        ui,
        events,
        tradeView,
        logger,
        commandParser: {},
        aiDirector: {},
        backgroundAI: {},
        roleDecision: {},
        marketSimulator: {},
        positionCalculator: {},
        assetsView: {},
        newsView: {},
        logView: {},
        modals: {},
    });

    assert.equal(setupCount, 1);
    assert.equal(roleMemoryInitCount, 1);
    assert.equal(bindCount, 0);

    resolvePanel();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(bindCount, 1);
});

test('generation-time recovery retries until the first user message becomes readable', async () => {
    let attempts = 0;
    const context = { user_message_id: 1, user_content: '新聊天第一条消息' };
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        roleCaptureRetryDelayMs: 0,
        th: { getLastMessageId: async () => 1 },
        roleDecision: {
            captureTurnContext: () => {
                attempts += 1;
                return attempts < 3 ? null : context;
            },
        },
    });

    const recovered = await app._recoverLatestRoleTurnContext();

    assert.equal(attempts, 3);
    assert.equal(recovered, context);
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

test('regenerate and swipe replay persisted role decisions without rerunning role AI', async () => {
    for (const type of ['regenerate', 'swipe']) {
        const injected = [];
        let runCount = 0;
        const app = Object.create(SillyViewApp.prototype);
        Object.assign(app, {
            pendingRoleTurnContext: { user_message_id: 7 },
            pendingRoleKeyboardDraft: { content: 'draft' },
            roleDecision: {
                running: false,
                isEnabled: () => true,
                run: async () => { runCount += 1; },
            },
            data: {
                getRoleDecisionRunForMessage: async id => id === 7
                    ? { frontend_injection: 'persisted thoughts and outline' }
                    : null,
            },
            th: {
                getLastMessageId: async () => 8,
                getChatMessages: () => [
                    { message_id: 7, is_user: true },
                    { message_id: 8, is_user: false },
                ],
                injectPrompts: (prompts, options) => injected.push({ prompts, options }),
            },
            events: { refreshRoleDebugWindow: () => {} },
        });

        await app.prepareFrontendRoleInjection(type, {}, false);

        assert.equal(runCount, 0);
        assert.equal(injected.length, 1);
        assert.equal(injected[0].prompts[0].content, 'persisted thoughts and outline');
        assert.deepEqual(injected[0].options, { once: true });
        assert.equal(app.lastRoleDispatchStatus.status, 'replayed');
        assert.equal(app.pendingRoleTurnContext, null);
    }
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

test('user role context capture retries until the just-sent message is readable', async () => {
    let attempts = 0;
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        pendingRoleTurnContext: null,
        lastCapturedRoleMessageId: null,
        roleCaptureRetryDelayMs: 0,
        roleCaptureRetryTimers: new Map(),
        roleDecision: {
            isEnabled: () => true,
            isDebugEnabled: () => false,
            captureTurnContext: id => {
                attempts += 1;
                return attempts < 3 ? null : { user_message_id: id, user_content: '稍后可读' };
            },
        },
        events: { refreshRoleDebugWindow: () => {} },
    });

    app.captureRoleTurnForUserMessage(12);
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.equal(attempts, 3);
    assert.equal(app.pendingRoleTurnContext.user_message_id, 12);
    assert.equal(app.lastRoleDispatchStatus.status, 'queued');
});

test('refresh boundary skips historical assistant messages but accepts new replies per chat', () => {
    let chatId = 'chat-a';
    let lastMessageId = 12;
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        receivedMessageWatermarks: new Map(),
        st: { getCurrentChatId: () => chatId },
        st_context: {},
        th: { getLastMessageId: () => lastMessageId },
        logger: { log: () => {} },
    });

    app._recordCurrentChatMessageBoundary();

    assert.equal(app._shouldProcessReceivedMessage(12), false);
    assert.equal(app._shouldProcessReceivedMessage(13), true);
    assert.equal(app._shouldProcessReceivedMessage(13), false);

    chatId = 'chat-b';
    lastMessageId = 3;
    app._recordCurrentChatMessageBoundary(chatId);

    assert.equal(app._shouldProcessReceivedMessage(3), false);
    assert.equal(app._shouldProcessReceivedMessage(4), true);
});

test('records a rollback snapshot even when real-time auto advance is enabled', async () => {
    let marketAdvances = 0;
    const snapshot = new Map([['market', { minute_time_index: 10 }]]);
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        lastMinuteAdvanceMessageId: null,
        turnStateSnapshots: new Map(),
        th: { getChatMessages: () => [{ is_user: true }] },
        data: {
            ensureStateLoaded: async () => true,
            createSnapshot: () => snapshot,
            getRoleDecisionMemory: async () => ({ latest_run: { raw_output: 'before' } }),
        },
        _getAutoAdvanceSettings: () => ({ enabled: true }),
        advanceMarketMinutes: async () => { marketAdvances += 1; },
        resetAutoAdvanceTimer: () => {},
    });

    await app.advanceMinutesForUserMessage('5');

    assert.equal(app.turnStateSnapshots.get(5).state, snapshot);
    assert.equal(app.turnStateSnapshots.get(5).role_memory.latest_run.raw_output, 'before');
    assert.equal(app.lastMinuteAdvanceMessageId, 5);
    assert.equal(marketAdvances, 0);
});
test('deleting the current reply restores the market snapshot from before its user turn', async () => {
    const snapshot = new Map([['market', { minute_time_index: 30 }]]);
    let restored = null;
    let saveCount = 0;
    let renderCount = 0;
    const roleMemory = { version: 1, latest_run: { raw_output: 'old thought' } };
    let restoredRoleMemory = null;
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        previousStateSnapshot: null,
        lastMinuteAdvanceMessageId: 5,
        pendingRoleTurnContext: { user_message_id: 5 },
        lastCapturedRoleMessageId: 5,
        pendingMessageDeletionId: null,
        roleCaptureRetryTimers: new Map(),
        turnStateSnapshots: new Map([[5, { state: snapshot, role_memory: roleMemory }]]),
        th: { getLastMessageId: async () => 5 },
        data: {
            restoreStateFromSnapshot: value => { restored = value; },
            saveAllEntries: async () => { saveCount += 1; },
            restoreRoleDecisionMemory: async value => { restoredRoleMemory = value; },
        },
        ui: { renderAll: () => { renderCount += 1; } },
        roleDecision: { lastRun: { raw_output: 'deleted thought' } },
    });

    const rolledBack = await app.rollbackStateForDeletedMessage(6);

    assert.equal(rolledBack, true);
    assert.equal(restored, snapshot);
    assert.equal(saveCount, 1);
    assert.equal(renderCount, 1);
    assert.equal(restoredRoleMemory, roleMemory);
    assert.equal(app.roleDecision.lastRun.raw_output, 'old thought');
    assert.equal(app.turnStateSnapshots.has(5), false);
    assert.equal(app.pendingRoleTurnContext, null);
});

test('deleting multiple trailing messages restores the earliest affected user turn', async () => {
    const firstSnapshot = new Map([['market', { minute_time_index: 10 }]]);
    const laterSnapshot = new Map([['market', { minute_time_index: 20 }]]);
    let restored = null;
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        previousStateSnapshot: null,
        pendingMessageDeletionId: null,
        roleCaptureRetryTimers: new Map(),
        turnStateSnapshots: new Map([
            [5, { state: firstSnapshot, role_memory: null }],
            [7, { state: laterSnapshot, role_memory: null }],
        ]),
        th: { getLastMessageId: async () => 4 },
        data: {
            restoreStateFromSnapshot: value => { restored = value; },
            restoreRoleDecisionMemory: async () => {},
            saveAllEntries: async () => {},
        },
        ui: { renderAll: () => {} },
        _clearAllRoleCaptureRetries: () => {},
    });

    const rolledBack = await app.rollbackStateForDeletedMessage(8);

    assert.equal(rolledBack, true);
    assert.equal(restored, firstSnapshot);
    assert.equal(app.turnStateSnapshots.size, 0);
});

test('deleting after reload restores persisted role memory without an in-memory market snapshot', async () => {
    const oldMemory = { latest_run: { raw_output: 'persisted old thought' } };
    let cutoff = null;
    const dispatched = [];
    class SnapshotEvent {
        constructor(type, options) { this.type = type; this.detail = options.detail; }
    }
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        previousStateSnapshot: null,
        pendingMessageDeletionId: null,
        turnStateSnapshots: new Map(),
        th: {
            getLastMessageId: async () => 5,
            getChatMessages: () => [{ is_user: true }],
        },
        data: {
            restoreRoleDecisionMemoryBeforeMessage: async value => {
                cutoff = value;
                return oldMemory;
            },
        },
        roleDecision: { lastRun: { raw_output: 'deleted thought' } },
        parentWin: {
            CustomEvent: SnapshotEvent,
            dispatchEvent: event => { dispatched.push(event); },
        },
    });

    const rolledBack = await app.rollbackStateForDeletedMessage(6);

    assert.equal(rolledBack, true);
    assert.equal(cutoff, 4);
    assert.equal(app.roleDecision.lastRun.raw_output, 'persisted old thought');
    assert.equal(dispatched[0].type, 'sillyview:snapshot-updated');
});

test('plain Enter on the chat textarea starts role capture but newline shortcuts do not', async () => {
    let captureCount = 0;
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        captureRoleTurnAfterKeyboardSend: async () => { captureCount += 1; },
        logger: { warn: () => {} },
    });
    const target = { matches: selector => selector === '#send_textarea' };

    app.handleRoleSendKeydown({ key: 'Enter', target });
    app.handleRoleSendKeydown({ key: 'Enter', shiftKey: true, target });
    app.handleRoleSendKeydown({ key: 'Enter', isComposing: true, target });
    app.handleRoleSendKeydown({ key: 'a', target });
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.equal(captureCount, 1);
});

test('Enter synchronously queues the keyboard draft before generation starts', () => {
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        pendingRoleTurnContext: null,
        lastCapturedRoleMessageId: null,
        roleCaptureRetryTimers: new Map(),
        roleDecision: {
            isEnabled: () => true,
            isDebugEnabled: () => false,
            extractContent: text => String(text || '').trim(),
            lastCapture: null,
        },
        th: {
            getLastMessageId: () => 4,
            getChatMessages: () => [{ message_id: 4, role: 'assistant', message: 'Previous reply' }],
        },
        events: { refreshRoleDebugWindow: () => {} },
        logger: { warn: () => {} },
    });
    const target = { id: 'send_textarea', value: 'Keyboard message', matches: selector => selector === '#send_textarea' };

    app.handleRoleSendKeydown({ key: 'Enter', target });

    assert.equal(app.pendingRoleTurnContext?.user_message_id, 5);
    assert.equal(app.pendingRoleTurnContext?.user_content, 'Keyboard message');
    assert.equal(app.pendingRoleTurnContext?.previous_content, 'Previous reply');
    assert.equal(app.pendingRoleTurnContext?.source, 'keyboard_draft');
});
test('Enter capture retries until the new user message is persisted', async () => {
    let latestReadCount = 0;
    const accepted = [];
    const context = { user_message_id: 9, user_content: '回车发送内容' };
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        roleCaptureRetryDelayMs: 0,
        roleCaptureRetryTimers: new Map(),
        lastCapturedRoleMessageId: null,
        roleDecision: {
            isEnabled: () => true,
            isDebugEnabled: () => false,
            captureTurnContext: id => id === 9 ? context : null,
        },
        th: {
            getLastMessageId: async () => {
                latestReadCount += 1;
                return latestReadCount < 3 ? 8 : 9;
            },
        },
        events: { refreshRoleDebugWindow: () => {} },
        _acceptCapturedRoleContext: received => {
            accepted.push(received);
            return true;
        },
    });

    const captured = await app.captureRoleTurnAfterKeyboardSend();

    assert.equal(latestReadCount, 3);
    assert.equal(captured, context);
    assert.deepEqual(accepted, [context]);
});

test('K-line context keeps 8 recent minute candles and adds 20 spaced overview candles', () => {
    const manager = Object.create(DataManager.prototype);
    const minuteCandles = Array.from({ length: 205 }, (_, time) => ({
        time,
        open: 100 + time,
        high: 101 + time,
        low: 99 + time,
        close: 100.5 + time,
        volume: 10,
    }));
    const hourlyCandles = Array.from({ length: 12 }, (_, time) => ({
        time,
        open: 100 + time,
        high: 101 + time,
        low: 99 + time,
        close: 100.5 + time,
        volume: 10,
    }));

    const snapshot = manager._buildRecentKlineSnapshot('EURUSD', {
        kline_minute: minuteCandles,
        kline_hourly: hourlyCandles,
    });

    assert.equal(snapshot.m1.length, 8);
    assert.deepEqual(snapshot.m1.map(candle => candle[0]), Array.from({ length: 8 }, (_, index) => 197 + index));
    assert.equal(snapshot.m1_overview_sample_interval, 10);
    assert.equal(snapshot.m1_overview.length, 20);
    assert.deepEqual(snapshot.m1_overview, Array.from({ length: 20 }, (_, index) => 114.5 + index * 10));
    assert.equal(snapshot.m1_overview.at(-1), 304.5);
    assert.equal(snapshot.m1_trend.direction, 'up');
    assert.equal(snapshot.h1.length, 8);
});
