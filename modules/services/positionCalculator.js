/**
 * SillyView - Position Calculator Service
 * A pure service to handle all complex position calculations, including leverage.
 */
'use strict';

export class PositionCalculator {
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.config = dependencies.config;
    }

    /**
     * Calculates detailed position information for a given asset.
     * @param {string} assetCode - The code of the asset (e.g., 'EURUSD').
     * @param {object} portfolio - The player's portfolio object.
     * @returns {object} A detailed position object.
     */
    calculate(assetCode, portfolio, mode = 'leveraged') {
        const asset = portfolio?.assets?.[assetCode] || {};
        let trades = [];
        if (mode === 'spot') {
            trades = asset.spot?.trades || [];
        } else {
            trades = asset.leveraged?.trades || asset.trades || [];
        }
        if (trades.length === 0) {
            return { mode, type: null, totalAmount: 0, avgEntryPrice: 0, totalShares: 0, isLeveraged: false, leverage: 1, positionValue: 0, liquidationPrice: 0 };
        }

        const tradeType = trades[0].type; // 'long' or 'short'

        let margin = 0;
        let totalPositionValue = 0;

        trades.forEach(t => {
            margin += t.amount;
            totalPositionValue += t.amount * (t.leverage || 1);
        });

        if (margin < 0.01) {
            return { type: null, totalAmount: 0, avgEntryPrice: 0, totalShares: 0, isLeveraged: false, leverage: 1, positionValue: 0, liquidationPrice: 0 };
        }

        const leverage = Number((totalPositionValue / margin).toFixed(4));
        const isLeveraged = mode === 'leveraged';
        const avgEntryPrice = trades.reduce((sum, t) => sum + t.price * (t.amount * (t.leverage || 1)), 0) / totalPositionValue;
        const totalShares = totalPositionValue / avgEntryPrice;
        const maintenanceMarginRate = this.config?.asset_definitions?.[assetCode]?.trade_config?.maintenance_margin_rate ?? 0.01;
        
        let liquidationPrice = 0;
        if (isLeveraged) {
            if (tradeType === 'long') {
                liquidationPrice = (avgEntryPrice * totalShares - margin) / (totalShares * (1 - maintenanceMarginRate));
            } else if (tradeType === 'short') {
                liquidationPrice = (margin + avgEntryPrice * totalShares) / (totalShares * (1 + maintenanceMarginRate));
            }
            liquidationPrice = Math.max(liquidationPrice, 0);
        }
        
        return {
            mode,
            type: tradeType,
            totalAmount: margin,
            avgEntryPrice,
            totalShares,
            isLeveraged,
            leverage,
            positionValue: totalPositionValue,
            liquidationPrice,
            maintenanceMarginRate,
        };
    }

    calculateAll(assetCode, portfolio) {
        return {
            spot: this.calculate(assetCode, portfolio, 'spot'),
            leveraged: this.calculate(assetCode, portfolio, 'leveraged'),
        };
    }
}
