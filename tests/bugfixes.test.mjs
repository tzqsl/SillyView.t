import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { SillyViewApp } from '../modules/core/app.js';
import { DataManager } from '../modules/core/dataManager.js';
import { RoleDecisionService } from '../modules/services/roleDecisionService.js';
import { UIRenderer } from '../modules/ui/uiRenderer.js';
import { ChartManager } from '../modules/ui/chartManager.js';

const cloneDeep = value => value == null ? value : structuredClone(value);

test('worldbook player initialization command normalizes safe account and market fields', () => {
    const warnings = [];
    const manager = Object.create(DataManager.prototype);
    manager.config = {
        multi_account: { player_init_command: 'SillyView.InitPlayer' },
        asset_definitions: { EURUSD: {}, BTCUSD: {} },
    };
    manager.logger = { warn: message => warnings.push(message) };

    const result = manager._extractPlayerInitializationFromEntry({
        name: '玩家初始账户',
        content: `[SillyView.InitPlayer({
          "初始资金": "250万",
          "初始负债": 50000,
          "基准资金": 2600000,
          "初始时间": "2025年09月23日-星期二-09:00",
          "时段": "上午",
          "季节": "秋季",
          "天气": "晴",
          "自动推进": true,
          "快速模式": true,
          "可用资产": ["EURUSD", "UNKNOWN", "BTCUSD"]
        })]`,
    }, '角色世界书');

    assert.equal(result.cash, 2500000);
    assert.equal(result.starting_cash, 2600000);
    assert.equal(result.debt, 50000);
    assert.equal(result.quick_mode, true);
    assert.equal(result.auto_advance, true);
    assert.deepEqual(result.available_assets, ['EURUSD', 'BTCUSD']);
    assert.deepEqual(result.market, {
        current_datetime: '2025年09月23日-星期二-09:00',
        current_period: '上午',
        current_season: '秋季',
        current_weather: '晴',
    });
    assert.deepEqual(warnings, []);
});

test('worldbook player initialization rejects negative balances', () => {
    const warnings = [];
    const manager = Object.create(DataManager.prototype);
    manager.config = { multi_account: {}, asset_definitions: {} };
    manager.logger = { warn: message => warnings.push(message) };
    const result = manager._extractPlayerInitializationFromEntry({
        name: 'bad init',
        content: '[SillyView.InitPlayer({"cash":-1,"debt":0})]',
    }, '角色世界书');
    assert.equal(result, null);
    assert.equal(warnings.length, 1);
});

test('player initialization scan includes the current SillyView worldbook', async () => {
    const manager = Object.create(DataManager.prototype);
    manager.config = {
        multi_account: { player_init_command: 'SillyView.InitPlayer' },
        asset_definitions: {},
    };
    manager.logger = { warn: () => {} };
    manager._getBankAccountScanTargets = async () => ({ targets: ['attached-book'] });
    manager._getLorebookName = async () => 'current-sillyview-book';
    manager.th = {
        getWorldbook: async name => name === 'current-sillyview-book'
            ? [{ name: 'sv_config', content: '[SillyView.InitPlayer({"cash":12345,})]' }]
            : [],
    };
    const result = await manager.scanBoundPlayerInitialization();
    assert.equal(result.cash, 12345);
});

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

