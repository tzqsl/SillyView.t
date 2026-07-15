/**
 * SillyView - Chart Manager
 * A dedicated module to encapsulate all direct interactions with the Lightweight Charts library.
 * This isolates the charting logic, making it more stable and reusable.
 */
'use strict';
import { Logger } from '../logger.js';

export class ChartManager {
    constructor(dependencies) {
        this.win = dependencies.win;
        this.parentDoc = dependencies.parentDoc;
        this.logger = dependencies.logger;

        this.chart = null;
        this.candlestickSeries = null;
        this.volumeSeries = null;
        this.resizeObserver = null;
    }

    isInitialized() {
        return !!this.chart;
    }

    initialize(containerElement) {
        if (!containerElement || !this.win.LightweightCharts) {
            this.logger.error("Chart container or LightweightCharts library not found.");
            return false;
        }

        this.chart = this.win.LightweightCharts.createChart(containerElement, {
            width: containerElement.clientWidth,
            height: containerElement.clientHeight,
            layout: {
                backgroundColor: '#111827', // bg-gray-900
                textColor: 'rgba(255, 255, 255, 0.9)',
            },
            grid: {
                vertLines: { color: 'rgba(197, 203, 206, 0.1)' },
                horzLines: { color: 'rgba(197, 203, 206, 0.1)' },
            },
            crosshair: { mode: this.win.LightweightCharts.CrosshairMode.Normal },
            rightPriceScale: { borderColor: 'rgba(197, 203, 206, 0.2)' },
            timeScale: { borderColor: 'rgba(197, 203, 206, 0.2)', timeVisible: true, secondsVisible: false },
        });

        this.candlestickSeries = this.chart.addCandlestickSeries({
            upColor: '#22c55e', downColor: '#ef4444', borderDownColor: '#ef4444',
            borderUpColor: '#22c55e', wickDownColor: '#ef4444', wickUpColor: '#22c55e',
        });

        this.volumeSeries = this.chart.addHistogramSeries({
            color: '#384259', priceFormat: { type: 'volume' }, priceScaleId: '',
        });
        
        this.chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.25 } });
        this.chart.priceScale('').applyOptions({ scaleMargins: { top: 0.75, bottom: 0 } });

        // Setup resize observer
        this.resizeObserver = new this.win.ResizeObserver(entries => {
            if (entries.length > 0 && entries[0].contentRect.width > 0) {
                const { width, height } = entries[0].contentRect;
                this.handleResize(width, height);
            }
        });
        this.resizeObserver.observe(containerElement);
        
        this.logger.success("TradingView Chart initialized via ChartManager.");
        return true;
    }

    _normalizeSeriesData(data) {
        if (!Array.isArray(data)) return [];

        const byTime = new Map();
        for (const item of data) {
            if (item && item.time !== undefined && item.time !== null) {
                byTime.set(item.time, item);
            }
        }

        return Array.from(byTime.values()).sort((a, b) => {
            if (typeof a.time === 'number' && typeof b.time === 'number') {
                return a.time - b.time;
            }
            return String(a.time).localeCompare(String(b.time));
        });
    }

    setData(candlestickData, volumeData) {
        if (!this.candlestickSeries || !this.volumeSeries) return;
        this.candlestickSeries.setData(this._normalizeSeriesData(candlestickData));
        this.volumeSeries.setData(this._normalizeSeriesData(volumeData));
    }

    update(candle, volume) {
        if (!this.candlestickSeries || !this.volumeSeries) return;
        try {
            if (candle) this.candlestickSeries.update(candle);
            if (volume) this.volumeSeries.update(volume);
        } catch (error) {
            this.logger.warn('Chart realtime update skipped:', error);
        }
    }

    setMarkers(markers) {
        if (!this.candlestickSeries) return;
        this.candlestickSeries.setMarkers(markers);
    }

    createPriceLine(options) {
        if (!this.candlestickSeries) return null;
        return this.candlestickSeries.createPriceLine(options);
    }

    removePriceLine(line) {
        if (!this.candlestickSeries || !line) return;
        this.candlestickSeries.removePriceLine(line);
    }

    subscribeCrosshairMove(callback) {
        if (!this.chart) return;
        this.chart.subscribeCrosshairMove(callback);
    }

    handleResize(width, height) {
        if (!this.chart) return;
        this.chart.applyOptions({ width, height });
    }

    getSeries() {
        return {
            candlestickSeries: this.candlestickSeries,
            volumeSeries: this.volumeSeries,
        };
    }

    scrollToPosition(position, animated = true) {
        if (!this.chart) return;
        const timeScale = this.chart.timeScale();
        const visibleRange = timeScale.getVisibleLogicalRange();
        if (visibleRange === null) {
            // If range isn't available yet, just scroll.
            timeScale.scrollToPosition(position, animated);
            return;
        }

        // Only scroll if the new bar is outside or very near the right edge of the visible range.
        // A buffer of 5 bars provides a good user experience.
        if (position > visibleRange.to - 5) {
            timeScale.scrollToPosition(position, animated);
        }
    }

    destroy() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
        if (this.chart) {
            this.chart.remove();
            this.chart = null;
        }
        this.candlestickSeries = null;
        this.volumeSeries = null;
        this.logger.log("ChartManager destroyed chart instance.");
    }
}
