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