test('AI and chart settings use the current SillyTavern context store', async () => {
    let saves = 0;
    const extensionSettings = {};
    const manager = Object.create(DataManager.prototype);
    manager.config = {
        extension_name: 'SillyView',
        extension_settings_key: 'SillyView',
        background_ai_defaults: { enabled: false, model: '' },
        role_ai_defaults: { enabled: false, model: '' },
    };
    manager.dependencies = {
        st: { getContext: () => ({ extensionSettings, saveSettingsDebounced: async () => { saves += 1; } }) },
        win: { CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }, dispatchEvent: () => {} },
    };
    await manager.persistAISettings('background_ai', { enabled: true, model: 'context-model' });
    await manager.persistChartIndicatorSettings({ ma5: true, ma10: true });
    assert.equal(extensionSettings.SillyView.ai_settings.background_ai.model, 'context-model');
    assert.deepEqual(manager.getChartIndicatorSettings(), { average: true, ma5: true, ma10: true, ma20: false });
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

test('chart indicator settings keep average enabled and persist only boolean MA flags', async () => {
    const dispatched = [];
    const manager = Object.create(DataManager.prototype);
    manager.config = { extension_name: 'SillyView', extension_settings_key: 'SillyView' };
    manager.dependencies = {
        st: { extensionSettings: {}, saveSettingsDebounced: async () => {} },
        win: {
            CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
            dispatchEvent: event => dispatched.push(event),
        },
    };

    assert.deepEqual(manager.getChartIndicatorSettings(), { average: true, ma5: false, ma10: false, ma20: false });
    const saved = await manager.persistChartIndicatorSettings({ average: false, ma5: true, ma10: 'true', unknown: true });
    assert.deepEqual(saved, { average: true, ma5: true, ma10: false, ma20: false });
    assert.equal(dispatched[0].type, 'sillyview:chart-indicators-updated');
    assert.deepEqual(dispatched[0].detail.settings, saved);
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
    assert.equal(roleMemoryInitCount, 0);
    assert.equal(bindCount, 0);

    resolvePanel();
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(bindCount, 1);
});

test('initial state loading is single-flight', async () => {
    let resolveLoad;
    let loadCount = 0;
    const data = Object.create(DataManager.prototype);
    data.initialStateLoadPromise = null;
    data._loadInitialState = () => {
        loadCount += 1;
        return new Promise(resolve => { resolveLoad = resolve; });
    };

    const first = data.loadInitialState();
    const second = data.loadInitialState();

    assert.equal(first, second);
    assert.equal(loadCount, 1);
    resolveLoad(true);
    await first;
    assert.equal(data.initialStateLoadPromise, null);
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
    const managedAccounts = [{ account_id: 'fx-main', cash: 10000, positions: [] }];
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        lastMinuteAdvanceMessageId: null,
        turnStateSnapshots: new Map(),
        th: { getChatMessages: () => [{ is_user: true }] },
        data: {
            ensureStateLoaded: async () => true,
            createSnapshot: () => snapshot,
            getRoleDecisionMemory: async () => ({ latest_run: { raw_output: 'before' } }),
            getManagedAccountStates: async () => managedAccounts,
        },
        _getAutoAdvanceSettings: () => ({ enabled: true }),
        advanceMarketMinutes: async () => { marketAdvances += 1; },
        resetAutoAdvanceTimer: () => {},
    });

    await app.advanceMinutesForUserMessage('5');

    assert.equal(app.turnStateSnapshots.get(5).state, snapshot);
    assert.equal(app.turnStateSnapshots.get(5).role_memory.latest_run.raw_output, 'before');
    assert.equal(app.turnStateSnapshots.get(5).managed_accounts, managedAccounts);
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

test('deleting restores role memory when snapshots use the real object state shape', async () => {
    const state = { cache: { market: { minute_time_index: 10 } } };
    const roleMemory = { latest_run: { raw_output: 'before delete' } };
    let restoredState = null;
    let restoredMemory = null;
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        previousStateSnapshot: null,
        pendingMessageDeletionId: null,
        roleCaptureRetryTimers: new Map(),
        turnStateSnapshots: new Map([[3, { state, role_memory: roleMemory }]]),
        th: { getLastMessageId: async () => 3 },
        data: {
            restoreStateFromSnapshot: value => { restoredState = value; },
            restoreRoleDecisionMemory: async value => { restoredMemory = value; },
            saveAllEntries: async () => {},
        },
        ui: { renderAll: () => {} },
        _clearAllRoleCaptureRetries: () => {},
        roleDecision: { lastRun: null },
    });

    assert.equal(await app.rollbackStateForDeletedMessage(4), true);
    assert.equal(restoredState, state);
    assert.equal(restoredMemory, roleMemory);
    assert.equal(app.roleDecision.lastRun.raw_output, 'before delete');
});

