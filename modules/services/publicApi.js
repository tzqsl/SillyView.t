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

const MEMO_PROGRESS_ENTRY = 'sv_memo_progress';

function normalizeCompletionMode(task = {}) {
    return String(task.completion_mode || task.mode || 'prompt').toLowerCase() === 'charge_and_prompt'
        ? 'charge_and_prompt'
        : 'prompt';
}

function compareMemoCondition(current, operator, target) {
    if (operator === 'gt') return current > target;
    if (operator === 'lte') return current <= target;
    if (operator === 'lt') return current < target;
    if (operator === 'eq') return current === target;
    return current >= target;
}

function evaluateMemoConditions(data, config, account, task) {
    const source = account || buildPortfolioSnapshot(data, config);
    const portfolio = account
        ? (data.getManagedAccountStates ? null : {})
        : (data.getState(config.world_book_keys.player_portfolio) || {});
    const history = account?.recent_order_history || portfolio.order_history || source.recent_order_history || [];
    const positions = account?.positions || [];
    const metrics = {
        balance: finiteNumber(source.cash),
        cash: finiteNumber(source.cash),
        total_assets: finiteNumber(source.total_assets ?? source.net_worth),
        net_worth: finiteNumber(source.net_worth ?? source.total_assets),
        total_pnl: finiteNumber(source.total_pnl),
        profit: Math.max(0, finiteNumber(source.total_pnl)),
        loss: Math.max(0, -finiteNumber(source.total_pnl)),
        single_trade_amount: history.reduce((max, order) => Math.max(max, Math.abs(finiteNumber(order.amount))), 0),
        total_trade_amount: history.reduce((sum, order) => sum + Math.abs(finiteNumber(order.amount)), 0),
        trade_count: history.length,
        max_position_amount: positions.reduce((max, position) => Math.max(max, Math.abs(finiteNumber(position.amount))), 0),
        debt: finiteNumber(source.debt),
    };
    const labels = {
        balance: '现金余额', cash: '现金余额', total_assets: '总资产', net_worth: '账户净值', total_pnl: '累计盈亏',
        profit: '累计盈利', loss: '累计亏损', single_trade_amount: '单笔最大成交额', total_trade_amount: '累计成交额',
        trade_count: '成交次数', max_position_amount: '最大持仓金额', debt: '负债',
    };
    const raw = Array.isArray(task.conditions) ? task.conditions : (Array.isArray(task.requirements) ? task.requirements : []);
    return raw.map(condition => {
        const type = String(condition.type || condition.metric || '').trim();
        const operator = String(condition.operator || condition.op || 'gte').toLowerCase();
        const target = finiteNumber(condition.value ?? condition.target ?? condition.amount);
        const current = finiteNumber(metrics[type]);
        return { type, operator, target, current, met: type in metrics && compareMemoCondition(current, operator, target), label: String(condition.label || labels[type] || type) };
    });
}

