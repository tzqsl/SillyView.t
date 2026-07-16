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
            crypto_sentiment: macroState.crypto_sentiment || 0,
            volatility_regime: macroState.volatility_regime || 1,
        };

        const meanRevert = 0.92;
        next.risk_sentiment = this._clamp(next.risk_sentiment * meanRevert + this._normalRandom() * 0.10, -1, 1);
        next.usd_strength = this._clamp(next.usd_strength * meanRevert + this._normalRandom() * 0.08, -1, 1);
        next.rate_pressure = this._clamp(next.rate_pressure * 0.96 + this._normalRandom() * 0.04, -1, 1);
        next.inflation_pressure = this._clamp(next.inflation_pressure * 0.97 + this._normalRandom() * 0.035, -1, 1);
        next.energy_pressure = this._clamp(next.energy_pressure * 0.90 + this._normalRandom() * 0.12, -1, 1);
        next.crypto_sentiment = this._clamp(next.crypto_sentiment * 0.88 + this._normalRandom() * 0.16, -1, 1);

        const stress = Math.max(
            Math.abs(next.risk_sentiment),
            Math.abs(next.usd_strength),
            Math.abs(next.energy_pressure),
            Math.abs(next.crypto_sentiment)
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
            (exposure.energy || 0) * (macro.energy_pressure || 0) +
            (exposure.crypto || 0) * (macro.crypto_sentiment || 0);

        return factorScore * 0.0012;
    }

    _calculateVolume(assetDef, open, close, volatility, macroState) {
        const typeBase = {
            Crypto: 850000,
            Index: 420000,
            Commodity: 320000,
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

    _buildMinutePathToClose(assetCode, previousMinute, targetClose, targetTime, pattern = 'sync') {
        const assetDef = this.config.asset_definitions[assetCode];
        const count = Math.max(0, targetTime - previousMinute.time);
        if (count <= 0) return [];

        const volatility = this._getPatternMinuteVolatility(pattern, assetDef);
        const candles = [];
        let last = previousMinute;
        const startClose = previousMinute.close;

        for (let i = 1; i <= count; i++) {
            const progress = i / count;
            const easedProgress = progress < 0.5
                ? 2 * progress * progress
                : 1 - Math.pow(-2 * progress + 2, 2) / 2;
            const trendPrice = startClose + (targetClose - startClose) * easedProgress;
            const noise = i === count
                ? 0
                : this._normalRandom() * startClose * volatility * Math.sin(Math.PI * progress);
            const close = i === count ? targetClose : Math.max(0.000001, trendPrice + noise);
            const candle = this._createMinuteCandle(last, close, volatility, pattern, 1 + Math.abs(this._normalRandom()) * 0.35);
            candles.push(candle);
            last = candle;
        }

        return candles;
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
                hourlyCandle.pattern || 'hourly_sync'
            );
            minuteCandles.push(...generated);
            if (generated.length > 0) {
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

        const nextHourBoundary = ((lastHourly.time || 0) + 1) * 60;
        const cappedBars = Math.min(Math.max(1, requestedBars), Math.max(0, nextHourBoundary - 1 - lastMinute.time));
        if (cappedBars <= 0) return [];

        const globalMarket = this.data.getState(this.config.world_book_keys.global_market) || {};
        const macroState = globalMarket.macro_state || {};
        const personalityState = globalMarket.personality_state || 'CONSOLIDATION';
        const minuteVolatility = this._getPatternMinuteVolatility(
            personalityState === 'VOLATILE_UNCERTAINTY' ? 'volatile' : 'sideways',
            assetDef
        ) * (macroState.volatility_regime || 1);
        const macroDrift = this._calculateMacroDrift(assetDef, macroState) / 60;
        const trendDrift = personalityState === 'BULLISH_TREND'
            ? minuteVolatility * 0.18
            : (personalityState === 'BEARISH_TREND' ? -minuteVolatility * 0.18 : 0);

        const candles = [];
        let last = lastMinute;
        for (let i = 0; i < cappedBars; i++) {
            const changePercent = this._clamp(
                this._normalRandom() * minuteVolatility + trendDrift + macroDrift,
                -0.08,
                0.08
            );
            const close = Math.max(0.000001, last.close * Math.exp(changePercent));
            const candle = this._createMinuteCandle(last, close, minuteVolatility, `chat_${personalityState.toLowerCase()}`, 0.45);
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
        const close = final_close_price;

        let high, low;
        const range = Math.abs(open - close);
        const baseVolatility = open * 0.01; 

        let highMultiplier = 0.5, lowMultiplier = 0.5;

        switch(pattern) {
            case 'volatile': highMultiplier = 2.5; lowMultiplier = 2.5; break;
            case 'bull_run': highMultiplier = 1.5; lowMultiplier = 0.2; break;
            case 'bear_crash': highMultiplier = 0.2; lowMultiplier = 1.5; break;
            case 'reversal_bull': highMultiplier = 0.8; lowMultiplier = 2.0; break;
            case 'reversal_bear': highMultiplier = 2.0; lowMultiplier = 0.8; break;
            case 'consolidation': highMultiplier = 0.3; lowMultiplier = 0.3; break;
            case 'sideways': highMultiplier = 0.3; lowMultiplier = 0.3; break;
        }
        
        const wickVolatility = (baseVolatility * 2 + range * 0.2);
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
            const tempSimulator = { ...this, data: { getState: () => tempState } };
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
            const changePercent = this._clamp(randomFactor * volatility + drift + macroDrift, -0.35, 0.35);
            const newClose = open * Math.exp(changePercent);
            
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
                pattern: `quick_mode_${personality_state.toLowerCase()}`
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
