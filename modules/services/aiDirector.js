/**
 * SillyView - AI Director Service
 * Handles the logic for constructing prompts to send to the AI.
 */
'use strict';

import { SillyViewConfig } from '../config.js';

export class AIDirector {
    constructor(dependencies) {
        this.data = dependencies.data;
        this.logger = dependencies.logger;
        this.config = dependencies.config;
        this.positionCalculator = dependencies.positionCalculator;
        this.ui = null; // Injected by App
    }
    
    _getMacroEventInstruction() {
        const p = Math.floor(Math.random() * 100) + 1;
        const logicTiers = this.config.macro_event_system.logic_tiers;
        
        const foundTier = logicTiers.find(tier => {
            const range = JSON.parse(tier.range);
            return p >= range[0] && p <= range[1];
        });

        if (foundTier) {
            this.logger.log(`Macro Event Roll: ${p}. Tier: ${foundTier.level}`);
            return `[导演指示：${foundTier.ai_instruction}]`;
        }
        return null;
    }


    async buildAdvanceTurnPrompt(actionsThisTurn, activeAssetsForAI, activeAssetCode, currentTimeframe) {
        let actionSummary;
        if (actionsThisTurn.length > 0) {
            const playerActionsString = actionsThisTurn.map((a, index) => {
                const assetName = this.config.asset_definitions[a.assetCode]?.name || a.assetCode;
                const isLeverage = a.leverage > 1;
                const tradeType = isLeverage ? '杠杆交易' : '现货交易';
            
                const actionDescription = {
                    'open_long': '开多',
                    'add_long': '加仓做多',
                    'open_short': '开空',
                    'add_short': '加仓做空',
                    'close_long': '平多仓',
                    'close_short': '平空仓'
                }[a.intent] || a.intent;
                
                let details = `${tradeType} ${actionDescription} ${assetName}，交易量: ${a.amount.toFixed(2)} 信用点`;
                
                if (isLeverage) {
                    details += `，杠杆倍数: ${a.leverage}x`;
                }
                return `${index + 1}. ${details}`;
            }).join('； ');
            actionSummary = `{{user}}进行了以下操作：{{newline}}${playerActionsString}`;
        } else {
            actionSummary = `{{user}}选择了静观其变。`;
        }


        let promptPrefix = '';
        if (currentTimeframe === 'HOURLY') {
            promptPrefix = '时间过去了一小时，';
        } else if (currentTimeframe === 'DAILY') {
            promptPrefix = '时间过去了一天，';
        }

        // --- Build the <context> block ---
        let contextLines = [];
        const portfolio = this.data.getState(SillyViewConfig.world_book_keys.player_portfolio) || {};
        const globalMarket = this.data.getState(this.config.world_book_keys.global_market) || {};
        await this.data.pruneExpiredMarketTargets();

        // Player Position Info with PnL
        let positionStrings = [];
        for (const code of activeAssetsForAI) {
            const position = this.positionCalculator.calculate(code, portfolio);
            if (position.type) {
                const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${code}`);
                const currentPrice = assetData ? assetData.current_price : 0;
                
                const pnl = position.type === 'long' 
                    ? (currentPrice - position.avgEntryPrice) * position.totalShares
                    : (position.avgEntryPrice - currentPrice) * position.totalShares;
                
                const pnlString = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2);

                const typeText = position.type === 'long' ? '多头' : '空头';
                const leverageText = position.isLeveraged ? `(${position.leverage}x)` : '';
                
                positionStrings.push(`${code} ${typeText}${leverageText}: 保证金 ${position.totalAmount.toFixed(2)} @ ${position.avgEntryPrice.toFixed(4)}, 未实现盈亏: ${pnlString}`);
            }
        }
        const playerPositionText = positionStrings.length > 0 ? positionStrings.join(', ') : '无';
        contextLines.push(`他的持仓: ${playerPositionText}。 现金: ${(portfolio.cash || 0).toFixed(2)}。债务: ${(portfolio.debt || 0).toFixed(2)}。`);
        contextLines.push(`当前时间: ${globalMarket.current_datetime || '未知'}，${globalMarket.current_period || '未知'}，${globalMarket.current_season || '未知'}，天气: ${globalMarket.current_weather || '未知'}。`);
        if (globalMarket.macro_state) {
            const macro = globalMarket.macro_state;
            contextLines.push(`宏观状态: 风险偏好 ${Number(macro.risk_sentiment || 0).toFixed(2)}，美元强弱 ${Number(macro.usd_strength || 0).toFixed(2)}，利率压力 ${Number(macro.rate_pressure || 0).toFixed(2)}，通胀压力 ${Number(macro.inflation_pressure || 0).toFixed(2)}，能源压力 ${Number(macro.energy_pressure || 0).toFixed(2)}，加密情绪 ${Number(macro.crypto_sentiment || 0).toFixed(2)}。`);
        }
        const activeTargetLines = this.data.getActiveMarketTargetsSummary([...activeAssetsForAI]);
        contextLines.push('当前AI大盘目标:');
        contextLines.push(...(activeTargetLines.length > 0 ? activeTargetLines.map(line => `- ${line}`) : ['- 暂无有效目标。']));

        // Market Summary
        contextLines.push('当前市场:');
        for (const code of activeAssetsForAI) {
            const assetData = this.data.getState(`${SillyViewConfig.world_book_keys.asset_prefix}${code}`);
            const assetDef = this.config.asset_definitions[code];
            if (assetData && assetDef) {
                contextLines.push(`- ${assetDef.name} (${code}): ${assetData.current_price.toFixed(4)}`);
            }
        }

        const marketWorldbookContext = await this.data.getMarketWorldbookContext();
        if (marketWorldbookContext) {
            contextLines.push('附加市场世界书上下文（必须纳入市场叙事与判断）:');
            contextLines.push(marketWorldbookContext);
        }

        const taskLines = [];
        taskLines.push('【最高优先级：本回合市场推进任务】');
        taskLines.push(`${promptPrefix}${actionSummary}`);

        if (globalMarket && globalMarket.current_time_index % 2 === 0) {
            const instruction = this._getMacroEventInstruction();
            if (instruction) {
                taskLines.push(instruction);
            }
        }

        const currentAssetName = this.config.asset_definitions[activeAssetCode]?.name || activeAssetCode;
        const timeUnit = currentTimeframe === 'HOURLY' ? '下一小时' : '下一个交易日';
        const requiredAssetList = [...activeAssetsForAI].map(code => {
            const assetName = this.config.asset_definitions[code]?.name || code;
            return `${assetName} (${code})`;
        }).join('、');
        taskLines.push(`本回合必须推进以下全部相关资产：${requiredAssetList}。`);
        taskLines.push('你现在可以用目标指令操盘：没有有效长线目标的相关资产，优先设置一个新的长线目标；没有有效短线目标的当前重点资产，设置一个新的短线目标。已有目标未到期时，新闻、价格推进和 pattern 必须与目标方向或诱多/诱空路径一致。');
        taskLines.push('目标指令格式: [Market.SetLongTarget(asset_code, target_price, hours, "pattern", "reason", confidence)]，hours 建议 4-24；[Market.SetShortTarget(asset_code, target_price, minutes, "pattern", "reason", confidence)]，minutes 建议 8-90。');
        taskLines.push('可选 pattern: bull_trend、bear_trend、consolidation、fake_breakout、fake_breakdown、washout、bull_trap、bear_trap、panic_sell、short_squeeze。confidence 为 0-1 数字。目标到期后系统会自动删除并等待你设置下一段目标。');
        taskLines.push('如果要取消目标，使用 [Market.ClearTarget(asset_code, "long"|"short"|"all")]。');
        taskLines.push(`对于每个相关资产，都必须分别使用 [Market.Advance] 或 [Market.AdvanceSeries] 指令决定其${timeUnit}的收盘价和走势。当前正在查看的 ${currentAssetName} 可以作为叙事重点，但不能忽略其他已交易或持仓资产。`);
        taskLines.push(`timeframe 使用 "${currentTimeframe}"。close_price / final_close_price 必须是数字。pattern 从 bull_run、bear_crash、volatile、consolidation、reversal_bull、reversal_bear、sideways、fake_breakout、fake_breakdown、washout、bull_trap、bear_trap 中选择。`);
        taskLines.push('必须同时使用 [Time.Set] 指令推进世界时间。');
        taskLines.push('只有当本回合发生目标切换、关键转折、异常波动或宏观事件时，才用 <headline>...</headline> 给出一条简短市场新闻；普通噪声推进可以不写 headline。');
        taskLines.push('最后必须输出一个且只有一个 <command>...</command> 块；所有完整指令都放在这个块内。');
        taskLines.push('除最后的 <command> 块外，不要在正文、解释或示例中输出完整的 [Module.Action(...)] 指令。');
        
        const contextString = `<context>{{newline}}${contextLines.join('{{newline}}')}{{newline}}</context>`;
        const taskString = `<task>{{newline}}${taskLines.join('{{newline}}')}{{newline}}</task>`;
        
        return `${contextString}{{newline}}{{newline}}${taskString}`;
    }

    buildSyncPrompt(quickModeStartState, quickModeEndState) {
        if (!quickModeStartState || !quickModeEndState) {
            this.logger.error("buildSyncPrompt called with invalid state snapshots.");
            return null;
        }

        // 1. Extract necessary data from snapshots
        const startPortfolio = quickModeStartState.get(this.config.world_book_keys.player_portfolio);
        const endPortfolio = quickModeEndState.get(this.config.world_book_keys.player_portfolio);
        const endMarket = quickModeEndState.get(this.config.world_book_keys.global_market);
        
        if (!startPortfolio || !endPortfolio || !endMarket) {
            this.logger.error("Cannot build sync prompt, portfolio or market data is missing from snapshots.");
            return null;
        }

        // 2. Build Player Action Summary
        const playerActionsString = (startPortfolio.actions_this_turn || [])
            .map(a => a.text)
            .join('； ');
        const actionSummary = `{{user}}在快速模式中进行了以下操作：\n${playerActionsString || '无操作。'}`;
        
        // 3. Rebuild the <context> block with detailed summary
        let contextLines = [];
        contextLines.push('快速模式总结:');

        // Market Changes (per hour, per asset)
        contextLines.push('市场变化:');
        const allAssetCodes = Object.keys(this.config.asset_definitions);
        for (const code of allAssetCodes) {
            const startAssetData = quickModeStartState.get(`${this.config.world_book_keys.asset_prefix}${code}`);
            const endAssetData = quickModeEndState.get(`${this.config.world_book_keys.asset_prefix}${code}`);
            
            if (startAssetData && endAssetData && startAssetData.kline_hourly) {
                const startIndex = startAssetData.kline_hourly.length;
                const newCandles = endAssetData.kline_hourly.slice(startIndex);
                if (newCandles.length > 0) {
                    const assetName = this.config.asset_definitions[code]?.name || code;
                    contextLines.push(`${assetName} (${code}):`);
                    newCandles.forEach(candle => {
                        contextLines.push(`  第${candle.time}小时收盘价: ${candle.close.toFixed(4)}`);
                    });
                }
            }
        }

        // Market Personality
        if (endMarket.personality_state) {
            contextLines.push(`当前市场风向: ${endMarket.personality_state}`);
        }

        // Final Player Position
        contextLines.push('\n最终持仓状态:');
        let positionStrings = [];
        for (const code of allAssetCodes) {
            const position = this.positionCalculator.calculate(code, endPortfolio);
            if (position.type) {
                const assetData = quickModeEndState.get(`${this.config.world_book_keys.asset_prefix}${code}`);
                const currentPrice = assetData ? assetData.current_price : 0;
                
                const pnl = position.type === 'long' 
                    ? (currentPrice - position.avgEntryPrice) * position.totalShares
                    : (position.avgEntryPrice - currentPrice) * position.totalShares;
                
                const pnlString = pnl >= 0 ? `+${pnl.toFixed(2)}` : pnl.toFixed(2);
                const typeText = position.type === 'long' ? '多头' : '空头';
                const leverageText = position.isLeveraged ? `(${position.leverage}x)` : '';
                
                positionStrings.push(`${code} ${typeText}${leverageText}: 保证金 ${position.totalAmount.toFixed(2)} @ ${position.avgEntryPrice.toFixed(4)}, 未实现盈亏: ${pnlString}`);
            }
        }
        const playerPositionText = positionStrings.length > 0 ? positionStrings.join('， ') : '无持仓';
        contextLines.push(playerPositionText);
        contextLines.push(`现金: ${endPortfolio.cash.toFixed(2)}。`);

        // AI Instruction
        contextLines.push(`\n[导演指示：请根据以上快速模式的总结，生成一段承上启下的市场新闻和评论。不要使用任何指令。]`);

        const contextString = `<context>{{newline}}${contextLines.join('{{newline}}')}{{newline}}</context>`;
        
        return `${actionSummary}{{newline}}${contextString}`;
    }
}