function normalizeSingleMemoTask(data, config, accounts, market, task, index, runtime = {}) {
    const required = finiteNumber(task.required_amount ?? task.required_cash ?? task.amount);
    const chargeAmount = Math.max(0, finiteNumber(task.charge_amount));
    const rewardAmount = Math.max(0, finiteNumber(task.reward_amount ?? task.reward));
    const requestedAccountId = String(task.account_id || '').trim();
    const usePlayerAccount = !requestedAccountId || ['player', 'user', 'default', 'optional_account_id'].includes(requestedAccountId.toLowerCase());
    const account = usePlayerAccount ? null : accounts.find(item => item.account_id === requestedAccountId);
    const playerPortfolio = data.getState(config.world_book_keys.player_portfolio) || {};
    const balance = account ? account.cash : finiteNumber(playerPortfolio.cash);
    const conditions = evaluateMemoConditions(data, config, account, task);
    const deadline = parseMemoDate(task.deadline ?? task.deadline_at);
    const now = parseMemoDate(market.current_datetime) || Date.now();
    const remainingMs = Number.isFinite(deadline) ? deadline - now : Infinity;
    const completed = Boolean(runtime.completed || task.completed || task.status === 'completed' || Number.isFinite(Number(task.completed_at)));
    const failed = Boolean(runtime.failed || task.status === 'failed');
    let status = completed ? 'completed' : failed ? 'failed' : 'active';
    if (!completed && !failed && Number.isFinite(deadline) && remainingMs < 0) status = 'failed';
    else if (!completed && !failed && required > 0 && balance <= required) status = 'insufficient';
    else if (!completed && !failed && normalizeCompletionMode(task) === 'charge_and_prompt' && balance < chargeAmount) status = 'insufficient';
    else if (!completed && !failed && conditions.some(condition => !condition.met)) status = 'insufficient';
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
        charge_amount: chargeAmount,
        reward_amount: rewardAmount,
        completion_mode: normalizeCompletionMode(task),
        current_balance: balance,
        remaining_amount: Math.max(0, required - balance),
        account_id: account?.account_id || null,
        status,
        complete_prompt: String(task.complete_prompt || task.success_prompt || ''),
        failed_prompt: String(task.failed_prompt || task.failure_prompt || ''),
        reward_account_id: String(task.reward_account_id || '').trim() || null,
        conditions,
        task_category: String(task.task_category || task.category || 'side'),
        character_group: String(task.character_group || task.character || '').trim() || null,
    };
}

