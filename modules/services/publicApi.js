/**
 * Read-only bridge for TavernHelper frontends.
 * The UI can consume snapshots without reaching into SillyView internals.
 */
'use strict';

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function calculateAssetChangePct(asset = {}) {
    const currentPrice = finiteNumber(asset.current_price);
    if (currentPrice <= 0) return 0;

    const hourly = (Array.isArray(asset.kline_hourly) ? asset.kline_hourly : [])
        .filter(candle => finiteNumber(candle?.close) > 0)
        .sort((a, b) => finiteNumber(a.time) - finiteNumber(b.time));
    if (hourly.length === 0) return 0;

    const latestTime = finiteNumber(hourly[hourly.length - 1]?.time);
    const targetTime = latestTime - 24;
    const baseline = [...hourly].reverse().find(candle => finiteNumber(candle.time) <= targetTime) || hourly[0];
    const baselinePrice = finiteNumber(baseline?.close || baseline?.open);
    if (baselinePrice <= 0) return 0;
    return Number((((currentPrice / baselinePrice) - 1) * 100).toFixed(4));
}

function normalizeCandle(candle = {}) {
    return {
        time: finiteNumber(candle.time),
        open: finiteNumber(candle.open),
        high: finiteNumber(candle.high),
        low: finiteNumber(candle.low),
        close: finiteNumber(candle.close),
        volume: finiteNumber(candle.volume),
    };
}

function movingAverage(candles, period) {
    const source = candles.map(normalizeCandle).filter(item => Number.isFinite(item.time) && item.close > 0);
    return source.flatMap((item, index) => {
        if (index + 1 < period) return [];
        const window = source.slice(index + 1 - period, index + 1);
        return [{ time: item.time, value: window.reduce((sum, entry) => sum + entry.close, 0) / period }];
    });
}

function intradayAverage(candles) {
    let totalVolume = 0;
    let totalValue = 0;
    return candles.map(normalizeCandle).filter(item => Number.isFinite(item.time) && item.close > 0).map(item => {
        const volume = item.volume > 0 ? item.volume : 1;
        totalVolume += volume;
        totalValue += item.close * volume;
        return { time: item.time, value: totalValue / totalVolume };
    });
}

function parseRoleOutput(rawText = '') {
    const text = String(rawText || '');
    const roleMap = new Map();
    const add = (role, field, content) => {
        const name = String(role || '').trim();
        const value = String(content || '').trim();
        if (!name || !value) return;
        const item = roleMap.get(name) || { role_name: name, thought: '', outline: '' };
        item[field] = value;
        roleMap.set(name, item);
    };

    for (const match of text.matchAll(/<role_thought\b[^>]*\brole=["']([^"']+)["'][^>]*>([\s\S]*?)<\/role_thought>/gi)) {
        add(match[1], 'thought', match[2]);
    }
    for (const match of text.matchAll(/<role_outline\b[^>]*\brole=["']([^"']+)["'][^>]*>([\s\S]*?)<\/role_outline>/gi)) {
        add(match[1], 'outline', match[2]);
    }
    return [...roleMap.values()];
}

function buildPositionSnapshot(data, assetCode, mode, position) {
    const asset = data.getState(`${data.config.world_book_keys.asset_prefix}${assetCode}`) || {};
    const currentPrice = finiteNumber(asset.current_price);
    const unrealizedPnl = position.type === 'short'
        ? (position.avgEntryPrice - currentPrice) * position.totalShares
        : (currentPrice - position.avgEntryPrice) * position.totalShares;
    const riskControls = data.getState(data.config.world_book_keys.player_portfolio)?.assets?.[assetCode]?.[mode]?.risk_controls || {};
    return {
        asset_code: assetCode,
        asset_name: data.config.asset_definitions?.[assetCode]?.name || assetCode,
        mode,
        side: position.type,
        amount: finiteNumber(position.totalAmount),
        position_value: finiteNumber(position.positionValue),
        shares: finiteNumber(position.totalShares),
        leverage: finiteNumber(position.leverage, 1),
        entry_price: finiteNumber(position.avgEntryPrice),
        current_price: currentPrice,
        unrealized_pnl: finiteNumber(unrealizedPnl),
        liquidation_price: finiteNumber(position.liquidationPrice),
        take_profit: riskControls.take_profit == null ? null : finiteNumber(riskControls.take_profit),
        stop_loss: riskControls.stop_loss == null ? null : finiteNumber(riskControls.stop_loss),
        trailing_stop_pct: riskControls.trailing_stop_pct == null ? null : finiteNumber(riskControls.trailing_stop_pct),
        trailing_anchor: riskControls.trailing_anchor == null ? null : finiteNumber(riskControls.trailing_anchor),
    };
}

