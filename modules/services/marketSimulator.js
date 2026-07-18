/**
 * SillyView - Market Simulator Service
 * Handles all candle calculation logic for both AI and Quick modes.
 */
'use strict';
import { SillyViewConfig } from '../config.js';

export class MarketSimulator {
    constructor(dependencies) {
        this.data = dependencies.data;
        this.logger = dependencies.logger;
        this.config = dependencies.config;
    }

    _determineNextState(currentState) {
        const r = Math.random();
        switch (currentState) {
            case 'BULLISH_TREND':
                if (r < 0.7) return 'BULLISH_TREND'; // 70% chance to continue
                if (r < 0.95) return 'CONSOLIDATION'; // 25% chance to consolidate
                return 'BEARISH_TREND'; // 5% chance to reverse
            case 'BEARISH_TREND':
                if (r < 0.7) return 'BEARISH_TREND';
                if (r < 0.95) return 'CONSOLIDATION';
                return 'BULLISH_TREND';
            case 'CONSOLIDATION':
                if (r < 0.45) return 'BULLISH_TREND';
                if (r < 0.9) return 'BEARISH_TREND';
                return 'VOLATILE_UNCERTAINTY';
            case 'VOLATILE_UNCERTAINTY':
                // Volatility is usually short-lived
                if (r < 0.8) return 'CONSOLIDATION';
                if (r < 0.9) return 'BULLISH_TREND';
                return 'BEARISH_TREND';
            default:
                return 'CONSOLIDATION';
        }
    }

