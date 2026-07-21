/**
 * Read-only bridge for TavernHelper frontends.
 * The UI can consume snapshots without reaching into SillyView internals.
 */
'use strict';

function finiteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
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

export function createSillyViewPublicAPI({ data, roleDecision, config }) {
    const api = {
        version: '1.0.0',
        readonly: true,
        async getSnapshot() {
            const states = await data.getManagedAccountStates();
            const profiles = await data.getManagedRoleProfiles();
            const roleRun = roleDecision?.lastRun;
            const market = data.getState(config.world_book_keys.global_market) || {};
            const assets = Object.keys(config.asset_definitions || {}).map(assetCode => {
                const asset = data.getState(`${config.world_book_keys.asset_prefix}${assetCode}`) || {};
                return {
                    code: assetCode,
                    name: config.asset_definitions[assetCode]?.name || assetCode,
                    price: finiteNumber(asset.current_price),
                    change_pct: finiteNumber(asset.change_pct),
                };
            });
            return {
                api_version: api.version,
                generated_at: Date.now(),
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
                },
                accounts: states.map(state => buildAccountSnapshot(data, state)),
            };
        },
    };
    return Object.freeze(api);
}