function buildOrderSnapshot(order) {
    return {
        id: String(order?.id || ''),
        asset_code: String(order?.asset_code || ''),
        order_type: String(order?.order_type || ''),
        side: String(order?.side || ''),
        intent: String(order?.intent || ''),
        mode: String(order?.mode || ''),
        amount: finiteNumber(order?.amount),
        leverage: finiteNumber(order?.leverage, 1),
        trigger_price: finiteNumber(order?.trigger_price),
        oco_group_id: order?.oco_group_id ? String(order.oco_group_id) : null,
        status: String(order?.status || 'pending'),
        created_at: finiteNumber(order?.created_at),
        completed_at: finiteNumber(order?.completed_at),
    };
}

function buildAccountSnapshot(data, state) {
    const portfolio = state.portfolio || {};
    const positions = [];
    let positionEquity = 0;
    let unrealizedPnl = 0;
    for (const assetCode of Object.keys(portfolio.assets || {})) {
        const calculated = data.positionCalculator.calculateAll(assetCode, portfolio);
        for (const [mode, position] of Object.entries(calculated)) {
            if (!position?.type || finiteNumber(position.totalAmount) <= 0) continue;
            const snapshot = buildPositionSnapshot(data, assetCode, mode, position);
            positions.push(snapshot);
            positionEquity += snapshot.amount + snapshot.unrealized_pnl;
            unrealizedPnl += snapshot.unrealized_pnl;
        }
    }
    const cash = finiteNumber(portfolio.cash);
    const debt = finiteNumber(portfolio.debt);
    const netWorth = cash + positionEquity - debt;
    const startingNetWorth = finiteNumber(portfolio.starting_cash) - debt;
    return {
        account_id: state.account_id,
        owner_name: state.owner_name || '未知角色',
        bank_name: state.bank_name || '未知开户行',
        cash,
        debt,
        net_worth: netWorth,
        unrealized_pnl: unrealizedPnl,
        total_pnl: netWorth - startingNetWorth,
        positions,
        pending_orders: (portfolio.pending_orders || []).map(buildOrderSnapshot),
        recent_order_history: (portfolio.order_history || []).slice(0, 20).map(buildOrderSnapshot),
        recent_events: (state.recent_major_events || []).slice(-8).reverse().map(event => ({
            id: event.id,
            datetime: event.datetime,
            type: event.type,
            asset_code: event.asset_code,
            content: event.content,
            observed: Boolean(event.observed),
        })),
        updated_at: state.updated_at || 0,
    };
}

function buildPortfolioSnapshot(data, config) {
    const portfolio = data.getState(config.world_book_keys.player_portfolio) || {};
    const totalAssets = finiteNumber(data._calculatePortfolioMarkedValue?.(portfolio));
    const startingCash = finiteNumber(portfolio.starting_cash);
    return {
        cash: finiteNumber(portfolio.cash),
        debt: finiteNumber(portfolio.debt),
        starting_cash: startingCash,
        total_assets: totalAssets,
        total_pnl: totalAssets - startingCash,
        pending_orders: (portfolio.pending_orders || []).map(buildOrderSnapshot),
        recent_order_history: (portfolio.order_history || []).slice(0, 20).map(buildOrderSnapshot),
        updated_at: portfolio.updated_at || 0,
    };
}

function buildNewsSnapshot(data, config, activeOnly = false) {
    const items = activeOnly ? data.getActiveMarketNews() : data.getArchivedNews();
    return items.map(item => ({
        id: String(item.id || ''),
        headline: String(item.headline || ''),
        asset_code: String(item.asset_code || 'GLOBAL'),
        created_at: finiteNumber(item.created_at),
        expires_at: finiteNumber(item.expires_at),
        duration_hours: finiteNumber(item.duration_hours),
    }));
}