    _clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    _normalRandom() {
        const u = Math.max(Math.random(), Number.EPSILON);
        const v = Math.max(Math.random(), Number.EPSILON);
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    _fatTailShock() {
        const base = this._normalRandom() * 0.75 + this._normalRandom() * 0.25;
        const jump = Math.random() < 0.025 ? this._normalRandom() * 3.5 : 0;
        return base + jump;
    }

    _evolveMacroState(macroState = {}) {
        const next = {
            risk_sentiment: macroState.risk_sentiment || 0,
            usd_strength: macroState.usd_strength || 0,
            rate_pressure: macroState.rate_pressure || 0,
            inflation_pressure: macroState.inflation_pressure || 0,
            energy_pressure: macroState.energy_pressure || 0,
            volatility_regime: macroState.volatility_regime || 1,
        };

        const meanRevert = 0.92;
        next.risk_sentiment = this._clamp(next.risk_sentiment * meanRevert + this._normalRandom() * 0.10, -1, 1);
        next.usd_strength = this._clamp(next.usd_strength * meanRevert + this._normalRandom() * 0.08, -1, 1);
        next.rate_pressure = this._clamp(next.rate_pressure * 0.96 + this._normalRandom() * 0.04, -1, 1);
        next.inflation_pressure = this._clamp(next.inflation_pressure * 0.97 + this._normalRandom() * 0.035, -1, 1);
        next.energy_pressure = this._clamp(next.energy_pressure * 0.90 + this._normalRandom() * 0.12, -1, 1);

        const stress = Math.max(
            Math.abs(next.risk_sentiment),
            Math.abs(next.usd_strength),
            Math.abs(next.energy_pressure)
        );
        next.volatility_regime = this._clamp(0.75 + stress * 0.9 + Math.random() * 0.25, 0.6, 2.4);
        return next;
    }

    async advanceMacroState(hours = 1) {
        const globalMarket = this.data.getState(this.config.world_book_keys.global_market);
        if (!globalMarket) return null;

        let macroState = globalMarket.macro_state || {};
        for (let i = 0; i < hours; i++) {
            macroState = this._evolveMacroState(macroState);
        }

        globalMarket.macro_state = macroState;
        await this.data.updateState(this.config.world_book_keys.global_market, () => globalMarket);
        return macroState;
    }

    async advanceMarketRegime(hours = 1) {
        const globalMarket = this.data.getState(this.config.world_book_keys.global_market);
        if (!globalMarket) return null;

        let personalityState = globalMarket.personality_state || 'CONSOLIDATION';
        let remaining = globalMarket.personality_duration_remaining ?? 10;

        for (let i = 0; i < hours; i++) {
            if (remaining <= 0) {
                personalityState = this._determineNextState(personalityState);
                remaining = Math.floor(Math.random() * 15) + 5;
                this.logger.log(`New market personality: ${personalityState} for ${remaining} hours.`);
            }
            remaining--;
        }

        globalMarket.personality_state = personalityState;
        globalMarket.personality_duration_remaining = remaining;
        await this.data.updateState(this.config.world_book_keys.global_market, () => globalMarket);
        return personalityState;
    }

    _calculateMacroDrift(assetDef, macroState) {
        const exposure = assetDef.macro_exposure || {};
        const macro = macroState || {};
        const factorScore =
            (exposure.risk || 0) * (macro.risk_sentiment || 0) +
            (exposure.usd || 0) * (macro.usd_strength || 0) +
            (exposure.rates || 0) * (macro.rate_pressure || 0) +
            (exposure.inflation || 0) * (macro.inflation_pressure || 0) +
            (exposure.energy || 0) * (macro.energy_pressure || 0);

        return factorScore * 0.0012;
    }

    _calculateVolume(assetDef, open, close, volatility, macroState) {
        const typeBase = {
            Forex: 1200000,
        };
        const base = typeBase[assetDef.type] || 300000;
        const realizedMove = Math.abs(Math.log(close / open));
        const activity = 1 + Math.min(realizedMove / Math.max(volatility, 0.000001), 5) * 0.55;
        const volatilityBoost = macroState?.volatility_regime || 1;
        return Math.floor(base * activity * volatilityBoost * (0.75 + Math.random() * 0.5));
    }

    _getMinuteSeedCandle(assetData) {
        const minute = assetData?.kline_minute || [];
        if (minute.length > 0) return minute[minute.length - 1];

        const hourly = assetData?.kline_hourly || [];
        const lastHourly = hourly[hourly.length - 1];
        if (!lastHourly) return null;

        return {
            time: (lastHourly.time || 0) * 60,
            open: lastHourly.close,
            high: lastHourly.close,
            low: lastHourly.close,
            close: lastHourly.close,
            volume: 0,
            pattern: 'minute_seed',
        };
    }

    _getPatternMinuteVolatility(pattern, assetDef) {
        const base = (assetDef?.quick_mode_params?.volatility || 0.01) / Math.sqrt(60);
        const multiplier = {
            volatile: 2.0,
            bull_run: 1.2,
            bear_crash: 1.2,
            reversal_bull: 1.5,
            reversal_bear: 1.5,
            consolidation: 0.45,
            sideways: 0.35,
            bull_trend: 0.9,
            bear_trend: 0.9,
            fake_breakout: 1.35,
            fake_breakdown: 1.35,
            washout: 1.6,
            bull_trap: 1.45,
            bear_trap: 1.45,
            panic_sell: 2.2,
            short_squeeze: 2.0,
        }[pattern] || 0.8;
        return base * multiplier;
    }

    _createMinuteCandle(previousCandle, close, volatility, pattern, volumeScale = 1) {
        const open = previousCandle.close;
        const wickBase = Math.max(open * volatility, Math.abs(close - open));
        const high = Math.max(open, close) + wickBase * Math.random() * 0.65;
        const low = Math.max(0.000001, Math.min(open, close) - wickBase * Math.random() * 0.65);

        return {
            time: previousCandle.time + 1,
            open,
            high,
            low,
            close,
            volume: Math.max(1, Math.floor((5000 + Math.random() * 25000) * volumeScale)),
            pattern,
        };
    }

    _buildMinutePathToClose(assetCode, previousMinute, targetClose, targetTime, pattern = 'sync', targetRange = null) {
        const assetDef = this.config.asset_definitions[assetCode];
        const count = Math.max(0, targetTime - previousMinute.time);
        if (count <= 0) return [];

        const globalMarket = this.data.getState(this.config.world_book_keys.global_market) || {};
        const shortTarget = this._getActiveMarketTarget(assetCode, 'short', globalMarket);
        const longTarget = this._getActiveMarketTarget(assetCode, 'long', globalMarket);
        const candles = [];
        let last = previousMinute;
        const startClose = previousMinute.close;
        const requestedHigh = Number(targetRange?.high);
        const requestedLow = Number(targetRange?.low);
        const hasTargetRange = Number.isFinite(requestedHigh) && Number.isFinite(requestedLow) && requestedHigh >= requestedLow;
        const rangeHigh = hasTargetRange ? Math.max(requestedHigh, startClose, targetClose) : Infinity;
        const rangeLow = hasTargetRange ? Math.max(0.000001, Math.min(requestedLow, startClose, targetClose)) : 0.000001;

        for (let i = 1; i <= count; i++) {
            const progress = i / count;
            const easedProgress = progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;
            const currentMinuteIndex = previousMinute.time + i;
            const hourIndex = currentMinuteIndex / 60;
            const activeShortTarget = shortTarget && currentMinuteIndex <= Number(shortTarget.end_minute || 0)
                ? shortTarget
                : null;
            const activeLongTarget = longTarget && hourIndex <= Number(longTarget.end_time || 0)
                ? longTarget
                : null;
            const activePattern = activeShortTarget?.pattern || activeLongTarget?.pattern || pattern;
            const volatility = this._getPatternMinuteVolatility(activePattern, assetDef);
            let trendPrice = startClose + (targetClose - startClose) * easedProgress;
            if (activeShortTarget) {
                const shortProgress = this._getTargetProgress(activeShortTarget, 'short', currentMinuteIndex);
                const shortTargetPrice = Number(activeShortTarget.target_price);
                if (Number.isFinite(shortTargetPrice) && shortTargetPrice > 0) {
                    const shortPathPrice = startClose + (shortTargetPrice - startClose) * shortProgress;
                    const blend = this._clamp(0.25 + shortProgress * 0.45, 0.25, 0.7);
                    const desiredOffset = (shortPathPrice - trendPrice) * blend;
                    const maxIntrahourOffset = Math.max(
                        Math.abs(targetClose - startClose) * 0.75,
                        startClose * volatility * 4
                    );
                    trendPrice += this._clamp(desiredOffset, -maxIntrahourOffset, maxIntrahourOffset);
                }
            }
            const noise = i === count
                ? 0
                : this._normalRandom() * startClose * volatility * Math.sin(Math.PI * progress);
            const rawClose = i === count ? targetClose : Math.max(0.000001, trendPrice + noise);
            const candle = this._createMinuteCandle(last, rawClose, volatility, activePattern, 1 + Math.abs(this._normalRandom()) * 0.35);
            candles.push(candle);
            last = candle;
        }

        if (hasTargetRange && candles.length > 0) {
            const rising = targetClose >= startClose;
            const lowIndex = Math.min(candles.length - 1, Math.floor(candles.length * (rising ? 0.28 : 0.68)));
            const highIndex = Math.min(candles.length - 1, Math.floor(candles.length * (rising ? 0.68 : 0.28)));
            candles[lowIndex].low = Math.min(candles[lowIndex].low, rangeLow);
            candles[highIndex].high = Math.max(candles[highIndex].high, rangeHigh);
        }

        return candles;
    }

    _getMarketTargetState() {
        return this.data.getState(this.config.world_book_keys.market_targets) || { targets: {} };
    }

    _getActiveMarketTarget(assetCode, type, market = null) {
        const state = this._getMarketTargetState();
        const target = state.targets?.[assetCode]?.[type];
        if (!target) return null;

        const globalMarket = market || this.data.getState(this.config.world_book_keys.global_market) || {};
        if (type === 'long') {
            return Number(target.end_time) > Number(globalMarket.current_time_index || 0) ? target : null;
        }
        return Number(target.end_minute) > Number(globalMarket.minute_time_index || 0) ? target : null;
    }

    _getTargetProgress(target, type, currentIndex) {
        const start = type === 'long'
            ? Number(target.created_at || 0)
            : Number(target.created_minute_at || 0);
        const end = type === 'long'
            ? Number(target.end_time || start + 1)
            : Number(target.end_minute || start + 1);
        if (end <= start) return 1;
        return this._clamp((Number(currentIndex || start) - start) / (end - start), 0, 1);
    }

    _getPatternCounterMove(pattern, direction, progress) {
        const counterPatterns = ['fake_breakout', 'fake_breakdown', 'washout', 'bull_trap', 'bear_trap', 'bear_trap_then_rally', 'bull_trap_then_drop'];
        if (!counterPatterns.includes(pattern)) return 0;

        if (progress < 0.30) return -direction * (1 - progress / 0.30);
        if (progress > 0.72) return direction * ((progress - 0.72) / 0.28);
        return 0;
    }

    _calculateTargetDrift(currentPrice, target, type, currentIndex, maxStepAbs) {
        if (!target || !Number.isFinite(currentPrice) || currentPrice <= 0) return 0;

        const targetPrice = Number(target.target_price);
        if (!Number.isFinite(targetPrice) || targetPrice <= 0) return 0;

        const endIndex = type === 'long' ? Number(target.end_time) : Number(target.end_minute);
        const remaining = Math.max(1, endIndex - Number(currentIndex || 0));
        const direction = targetPrice >= currentPrice ? 1 : -1;
        const progress = this._getTargetProgress(target, type, currentIndex);
        const confidence = this._clamp(Number(target.confidence ?? 0.65), 0, 1);
        const urgency = 0.65 + Math.pow(progress, 1.5) * 0.45;
        const directDrift = Math.log(targetPrice / currentPrice) / remaining;
        const counterMove = this._getPatternCounterMove(target.pattern, direction, progress) * maxStepAbs * 0.55 * confidence;
        const adaptiveLimit = Math.max(
            maxStepAbs,
            Math.min(Math.abs(directDrift) * 1.25, type === 'long' ? 0.02 : 0.008)
        );
        const trackingWeight = 0.55 + confidence * 0.4;

        return this._clamp(directDrift * urgency * trackingWeight, -adaptiveLimit, adaptiveLimit) + counterMove;
    }

    _applyHourlyTargetToClose(assetCode, open, proposedClose, nextHourIndex, volatility) {
        const market = this.data.getState(this.config.world_book_keys.global_market) || {};
        const target = this._getActiveMarketTarget(assetCode, 'long', market);
        if (!target) return proposedClose;

        const endTime = Number(target.end_time);
        if (!Number.isFinite(endTime) || nextHourIndex > endTime) return proposedClose;

        const drift = this._calculateTargetDrift(open, target, 'long', nextHourIndex - 1, Math.max(0.001, volatility * 1.4));
        const adjusted = open * Math.exp(Math.log(proposedClose / open) * 0.55 + drift);
        return Math.max(0.000001, adjusted);
    }

    _getTargetPatternSuffix(target) {
        return target?.pattern ? `_${String(target.pattern).toLowerCase()}` : '';
    }

    calculateMinuteCandlesForHourlyCandles(assetCode, hourlyCandles) {
        const assetData = this.data.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
        let lastMinute = this._getMinuteSeedCandle(assetData);
        if (!lastMinute || !Array.isArray(hourlyCandles) || hourlyCandles.length === 0) return [];

        const minuteCandles = [];
        for (const hourlyCandle of hourlyCandles) {
            const targetTime = (hourlyCandle.time || 0) * 60;
            const generated = this._buildMinutePathToClose(
                assetCode,
                lastMinute,
                hourlyCandle.close,
                targetTime,
                hourlyCandle.pattern || 'hourly_sync',
                { high: hourlyCandle.high, low: hourlyCandle.low }
            );
            minuteCandles.push(...generated);
            if (generated.length > 0) {
                hourlyCandle.high = Math.max(
                    Number(hourlyCandle.high || hourlyCandle.open || hourlyCandle.close || 0),
                    ...generated.map(candle => Number(candle.high || candle.open || candle.close || 0))
                );
                hourlyCandle.low = Math.max(0.000001, Math.min(
                    Number(hourlyCandle.low || hourlyCandle.open || hourlyCandle.close || Infinity),
                    ...generated.map(candle => Number(candle.low || candle.open || candle.close || Infinity))
                ));
                lastMinute = generated[generated.length - 1];
            }
        }

        return minuteCandles;
    }

    calculateMinuteCandlesForUserInput(assetCode, requestedBars = 1) {
        const assetDef = this.config.asset_definitions[assetCode];
        const assetData = this.data.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
        const lastMinute = this._getMinuteSeedCandle(assetData);
        const lastHourly = assetData?.kline_hourly?.slice(-1)[0];
        if (!assetDef || !lastMinute || !lastHourly) return [];

        const cappedBars = Math.min(Math.max(1, requestedBars), 60);
        if (cappedBars <= 0) return [];

        const globalMarket = this.data.getState(this.config.world_book_keys.global_market) || {};
        const macroState = globalMarket.macro_state || {};
        const personalityState = globalMarket.personality_state || 'CONSOLIDATION';
        const shortTarget = this._getActiveMarketTarget(assetCode, 'short', globalMarket);
        const longTarget = this._getActiveMarketTarget(assetCode, 'long', globalMarket);
        const fallbackPattern = personalityState === 'VOLATILE_UNCERTAINTY' ? 'volatile' : 'sideways';
        const macroDrift = this._calculateMacroDrift(assetDef, macroState) / 60;

        const candles = [];
        let last = lastMinute;
        for (let i = 0; i < cappedBars; i++) {
            const nextMinuteIndex = last.time + 1;
            const activeShortTarget = shortTarget && nextMinuteIndex <= Number(shortTarget.end_minute || 0)
                ? shortTarget
                : null;
            const activeLongTarget = longTarget && nextMinuteIndex / 60 <= Number(longTarget.end_time || 0)
                ? longTarget
                : null;
            const activePattern = activeShortTarget?.pattern || activeLongTarget?.pattern || fallbackPattern;
            const minuteVolatility = this._getPatternMinuteVolatility(activePattern, assetDef) * (macroState.volatility_regime || 1);
            const trendDrift = personalityState === 'BULLISH_TREND'
                ? minuteVolatility * 0.18
                : (personalityState === 'BEARISH_TREND' ? -minuteVolatility * 0.18 : 0);
            const targetDrift = this._calculateTargetDrift(last.close, activeShortTarget, 'short', last.time, Math.max(0.0004, minuteVolatility * 1.8));
            const longTargetDrift = this._calculateTargetDrift(last.close, activeLongTarget, 'long', last.time / 60, Math.max(0.00012, minuteVolatility * 0.55));
            const changePercent = this._clamp(
                this._normalRandom() * minuteVolatility + trendDrift + macroDrift + targetDrift + longTargetDrift,
                -0.08,
                0.08
            );
            const close = Math.max(0.000001, last.close * Math.exp(changePercent));
            const candle = this._createMinuteCandle(last, close, minuteVolatility, `chat_${personalityState.toLowerCase()}${this._getTargetPatternSuffix(activeShortTarget || activeLongTarget)}`, 0.45);
            candles.push(candle);
            last = candle;
        }

        return candles;
    }

    calculateCandlesFromAI(commandArgs) {
        const [assetCode, timeframe, final_close_price, pattern] = commandArgs;
        
        if (timeframe !== 'HOURLY') {
            this.logger.warn(`MarketSimulator received an unsupported timeframe: ${timeframe}. Defaulting to HOURLY logic.`);
        }

        const assetKey = `${this.config.world_book_keys.asset_prefix}${assetCode}`;
        const assetData = this.data.getState(assetKey);
        if (!assetData) {
            this.logger.error(`无法为 ${assetCode} 计算K线，因为找不到资产数据。`);
            return null;
        }
        
        const lastCandle = assetData.kline_hourly.slice(-1)[0];

        const open = lastCandle.close;
        const targetAdjustedClose = this._applyHourlyTargetToClose(assetCode, open, final_close_price, lastCandle.time + 1, 0.01);
        const close = targetAdjustedClose;

        let high, low;
        const range = Math.abs(open - close);
        const assetDef = this.config.asset_definitions[assetCode];
        const configuredVolatility = Number(assetDef?.quick_mode_params?.volatility || 0.0025);

        let highMultiplier = 0.5, lowMultiplier = 0.5;

        switch(pattern) {
            case 'volatile': highMultiplier = 2.5; lowMultiplier = 2.5; break;
            case 'bull_run': highMultiplier = 1.5; lowMultiplier = 0.2; break;
            case 'bear_crash': highMultiplier = 0.2; lowMultiplier = 1.5; break;
            case 'reversal_bull': highMultiplier = 0.8; lowMultiplier = 2.0; break;
            case 'reversal_bear': highMultiplier = 2.0; lowMultiplier = 0.8; break;
            case 'consolidation': highMultiplier = 0.3; lowMultiplier = 0.3; break;
            case 'sideways': highMultiplier = 0.3; lowMultiplier = 0.3; break;
            case 'bull_trend': highMultiplier = 1.1; lowMultiplier = 0.35; break;
            case 'bear_trend': highMultiplier = 0.35; lowMultiplier = 1.1; break;
            case 'fake_breakout': highMultiplier = 2.2; lowMultiplier = 0.65; break;
            case 'fake_breakdown': highMultiplier = 0.65; lowMultiplier = 2.2; break;
            case 'washout': highMultiplier = 1.0; lowMultiplier = 2.4; break;
            case 'bull_trap': highMultiplier = 2.4; lowMultiplier = 1.0; break;
            case 'bear_trap': highMultiplier = 1.0; lowMultiplier = 2.4; break;
            case 'panic_sell': highMultiplier = 0.4; lowMultiplier = 2.8; break;
            case 'short_squeeze': highMultiplier = 2.8; lowMultiplier = 0.4; break;
        }
        
        const wickVolatility = open * configuredVolatility * 0.55 + range * 0.08;
        high = Math.max(open, close) + wickVolatility * highMultiplier * (0.5 + Math.random() * 0.5);
        low = Math.min(open, close) - wickVolatility * lowMultiplier * (0.5 + Math.random() * 0.5);

        const newCandle = {
            time: lastCandle.time + 1,
            open, high, low, close,
            volume: Math.floor(Math.random() * 500000) + 100000 + (range * 1000),
            pattern: pattern,
        };

        this.logger.log(`为 ${assetCode} 生成了基于AI指令的K线，模式为 "${pattern}"`, newCandle);
        return [newCandle];
    }

    calculateCandleSeriesFromAI(commandArgs) {
        const [assetCode, timeframe, num_candles, final_close_price, pattern] = commandArgs;
        
        if (timeframe !== 'HOURLY') {
            this.logger.warn(`MarketSimulator received an unsupported timeframe: ${timeframe}. Defaulting to HOURLY logic.`);
        }

        const assetKey = `${this.config.world_book_keys.asset_prefix}${assetCode}`;
        const assetData = this.data.getState(assetKey);
        if (!assetData) {
            this.logger.error(`无法为 ${assetCode} 计算K线序列，因为找不到资产数据。`);
            return null;
        }

        let lastCandle = assetData.kline_hourly.slice(-1)[0];
        const newCandles = [];

        for (let i = 0; i < num_candles; i++) {
            const progress = (i + 1) / num_candles;
            const easedProgress = 1 - Math.pow(1 - progress, 2); // Ease-out quadratic
            const targetClose = lastCandle.close + (final_close_price - lastCandle.close) * easedProgress;
            
            const finalCloseForThisStep = (i === num_candles - 1) ? final_close_price : targetClose;

            const newCandleArgs = [assetCode, timeframe, finalCloseForThisStep, pattern];
            
            const tempState = { ...assetData, kline_hourly: [lastCandle] };
            const sourceData = this.data;
            const tempSimulator = Object.create(this);
            tempSimulator.data = {
                getState: key => key === assetKey ? tempState : sourceData.getState(key),
            };
            const generatedCandleArray = tempSimulator.calculateCandlesFromAI(newCandleArgs);
            
            if (generatedCandleArray && generatedCandleArray.length > 0) {
                const newCandle = generatedCandleArray[0];
                newCandles.push(newCandle);
                lastCandle = newCandle;
            }
        }

        this.logger.log(`为 ${assetCode} 生成了 ${num_candles} 根K线的序列，模式为 "${pattern}"`, newCandles);
        return newCandles;
    }
    
    calculateCandlesForQuickMode(assetCode, hours) {
        const assetDef = this.config.asset_definitions[assetCode];
        if (!assetDef) {
            this.logger.error(`Asset definition not found for ${assetCode} in quick mode.`);
            return [];
        }
        const params = assetDef.quick_mode_params;
        
        const assetData = this.data.getState(`${this.config.world_book_keys.asset_prefix}${assetCode}`);
        const globalMarket = this.data.getState(this.config.world_book_keys.global_market);
        
        let lastCandle = assetData.kline_hourly.slice(-1)[0];
        const newCandles = [];
        
        const personality_state = globalMarket.personality_state || 'CONSOLIDATION';
        const macroState = globalMarket.macro_state || {};

        for (let i = 0; i < hours; i++) {
            const open = lastCandle.close;
            let drift = 0;
            let volatility = params.volatility * (macroState.volatility_regime || 1);

            switch (personality_state) {
                case 'BULLISH_TREND':
                    drift = params.drift > 0 ? params.drift * 2.5 : 0.0005;
                    volatility *= 0.8;
                    break;
                case 'BEARISH_TREND':
                    drift = params.drift < 0 ? params.drift * 2.5 : -0.0005;
                    volatility *= 0.8;
                    break;
                case 'CONSOLIDATION':
                    drift = 0;
                    volatility *= 0.3;
                    break;
                case 'VOLATILE_UNCERTAINTY':
                    drift = 0;
                    volatility *= 2.0;
                    break;
            }

            const macroDrift = this._calculateMacroDrift(assetDef, macroState);
            const randomFactor = this._fatTailShock();
            const nextHourIndex = lastCandle.time + 1;
            const targetCandidate = this._getActiveMarketTarget(assetCode, 'long', globalMarket);
            const longTarget = targetCandidate && nextHourIndex <= Number(targetCandidate.end_time || 0)
                ? targetCandidate
                : null;
            const changePercent = this._clamp(randomFactor * volatility + drift + macroDrift, -0.35, 0.35);
            let newClose = open * Math.exp(changePercent);
            newClose = this._applyHourlyTargetToClose(assetCode, open, newClose, nextHourIndex, volatility);
            
            const wickVolatility = volatility * (0.55 + Math.random() * 0.65);
            const highWick = Math.random() * open * wickVolatility;
            const lowWick = Math.random() * open * wickVolatility;

            const high = Math.max(open, newClose) + highWick;
            const low = Math.min(open, newClose) - lowWick;
            
            const newCandle = {
                time: lastCandle.time + 1,
                open: open, 
                high, 
                low, 
                close: newClose,
                volume: this._calculateVolume(assetDef, open, newClose, volatility, macroState),
                pattern: `quick_mode_${personality_state.toLowerCase()}${this._getTargetPatternSuffix(longTarget)}`
            };
            newCandles.push(newCandle);
            lastCandle = newCandle;
        }

        return newCandles;
    }


    calculateCandlesForBackgroundAsset(assetCode, hours) {
        return this.calculateCandlesForQuickMode(assetCode, hours);
    }
}