test('deleting restores managed role account states stored outside the main cache', async () => {
    const accountState = {
        account_id: 'fx-main',
        cash: 7350,
        positions: { TEST: { quantity: 120, average_price: 12.45 } },
        risk_controls: { take_profit: 14, stop_loss: 11.2 },
        pending_orders: [{ side: 'sell', symbol: 'TEST', quantity: 20 }],
    };
    const state = { cache: { market: { minute_time_index: 10 } } };
    let restoredState = null;
    let restoredAccounts = null;
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        previousStateSnapshot: null,
        pendingMessageDeletionId: null,
        roleCaptureRetryTimers: new Map(),
        turnStateSnapshots: new Map([[3, { state, role_memory: null, managed_accounts: [accountState] }]]),
        th: { getLastMessageId: async () => 3 },
        data: {
            restoreStateFromSnapshot: value => { restoredState = value; },
            restoreManagedAccountStates: async value => { restoredAccounts = value; },
            saveAllEntries: async () => {},
        },
        ui: { renderAll: () => {} },
        _clearAllRoleCaptureRetries: () => {},
    });

    assert.equal(await app.rollbackStateForDeletedMessage(4), true);
    assert.equal(restoredState, state);
    assert.deepEqual(restoredAccounts, [accountState]);
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
    let accountCutoff = null;
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
            getChatMessages: async () => [{ role: 'user' }],
        },
        data: {
            restoreManagedAccountStatesBeforeMessage: async value => { accountCutoff = value; },
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
    assert.equal(accountCutoff, 4);
    assert.equal(app.roleDecision.lastRun.raw_output, 'persisted old thought');
    assert.equal(dispatched[0].type, 'sillyview:snapshot-updated');
});

test('deletion waits for SillyTavern to publish the new last message id', async () => {
    const observedLastIds = [6, 6, 5];
    let restored = false;
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        previousStateSnapshot: null,
        pendingMessageDeletionId: null,
        turnStateSnapshots: new Map(),
        th: {
            getLastMessageId: async () => observedLastIds.shift() ?? 5,
            getChatMessages: () => [{ role: 'user' }],
        },
        data: {
            restoreManagedAccountStatesBeforeMessage: async () => {},
            restoreRoleDecisionMemoryBeforeMessage: async () => {
                restored = true;
                return { latest_run: null };
            },
        },
    });

    assert.equal(await app.rollbackStateForDeletedMessage(6), true);
    assert.equal(restored, true);
});

test('persisted role history restores the earliest account snapshot after a deletion cutoff', async () => {
    const beforeFirst = [{ account_id: 'fx-a', cash: 10000, positions: [] }];
    const beforeSecond = [{ account_id: 'fx-a', cash: 8000, positions: [{ asset_code: 'EURUSD' }] }];
    let restored = null;
    const manager = Object.create(DataManager.prototype);
    Object.assign(manager, {
        getRoleDecisionMemory: async () => ({
            history: [
                { context: { user_message_id: 3 }, managed_accounts_before: beforeFirst },
                { context: { user_message_id: 5 }, managed_accounts_before: beforeSecond },
            ],
        }),
        restoreManagedAccountStates: async states => { restored = states; },
    });

    assert.equal(await manager.restoreManagedAccountStatesBeforeMessage(2), true);
    assert.equal(restored, beforeFirst);
});