function normalizeMemoTasks(data, config, accounts, market) {
    const raw = ['sv_memo_tasks', 'memo_tasks', 'SillyView_memo_tasks']
        .map(key => data.getState(key))
        .find(value => Array.isArray(value) || Array.isArray(value?.tasks)) || null;
    const source = Array.isArray(raw) ? raw : (Array.isArray(raw?.tasks) ? raw.tasks : []);
    const now = parseMemoDate(market.current_datetime) || Date.now();
    return source.map((task, index) => {
        const required = finiteNumber(task.required_amount ?? task.required_cash ?? task.amount);
        const requestedAccountId = String(task.account_id || '').trim();
        const usePlayerAccount = !requestedAccountId || ['player', 'user', 'default', 'optional_account_id'].includes(requestedAccountId.toLowerCase());
        const account = usePlayerAccount ? null : accounts.find(item => item.account_id === requestedAccountId);
        const playerPortfolio = data.getState(config.world_book_keys.player_portfolio) || {};
        const balance = account ? account.cash : finiteNumber(playerPortfolio.cash);
        const deadline = parseMemoDate(task.deadline ?? task.deadline_at);
        const remainingMs = Number.isFinite(deadline) ? deadline - now : Infinity;
        const completed = Boolean(task.completed || task.status === 'completed');
        let status = completed ? 'completed' : 'active';
        if (!completed && Number.isFinite(deadline) && remainingMs < 0) status = 'failed';
        else if (!completed && balance <= required) status = 'insufficient';
        return {
            id: String(task.id || `memo_${index + 1}`),
            name: String(task.name || task.title || `任务 ${index + 1}`),
            content: String(task.content || task.description || ''),
            deadline: String(task.deadline || task.deadline_at || ''),
            deadline_at: Number.isFinite(deadline) ? deadline : null,
            remaining_ms: Number.isFinite(remainingMs) ? remainingMs : null,
            remaining_label: Number.isFinite(remainingMs)
                ? (remainingMs < 0 ? '已超时' : `${Math.floor(remainingMs / 86400000)}天 ${Math.floor((remainingMs % 86400000) / 3600000)}小时`)
                : '未设置截止时间',
            required_amount: required,
            current_balance: balance,
            remaining_amount: Math.max(0, required - balance),
            account_id: account?.account_id || null,
            status,
            complete_prompt: String(task.complete_prompt || task.success_prompt || ''),
            failed_prompt: String(task.failed_prompt || task.failure_prompt || ''),
        };
    });
}

function parseMemoDate(value) {
    const raw = String(value || '').trim();
    if (!raw) return NaN;
    const normalized = raw
        .replace(/[\u5e74\/]/g, '-')
        .replace(/\u6708/g, '-')
        .replace(/\u65e5/g, '')
        .replace(/\u661f\u671f[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u65e5\u5929]/g, '')
        .replace(/-+/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(\d{4}-\d{1,2}-\d{1,2})-(\d{1,2}:\d{2})$/, '$1 $2');
    const timestamp = Date.parse(normalized);
    return Number.isFinite(timestamp) ? timestamp : Date.parse(raw);
}

async function resolveMemoSource(data) {
    const keys = ['sv_memo_tasks', 'memo_tasks', 'SillyView_memo_tasks'];
    for (const key of keys) {
        const value = data.getState(key);
        if (Array.isArray(value) || Array.isArray(value?.tasks)) return { key, value, external: false };
    }
    const helper = data.th;
    if (!helper?.getCharWorldbookNames || !helper?.getWorldbook) return { key: 'sv_memo_tasks', value: null, external: false };
    const books = await helper.getCharWorldbookNames('current');
    for (const book of [books?.primary, ...(books?.additional || [])].filter(Boolean)) {
        const entries = await helper.getWorldbook(book);
        const entry = (entries || []).find(item => keys.includes(String(item.name || item.comment || '').trim()));
        if (!entry) continue;
        let value = entry.content;
        try { value = JSON.parse(String(value).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim()); } catch { /* leave invalid content for empty-state handling */ }
        if (Array.isArray(value) || Array.isArray(value?.tasks)) return { key: entry.name || entry.comment, value, external: true, book };
    }
    return { key: 'sv_memo_tasks', value: null, external: false };
}