function normalizeMemoTasks(data, config, accounts, market, runtime = {}) {
    const raw = ['sv_memo_tasks', 'memo_tasks', 'SillyView_memo_tasks']
        .map(key => data.getState(key))
        .find(value => Array.isArray(value) || Array.isArray(value?.tasks)) || null;
    const source = Array.isArray(raw) ? raw : (Array.isArray(raw?.tasks) ? raw.tasks : []);
    return source.map((task, index) => {
        const id = String(task.id || `memo_${index + 1}`);
        if (task.type !== 'series' && !Array.isArray(task.steps)) {
            return normalizeSingleMemoTask(data, config, accounts, market, task, index, runtime[id] || {});
        }
        const seriesRuntime = runtime[id] || {};
        const steps = (Array.isArray(task.steps) ? task.steps : []).map((step, stepIndex) => normalizeSingleMemoTask(
            data, config, accounts, market,
            { ...task, ...step, id: String(step.id || `${id}_${stepIndex + 1}`), account_id: step.account_id ?? task.account_id },
            stepIndex,
            seriesRuntime.steps?.[String(step.id || `${id}_${stepIndex + 1}`)] || {},
        ));
        const currentIndex = Math.max(0, Math.min(Number(seriesRuntime.current_index || 0), Math.max(steps.length - 1, 0)));
        const failed = Boolean(seriesRuntime.failed || steps.some(step => step.status === 'failed'));
        const completed = steps.length > 0 && steps.every(step => step.status === 'completed');
        const visibleStep = steps[currentIndex] || steps[0];
        const seriesTotalRequiredAmount = steps.reduce((sum, step) => sum + Math.max(0, finiteNumber(step.required_amount)), 0);
        const seriesRemainingRequiredAmount = steps.reduce((sum, step) => step.status === 'completed'
            ? sum
            : sum + Math.max(0, finiteNumber(step.required_amount)), 0);
        return {
            ...visibleStep,
            id,
            type: 'series',
            name: String(task.name || id),
            content: String(task.content || visibleStep?.content || ''),
            status: completed ? 'completed' : failed ? 'failed' : visibleStep?.status || 'active',
            current_step_id: visibleStep?.id || null,
            current_step_index: currentIndex,
            completed_steps: steps.filter(step => step.status === 'completed').length,
            total_steps: steps.length,
            series_total_required_amount: seriesTotalRequiredAmount,
            series_remaining_required_amount: seriesRemainingRequiredAmount,
            task_category: String(task.task_category || task.category || 'character'),
            character_group: String(task.character_group || task.character || '').trim() || null,
            steps,
            complete_prompt: String(task.complete_prompt || ''),
            reward_amount: Math.max(0, finiteNumber(task.reward_amount ?? task.reward)),
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

function memoTemplateRevision(content) {
    let hash = 2166136261;
    for (const character of String(content || '')) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return `v${(hash >>> 0).toString(16)}`;
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
        const sourceContent = String(entry.content || '');
        let content = sourceContent;
        let templateError = null;
        if (/<%[=_-]?/.test(content)) {
            const template = data.dependencies?.win?.EjsTemplate || data.dependencies?.win?.parent?.EjsTemplate || globalThis.EjsTemplate;
            if (!template?.prepareContext || !template?.evalTemplate) templateError = '需要安装 ST-Prompt-Template 插件。';
            else {
                try {
                    const context = await template.prepareContext();
                    content = await template.evalTemplate(content, context, { logging: false });
                } catch (error) {
                    templateError = `任务模板解析失败：${error.message || error}`;
                }
            }
        }
        let value = null;
        if (!templateError) {
            try { value = JSON.parse(content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim()); } catch (error) { templateError = `任务 JSON 解析失败：${error.message || error}`; }
        }
        if (Array.isArray(value) || Array.isArray(value?.tasks)) return { key: entry.name || entry.comment, value, external: true, book, templated: /<%[=_-]?/.test(sourceContent), templateError, template_revision: memoTemplateRevision(sourceContent) };
        if (templateError) return { key: entry.name || entry.comment, value: null, external: true, book, templated: true, templateError, template_revision: memoTemplateRevision(sourceContent) };
    }
    return { key: 'sv_memo_tasks', value: null, external: false };
}

async function readMemoProgress(data, config) {
    const book = config.multi_account?.control_worldbook_name;
    if (!book || !data.th?.getWorldbook) {
        const local = data.getState?.(MEMO_PROGRESS_ENTRY);
        return local && typeof local === 'object' ? local : { version: 1, entries: {} };
    }
    try {
        const entry = (await data.th.getWorldbook(book) || []).find(item => item.name === MEMO_PROGRESS_ENTRY);
        const parsed = entry?.content ? JSON.parse(entry.content) : null;
        return parsed && typeof parsed === 'object' ? { version: 1, entries: parsed.entries || {} } : { version: 1, entries: {} };
    } catch { return { version: 1, entries: {} }; }
}

async function writeMemoProgress(data, config, progress) {
    const book = config.multi_account?.control_worldbook_name;
    if (!book || !data.th?.updateWorldbookWith) {
        if (data.updateState) await data.updateState(MEMO_PROGRESS_ENTRY, () => progress);
        return true;
    }
    await data.th.updateWorldbookWith(book, entries => {
        const content = JSON.stringify(progress, null, 2);
        const existing = entries.find(item => item.name === MEMO_PROGRESS_ENTRY);
        if (existing) { existing.enabled = false; existing.content = content; }
        else entries.push({ name: MEMO_PROGRESS_ENTRY, enabled: false, content });
        return entries;
    });
    return true;
}

function memoSourceScope(source) {
    return `${source.book || 'internal'}::${source.key || 'sv_memo_tasks'}`;
}

export function createSillyViewPublicAPI({ data, app = null, roleDecision, config, togglePanel = null }) {
    const api = {
        version: '2.7.1',
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
            const progress = await readMemoProgress(data, config);
            const scope = memoSourceScope(memoSource);
            let scopeProgress = progress.entries[scope] || { tasks: {} };
            if (memoSource.templated && memoSource.value) {
                const rendered = Array.isArray(memoSource.value) ? memoSource.value : memoSource.value.tasks;
                const sourceChanged = scopeProgress.template_revision !== memoSource.template_revision;
                const merged = sourceChanged ? {} : { ...scopeProgress.tasks };
                for (const task of rendered || []) {
                    const id = String(task.id || '');
                    if (!id) continue;
                    merged[id] = { ...(scopeProgress.tasks?.[id] || {}), definition: task };
                }
                const published = Object.values(merged).map(item => item.definition).filter(Boolean);
                const nextValue = Array.isArray(memoSource.value) ? published : { ...(memoSource.value || {}), tasks: published };
                memoSource.value = nextValue;
                if (sourceChanged || JSON.stringify(merged) !== JSON.stringify(scopeProgress.tasks)) {
                    scopeProgress = { ...scopeProgress, template_revision: memoSource.template_revision, tasks: merged };
                    progress.entries[scope] = scopeProgress;
                    await writeMemoProgress(data, config, progress);
                }
            } else if (memoSource.templated && !memoSource.value && Object.keys(scopeProgress.tasks || {}).length > 0) {
                memoSource.value = { tasks: Object.values(scopeProgress.tasks).map(item => item.definition).filter(Boolean) };
            }
            const runtimeTasks = Object.fromEntries(Object.entries(scopeProgress.tasks || {}).map(([id, item]) => [id, item]));
            snapshot.memo_meta = { template_error: memoSource.templateError || null, templated: Boolean(memoSource.templated) };
            snapshot.memo_tasks = normalizeMemoTasks({ ...data, getState: key => key === 'sv_memo_tasks' ? memoSource.value : data.getState(key) }, config, snapshot.accounts, market, runtimeTasks);
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
            const source = await resolveMemoSource(data);
            const progress = await readMemoProgress(data, config);
            const scope = memoSourceScope(source);
            const scopeProgress = progress.entries[scope] || { tasks: {} };
            const memoData = { ...data, getState: key => key === 'sv_memo_tasks' ? source.value : data.getState(key) };
            const tasks = normalizeMemoTasks(memoData, config, accounts, market, scopeProgress.tasks || {});
            const task = tasks.find(item => item.id === String(taskId));
            if (!task) return { ok: false, status: 'missing', message: '任务不存在。' };
            if (task.status === 'completed') return { ok: false, status: 'completed', message: '任务已经完成。' };
            if (task.status === 'failed') {
                if (task.failed_prompt && app?.sendMemoPrompt) await app.sendMemoPrompt(task.failed_prompt);
                return { ok: false, status: 'failed', prompt: task.failed_prompt, message: '任务已超出截止时间，失败提示已发送。' };
            }
            if (task.status === 'insufficient') return { ok: false, status: 'insufficient', prompt: task.failed_prompt, message: '当前余额未达到任务要求。' };

            const step = task.type === 'series' ? task.steps.find(item => item.id === task.current_step_id) : task;
            if (!step) return { ok: false, status: 'missing_step', message: '系列任务当前步骤不存在。' };
            const chargeAmount = Math.max(0, finiteNumber(step.charge_amount));
            const rewardAmount = Math.max(0, finiteNumber(step.reward_amount)) + (task.type === 'series' && step.id === task.steps[task.steps.length - 1]?.id ? Math.max(0, finiteNumber(task.reward_amount)) : 0);
            const sourceAccountId = step.account_id || task.account_id || null;
            const rewardAccountId = step.reward_account_id || task.reward_account_id || sourceAccountId;
            const account = sourceAccountId ? accounts.find(item => item.account_id === sourceAccountId) : null;
            const currentBalance = account ? account.cash : finiteNumber((data.getState(config.world_book_keys.player_portfolio) || {}).cash);
            const managed = await data.getManagedAccountStates();
            if (sourceAccountId && !managed.some(item => item.account_id === sourceAccountId)) return { ok: false, status: 'account_missing', message: '任务账户不存在。' };
            if (rewardAmount > 0 && rewardAccountId && !sourceAccountId && !managed.some(item => item.account_id === rewardAccountId)) return { ok: false, status: 'reward_account_missing', message: '奖励账户不存在。' };
            if (step.completion_mode === 'charge_and_prompt' && currentBalance < chargeAmount) {
                return { ok: false, status: 'insufficient', message: '当前余额不足以完成扣款。' };
            }
            if (app?.prepareMemoTaskRollback) app.prepareMemoTaskRollback({ memo_progress: structuredClone(progress), state: data.createSnapshot?.(), managed_accounts: await data.getManagedAccountStates?.() });

            const updatePortfolio = (portfolio, debit = chargeAmount, credit = rewardAmount) => {
                const before = Number(portfolio.cash || 0);
                portfolio.cash = before - debit;
                if (debit > 0) {
                    if (!Array.isArray(portfolio.transaction_log)) portfolio.transaction_log = [];
                    portfolio.transaction_log.unshift({ time: Number(market.current_time_index || 0), description: `备忘任务扣款: ${step.name}`, amount: -debit });
                }
                if (credit > 0) {
                    portfolio.cash += credit;
                    if (!Array.isArray(portfolio.transaction_log)) portfolio.transaction_log = [];
                    portfolio.transaction_log.unshift({ time: Number(market.current_time_index || 0), description: `备忘任务奖励: ${step.name}`, amount: credit });
                }
                return portfolio;
            };
            if (chargeAmount > 0 || rewardAmount > 0) {
                if (sourceAccountId || rewardAccountId) {
                    if (sourceAccountId) {
                        const target = managed.find(item => item.account_id === sourceAccountId);
                        if (!target) return { ok: false, status: 'account_missing', message: '任务账户不存在。' };
                        updatePortfolio(target.portfolio, chargeAmount, rewardAccountId === sourceAccountId ? rewardAmount : 0);
                    } else if (chargeAmount > 0) await data.updateState(config.world_book_keys.player_portfolio, portfolio => updatePortfolio(portfolio, chargeAmount, 0));
                    if (rewardAmount > 0 && rewardAccountId) {
                        const rewardTarget = managed.find(item => item.account_id === rewardAccountId);
                        if (!rewardTarget) return { ok: false, status: 'reward_account_missing', message: '奖励账户不存在。' };
                        if (rewardAccountId !== sourceAccountId) updatePortfolio(rewardTarget.portfolio, 0, rewardAmount);
                    }
                    await data.restoreManagedAccountStates(managed);
                } else {
                    await data.updateState(config.world_book_keys.player_portfolio, updatePortfolio);
                }
            }

            const memoKey = source.key || 'sv_memo_tasks';
            const raw = source.value || [];
            const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.tasks) ? raw.tasks : []);
            const updated = list.map((item, index) => String(item.id || `memo_${index + 1}`) === task.id
                ? { ...item, completed: true, status: 'completed', completed_at: Date.now() }
                : item);
            if (app?.prepareMemoTaskRollback && source.external) {
                const entries = await data.th.getWorldbook(source.book);
                const entry = (entries || []).find(item => String(item.name || item.comment || '').trim() === memoKey);
                if (entry) app.prepareMemoTaskRollback({ book: source.book, key: memoKey, content: String(entry.content || '') });
            }
            if (source.templated || task.type === 'series') {
                const entry = { ...(scopeProgress || {}), tasks: { ...(scopeProgress.tasks || {}) } };
                const state = entry.tasks[task.id] || {};
                if (task.type === 'series') {
                    const steps = { ...(state.steps || {}) };
                    steps[step.id] = { ...(steps[step.id] || {}), completed: true, completed_at: Date.now() };
                    entry.tasks[task.id] = { ...state, steps, current_index: task.current_step_index + 1, completed: task.current_step_index + 1 >= task.total_steps };
                } else entry.tasks[task.id] = { ...state, completed: true, completed_at: Date.now() };
                progress.entries[scope] = entry;
                await writeMemoProgress(data, config, progress);
            } else if (source.external && data.th?.updateWorldbookWith) {
                await data.th.updateWorldbookWith(source.book, entries => entries.map(entry => (String(entry.name || entry.comment || '').trim() === memoKey ? { ...entry, content: JSON.stringify(Array.isArray(source.value) ? updated : { ...(source.value || {}), tasks: updated }, null, 2) } : entry)));
            } else await data.updateState(memoKey, current => Array.isArray(current)
                ? updated
                : { ...(current || {}), tasks: updated });
            const prompt = step.complete_prompt || (task.type === 'series' && task.current_step_index + 1 >= task.total_steps ? task.complete_prompt : '');
            if (prompt && app?.sendMemoPrompt) await app.sendMemoPrompt(prompt);
            return { ok: true, status: task.type === 'series' && task.current_step_index + 1 < task.total_steps ? 'step_completed' : 'completed', prompt, message: '任务已完成。' };
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