test('persisted account and event snapshots restore the deleted assistant turn', async () => {
    const before = [{
        account_id: 'fx-a',
        portfolio: { cash: 10000, assets: {} },
        recent_major_events: [{ id: 'old', content: 'before' }],
    }];
    const after = [{
        account_id: 'fx-a',
        portfolio: { cash: 8000, assets: { EURUSD: { leveraged: { trades: [{ amount: 100 }] } } } },
        recent_major_events: [{ id: 'old', content: 'before' }, { id: 'new', content: 'trade' }],
    }];
    let restored = null;
    const manager = Object.create(DataManager.prototype);
    Object.assign(manager, {
        getRoleDecisionMemory: async () => ({
            history: [{ context: { user_message_id: 7 }, managed_accounts_before: before }, { context: { user_message_id: 9 }, managed_accounts_before: after }],
        }),
        restoreManagedAccountStates: async states => { restored = states; },
    });

    assert.equal(await manager.restoreManagedAccountStatesBeforeMessage(7), true);
    assert.deepEqual(restored, before);
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

test('generate compatibility hook chains with another interceptor without duplicate role processing', async () => {
    const calls = [];
    const originalGenerate = async options => { calls.push(['original', options.prompt]); return 'ok'; };
    const otherPluginWrapper = async function (options) {
        calls.push(['other', options.prompt]);
        return originalGenerate(options);
    };
    const host = { TavernHelper: { generate: otherPluginWrapper } };
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        parentWin: host,
        dependencies: { win: host },
        pendingRoleTurnContext: null,
        roleDecision: { isEnabled: () => true },
        captureRoleTurnFromKeyboardDraft: content => { calls.push(['capture', content]); app.pendingRoleTurnContext = { user_content: content }; },
        prepareFrontendRoleInjection: async (_type, options) => { calls.push(['role', options.prompt]); app.pendingRoleTurnContext = null; },
    });

    app._installGenerateCompatibilityHook();
    const options = { prompt: 'shared interception' };
    const result = await host.TavernHelper.generate(options);

    assert.equal(result, 'ok');
    assert.deepEqual(calls, [
        ['capture', 'shared interception'],
        ['role', 'shared interception'],
        ['other', 'shared interception'],
        ['original', 'shared interception'],
    ]);
    assert.equal(options.__sillyview_role_processed, true);
});

test('generate compatibility hook runs after the ACU interceptor', async () => {
    const calls = [];
    const host = {};
    const originalGenerate = async () => { calls.push('original'); return 'ok'; };
    host.original_TavernHelper_generate_ACU = originalGenerate;
    host.TavernHelper = {
        generate: async function (options) {
            calls.push('other plugin');
            return host.original_TavernHelper_generate_ACU(options);
        },
    };
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        parentWin: host,
        dependencies: { win: host },
        pendingRoleTurnContext: null,
        roleDecision: { isEnabled: () => true },
        captureRoleTurnFromKeyboardDraft: () => { calls.push('capture'); app.pendingRoleTurnContext = {}; },
        prepareFrontendRoleInjection: async () => { calls.push('role decision'); },
    });

    app._installGenerateCompatibilityHook();
    await host.TavernHelper.generate({ prompt: 'click send' });

    assert.deepEqual(calls, ['other plugin', 'capture', 'role decision', 'original']);
});

test('send button pointer capture records the draft and shows the waiting stage', () => {
    const messages = [];
    const input = { value: 'button message' };
    const app = Object.create(SillyViewApp.prototype);
    Object.assign(app, {
        lastRoleSendIntentAt: 0,
        roleDecision: { isEnabled: () => true, isDebugEnabled: () => false },
        dependencies: { parentDoc: { querySelector: () => input }, win: { toastr: { info: message => { messages.push(message); return {}; }, clear: () => {} } } },
        captureRoleTurnFromKeyboardDraft: content => ({ user_content: content }),
    });

    app.handleRoleSendButton({ target: { closest: selector => selector === '#send_but' ? {} : null } });

    assert.equal(app.pendingRoleKeyboardDraft.content, 'button message');
    assert.match(messages[0], /等待其余插件处理完毕/);
});