export function createSillyViewPublicAPI({ data, app = null, roleDecision, config, togglePanel = null }) {
    const api = {
        version: '2.7.0',
        readonly: false,
        async togglePanel() {
            if (typeof togglePanel !== 'function') return { visible: false, error: 'panel_unavailable' };
            return togglePanel();
        },
        async getSnapshot() {
            const states = await data.getManagedAccountStates();
            const profiles = await data.getManagedRoleProfiles();
            const roleMemory = await data.getRoleDecisionMemory();
            const roleRun = roleMemory?.latest_run || null;
            const market = data.getState(config.world_book_keys.global_market) || {};
            const assets = Object.keys(config.asset_definitions || {}).map(assetCode => {
                const asset = data.getState(`${config.world_book_keys.asset_prefix}${assetCode}`) || {};
                return {
                    code: assetCode,
                    name: config.asset_definitions[assetCode]?.name || assetCode,
                    price: finiteNumber(asset.current_price),
                    change_pct: calculateAssetChangePct(asset),
                };
            });
            const snapshot = {
                api_version: api.version,
                generated_at: Date.now(),
                portfolio: buildPortfolioSnapshot(data, config),
                market: {
                    datetime: market.current_datetime || '',
                    period: market.current_period || '',
                    season: market.current_season || '',
                    weather: market.current_weather || '',
                    assets,
                },
                roles: parseRoleOutput(roleRun?.raw_output || ''),
                role_profiles: profiles.map(profile => ({ entry_name: profile.entry_name })),
                role_status: {
                    enabled: Boolean(roleDecision?.isEnabled?.()),
                    running: Boolean(roleDecision?.running),
                    completed_at: roleRun?.completed_at || 0,
                    status: roleRun?.status || 'idle',
                    source: 'worldbook',
                    worldbook_name: config.multi_account.control_worldbook_name,
                    entry_name: config.multi_account.role_memory_key,
                },
                accounts: states.map(state => buildAccountSnapshot(data, state)),
                news: buildNewsSnapshot(data, config),
            };
            const memoSource = await resolveMemoSource(data);
            snapshot.memo_tasks = normalizeMemoTasks({ ...data, getState: key => key === 'sv_memo_tasks' ? memoSource.value : data.getState(key) }, config, snapshot.accounts, market);
            return snapshot;
        },
        async getPortfolio() {
            return buildPortfolioSnapshot(data, config);
        },
        async getMarket() {
            const snapshot = await api.getSnapshot();
            return snapshot.market;
        },
        async getRoles() {
            const snapshot = await api.getSnapshot();
            return snapshot.roles;
        },
        async getAccounts() {
            const snapshot = await api.getSnapshot();
            return snapshot.accounts;
        },
        async getNews(options = {}) {
            return buildNewsSnapshot(data, config, options.activeOnly === true);
        },
        async completeMemoTask(taskId) {
            const states = await data.getManagedAccountStates();
            const accounts = states.map(state => buildAccountSnapshot(data, state));
            const market = data.getState(config.world_book_keys.global_market) || {};
            const tasks = normalizeMemoTasks(data, config, accounts, market);
            const task = tasks.find(item => item.id === String(taskId));
            if (!task) return { ok: false, status: 'missing', message: '任务不存在。' };
            if (task.status === 'completed') return { ok: false, status: 'completed', message: '任务已经完成。' };
            if (task.status === 'failed') return { ok: false, status: 'failed', prompt: task.failed_prompt, message: '任务已超出截止时间。' };
            if (task.status === 'insufficient') return { ok: false, status: 'insufficient', prompt: task.failed_prompt, message: '当前余额未达到任务要求。' };

            const memoKey = ['sv_memo_tasks', 'memo_tasks', 'SillyView_memo_tasks']
                .find(key => { const value = data.getState(key); return Array.isArray(value) || Array.isArray(value?.tasks); }) || 'sv_memo_tasks';
            const source = await resolveMemoSource(data);
            const raw = source.value || [];
            const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.tasks) ? raw.tasks : []);
            const updated = list.map((item, index) => String(item.id || `memo_${index + 1}`) === task.id
                ? { ...item, completed: true, status: 'completed', completed_at: Date.now() }
                : item);
            if (source.external && data.th?.updateWorldbookWith) {
                await data.th.updateWorldbookWith(source.book, entries => entries.map(entry => (String(entry.name || entry.comment || '').trim() === memoKey ? { ...entry, content: JSON.stringify(Array.isArray(source.value) ? updated : { ...(source.value || {}), tasks: updated }, null, 2) } : entry)));
            } else await data.updateState(memoKey, current => Array.isArray(current)
                ? updated
                : { ...(current || {}), tasks: updated });
            if (task.complete_prompt && app?.sendMemoPrompt) await app.sendMemoPrompt(task.complete_prompt);
            return { ok: true, status: 'completed', prompt: task.complete_prompt, message: '任务已完成。' };
        },
        async getOrders(options = {}) {
            const portfolio = data.getState(config.world_book_keys.player_portfolio) || {};
            const pending = (portfolio.pending_orders || []).map(buildOrderSnapshot);
            if (options.includeHistory !== true) return { pending };
            return {
                pending,
                history: (portfolio.order_history || []).slice(0, 50).map(buildOrderSnapshot),
            };
        },
        async getTradingSnapshot(assetCode, timeframe = 'MINUTE') {
            const code = String(assetCode || Object.keys(config.asset_definitions || {})[0] || '');
            const asset = data.getState(`${config.world_book_keys.asset_prefix}${code}`) || {};
            const candles = timeframe === 'DAILY'
                ? (asset.kline_daily || [])
                : timeframe === 'HOURLY' ? (asset.kline_hourly || []) : (asset.kline_minute || []);
            const portfolio = data.getState(config.world_book_keys.player_portfolio) || {};
            const feeRate = finiteNumber(config.asset_definitions?.[code]?.trade_config?.fee_rate, 0.001);
            return {
                asset: {
                    code,
                    name: config.asset_definitions?.[code]?.name || code,
                    current_price: finiteNumber(asset.current_price),
                    change_pct: calculateAssetChangePct(asset),
                },
                timeframe,
                candles: candles.map(normalizeCandle),
                average: intradayAverage(candles),
                ma5: movingAverage(candles, 5),
                ma10: movingAverage(candles, 10),
                ma20: movingAverage(candles, 20),
                trade_limits: {
                    available_cash: finiteNumber(portfolio.cash),
                    fee_rate: feeRate,
                },
                positions: Object.entries(data.positionCalculator.calculateAll(code, portfolio))
                    .filter(([, position]) => position?.type)
                    .map(([mode, position]) => buildPositionSnapshot(data, code, mode, position)),
                orders: (portfolio.pending_orders || []).filter(order => order.asset_code === code).map(buildOrderSnapshot),
            };
        },
        async executeTrade(params = {}) {
            if (!app?.executeTrade) return false;
            await app.executeTrade(params.action, params.amount, params.assetCode, params.executionPrice, params.leverage, params.riskControls, params.mode);
            return true;
        },
        async placePendingOrder(params = {}) { return app?.placePendingOrder?.(params) ?? false; },
        async placeOcoOrders(specs = []) { return app?.placeOcoOrders?.(specs) ?? false; },
        async cancelPendingOrder(orderId) { return app?.cancelPendingOrder?.(orderId) ?? false; },
        async commitAndAdvance() {
            if (!app?.commitAndAdvance) return { ok: false, error: 'turn_advance_unavailable' };
            try {
                const advanced = await app.commitAndAdvance({ source: 'mobile' });
                if (advanced === false) return { ok: false, error: 'turn_advance_busy' };
                return { ok: true };
            } catch (error) {
                return { ok: false, error: error?.message || String(error) };
            }
        },
        async updatePositionRisk(params = {}) {
            const result = await data.updatePositionRiskControls?.(params.assetCode, params.riskControls || {}, params.mode || 'leveraged');
            if (!result) return false;
            await data.updateAIContext?.();
            await data.saveAllEntries?.();
            return true;
        },
        async getAISettings() {
            const configState = data.getState(config.world_book_keys.config) || {};
            const persistentBackground = data.getPersistentAISettings?.('background_ai') || {};
            const persistentRole = data.getPersistentAISettings?.('role_ai') || {};
            return {
                background_ai: { ...(configState.background_ai || {}), ...persistentBackground },
                role_ai: { ...(configState.role_ai || {}), ...persistentRole },
                chart_indicators: data.getChartIndicatorSettings?.() || { average: true, ma5: false, ma10: false, ma20: false },
            };
        },
        async saveAISettings(settings = {}) {
            if (settings.background_ai || settings.role_ai) {
                await data.updateState(config.world_book_keys.config, current => ({
                    ...(current || {}),
                    ...(settings.background_ai ? { background_ai: { ...((current || {}).background_ai || {}), ...settings.background_ai } } : {}),
                    ...(settings.role_ai ? { role_ai: { ...((current || {}).role_ai || {}), ...settings.role_ai } } : {}),
                }));
            }
            if (settings.background_ai) await data.persistAISettings('background_ai', data.getState(config.world_book_keys.config)?.background_ai || settings.background_ai);
            if (settings.role_ai) await data.persistAISettings('role_ai', data.getState(config.world_book_keys.config)?.role_ai || settings.role_ai);
            if (settings.chart_indicators) await data.persistChartIndicatorSettings?.(settings.chart_indicators);
            return api.getAISettings();
        },
    };
    return Object.freeze(api);
}