test('role decision enabled state includes persistent mobile settings', () => {
    const service = Object.create(RoleDecisionService.prototype);
    service.config = { world_book_keys: { config: 'config' }, role_ai_defaults: { enabled: false } };
    service.data = {
        getState: () => ({ role_ai: { enabled: false } }),
        getPersistentAISettings: key => key === 'role_ai' ? { enabled: true } : {},
    };

    assert.equal(service.isEnabled(), true);
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
test('stale missing worldbook bindings are removed before adding SillyView accounts', async () => {
    const rebinds = [];
    const data = Object.create(DataManager.prototype);
    data.th = {
        getCharWorldbookNames: async () => ({
            primary: 'FX战士久留美',
            additional: ['SillyView_fx'],
        }),
        getWorldbookNames: async () => ['FX战士久留美', 'SillyView_accounts'],
        rebindCharWorldbooks: async (target, binding) => rebinds.push({ target, binding }),
    };

    await data._ensureAdditionalWorldbook('SillyView_accounts');

    assert.deepEqual(rebinds, [{
        target: 'current',
        binding: { primary: 'FX战士久留美', additional: ['SillyView_accounts'] },
    }]);
});
test('managed account worldbooks are isolated by character identity', async () => {
    const sharedConfig = { multi_account: { control_worldbook_name: 'SillyView_accounts' } };
    let current = { characterId: 5, characters: { 5: { avatar: 'fx.png' } } };
    let characterName = 'FX';
    const manager = Object.create(DataManager.prototype);
    Object.assign(manager, {
        config: sharedConfig,
        dependencies: { win: { SillyTavern: { getContext: () => current } } },
        th: { substitudeMacros: async () => characterName },
        activeManagedObservationSession: { id: 'old-session' },
        managedCharacterScope: null,
    });

    const fxScope = await manager.prepareCharacterScope();
    assert.match(fxScope.controlName, /^SillyView_accounts_FX_/);
    assert.equal(sharedConfig.multi_account.control_worldbook_name, fxScope.controlName);
    assert.equal(manager.activeManagedObservationSession, null);

    characterName = 'Another Role';
    current = { characterId: 8, characters: { 8: { avatar: 'another.png' } } };
    const otherScope = await manager.prepareCharacterScope();
    assert.match(otherScope.controlName, /^SillyView_accounts_Another_Role_/);
    assert.notEqual(otherScope.controlName, fxScope.controlName);
    assert.equal(sharedConfig.multi_account.control_worldbook_name, otherScope.controlName);
});

test('same-name character cards use different managed account worldbooks', async () => {
    const config = { multi_account: { control_worldbook_name: 'SillyView_accounts' } };
    let avatar = 'first.png';
    const manager = Object.create(DataManager.prototype);
    Object.assign(manager, {
        config,
        dependencies: { win: { SillyTavern: { getContext: () => ({ characterId: 1, characters: { 1: { avatar } } }) } } },
        th: { substitudeMacros: async () => 'Duplicate Name' },
        managedCharacterScope: null,
    });

    const first = await manager.prepareCharacterScope();
    avatar = 'second.png';
    const second = await manager.prepareCharacterScope();
    assert.notEqual(first.controlName, second.controlName);
});

test('persistent background AI settings are readable before world creation', () => {
    const manager = Object.create(DataManager.prototype);
    manager.config = { extension_settings_key: 'SillyView', extension_name: 'SillyView' };
    manager.dependencies = {
        st: { extensionSettings: { SillyView: { ai_settings: { background_ai: { enabled: true, model: 'bootstrap-model' } } } } },
        win: { _: { cloneDeep: value => structuredClone(value) } },
    };

    assert.deepEqual(manager.getPersistentAISettings('background_ai'), {
        enabled: true,
        model: 'bootstrap-model',
    });
    assert.equal(manager.getPersistentAISettings('role_ai'), null);
});

test('creation UI includes the background model fields used by settings', async () => {
    const source = await readFile(new URL('../modules/ui/uiRenderer.js', import.meta.url), 'utf8');
    for (const id of [
        'sv-bg-ai-enabled',
        'sv-bg-ai-source',
        'sv-bg-ai-apiurl',
        'sv-bg-ai-key',
        'sv-bg-ai-model',
        'sv-bg-ai-temperature',
        'sv-bg-ai-max-tokens',
    ]) {
        assert.match(source, new RegExp(`id=["']${id}["']`));
    }
});
test('creation UI explains background model fallback and later reconfiguration', async () => {
    const source = await readFile(new URL('../modules/ui/uiRenderer.js', import.meta.url), 'utf8');
    assert.match(source, /未启用或未配置自定义模型时，初始化及后续市场生成将使用酒馆当前选择的模型/);
    assert.match(source, /用于本次初始化的首次后台市场生成/);
    assert.match(source, /可随时在 SillyView 设置中的“后台市场模型”重新配置/);
});

test('mobile panel toggle uses the initialized parent document', async () => {
    const source = await readFile(new URL('../script.js', import.meta.url), 'utf8');
    assert.match(source, /parentWin\.document\.getElementById\('sillyview-entry-button'\)/);
    assert.match(source, /parentWin\.document\.getElementById\('sillyview-panel'\)/);
    assert.doesNotMatch(source, /const entryButton = parentDoc\./);
});

test('loan operations adjust cash once while still recording transactions', async () => {
    const state = { cash: 10000, debt: 0, transaction_log: [] };
    const manager = Object.create(DataManager.prototype);
    manager.config = { world_book_keys: { player_portfolio: 'portfolio', global_market: 'market' } };
    manager.dependencies = { win: { toastr: { success() {}, info() {}, warning() {}, error() {} } } };
    manager.getState = key => key === 'portfolio' ? state : { current_time_index: 3 };
    manager.updateState = async (_key, updater) => updater(state);

    await manager.takeLoan(500);
    assert.deepEqual({ cash: state.cash, debt: state.debt }, { cash: 10500, debt: 500 });
    await manager.repayLoan(200);
    assert.deepEqual({ cash: state.cash, debt: state.debt }, { cash: 10300, debt: 300 });
    await manager.grantLoanByAI(100, 'test');
    assert.deepEqual({ cash: state.cash, debt: state.debt }, { cash: 10400, debt: 400 });
    await manager.forceRepayLoanByAI(50, 'test');
    assert.deepEqual({ cash: state.cash, debt: state.debt }, { cash: 10350, debt: 350 });
    assert.deepEqual(state.transaction_log.map(entry => entry.amount), [-50, 100, -200, 500]);
});

test('pending-order risk controls are validated against the trigger price', async () => {
    const errors = [];
    const triggerInput = { value: '1.05' };
    const renderer = Object.create(UIRenderer.prototype);
    Object.assign(renderer, {
        isAnimating: false,
        isSubmittingTrade: false,
        tradeMode: 'leverage',
        orderMode: 'limit',
        currentAsset: 'EURUSD',
        selectedLeverage: 5,
        parentDoc: { getElementById: id => ({
            'sillyview-trade-amount': { value: '500' },
            'sillyview-leverage-slider': { value: '5' },
            'sillyview-order-trigger-price': triggerInput,
        }[id] || null) },
        win: { toastr: { error: message => errors.push(message), info() {} } },
        data: { getState: key => key.includes('asset_')
            ? { current_price: 1.08, kline_minute: [], kline_hourly: [{ close: 1.08 }] }
            : { assets: {} } },
        positionCalculator: { calculate: () => ({ type: 'long', totalAmount: 1000 }) },
        _getKlineDataForTimeframe: asset => asset.kline_hourly,
        _readRiskControls: (_action, referencePrice) => referencePrice === 1.05 ? { stop_loss: 1.01 } : undefined,
        app: { placePendingOrder: async spec => { renderer.placed = spec; return true; } },
    });

    await renderer.initiateTrade('buy');

    assert.equal(renderer.placed.triggerPrice, 1.05);
    assert.equal(renderer.placed.riskControls.stop_loss, 1.01);
    assert.deepEqual(errors, []);
});

test('trade submission lock prevents overlap and is released after failure', async () => {
    const errors = [];
    const renderer = Object.create(UIRenderer.prototype);
    renderer.win = { toastr: { error: message => errors.push(message) } };
    let release;
    const pending = renderer._submitTradeOperation(() => new Promise(resolve => { release = resolve; }));
    assert.equal(renderer.isSubmittingTrade, true);
    release(true);
    assert.equal(await pending, true);
    assert.equal(renderer.isSubmittingTrade, false);

    assert.equal(await renderer._submitTradeOperation(async () => { throw new Error('save failed'); }), false);
    assert.equal(renderer.isSubmittingTrade, false);
    assert.deepEqual(errors, ['save failed']);
});

test('quick mode advances the formatted world time across day and season boundaries', async () => {
    const market = {
        current_datetime: '2026年08月31日-星期一-23:30',
        current_period: '晚上',
        current_season: '夏季',
    };
    const app = Object.create(SillyViewApp.prototype);
    app.data = {
        updateState: async (_key, updater) => updater(market),
    };

    assert.equal(await app._advanceWorldTimeByMinutes(90), true);
    assert.equal(market.current_datetime, '2026年09月01日-星期二-01:00');
    assert.equal(market.current_period, '凌晨');
    assert.equal(market.current_season, '秋季');
});

test('long-target expiry prompt receives the elapsed quick-mode duration', async () => {
    const appSource = await readFile(new URL('../modules/core/app.js', import.meta.url), 'utf8');
    const directorSource = await readFile(new URL('../modules/services/aiDirector.js', import.meta.url), 'utf8');

    assert.match(appSource, /elapsedHours:\s*hoursToAdvance/);
    assert.match(directorSource, /时间过去了\$\{displayHours\}小时/);
    assert.match(appSource, /async advanceQuickModeMinutes\(minutes = 5\)[\s\S]*?advanceWorldTime: true/);
});

test('header separates available cash from total assets without subtracting debt', () => {
    const elements = {
        'sillyview-available-assets': { textContent: '' },
        'sillyview-total-assets': { textContent: '' },
        'sillyview-cumulative-assets': { textContent: '', style: {} },
    };
    const renderer = Object.create(UIRenderer.prototype);
    renderer.data = { getState: () => ({ cash: 15000, debt: 50000 }) };
    renderer.assetsView = { calculateTotalAssetValue: () => 8000 };
    renderer.parentDoc = { getElementById: id => elements[id] || null };

    renderer.renderTotalAssets();

    assert.equal(elements['sillyview-available-assets'].textContent, '15000.00');
    assert.equal(elements['sillyview-total-assets'].textContent, '23000.00');
    assert.equal(elements['sillyview-cumulative-assets'].textContent, '-35000.00');
    assert.equal(elements['sillyview-cumulative-assets'].style.color, 'var(--red-400)');
});

test('switching assets restores automatic price scaling after manual axis adjustment', () => {
    const calls = [];
    const renderer = Object.create(UIRenderer.prototype);
    Object.assign(renderer, {
        currentAsset: 'EURUSD',
        avgCostLine: null,
        liquidationLine: null,
        auxiliaryPriceLines: [],
        chartManager: {
            removePriceLine: () => {},
            resetPriceScale: () => calls.push('reset'),
        },
        renderAll: () => calls.push('render'),
    });

    renderer.switchAsset('USDJPY');

    assert.equal(renderer.currentAsset, 'USDJPY');
    assert.deepEqual(calls, ['render', 'reset']);
});

test('chart maps internal candle indexes to real timestamps instead of 1970', () => {
    const manager = Object.create(ChartManager.prototype);
    manager.setTimeContext(Date.UTC(2025, 8, 23, 9, 0, 0) / 1000, 3600);
    const timestamp = manager.toChartTime(24);
    assert.equal(new Date(timestamp * 1000).getUTCFullYear(), 2025);
    assert.equal(manager.fromChartTime(timestamp), 24);
});
