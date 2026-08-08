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
        this.lineSeries = null;
        this.volumeSeries = null;
        this.indicatorSeries = {};
        this.resizeObserver = null;
        this.chartType = 'candlestick';
        this.timeOriginSeconds = 0;
        this.timeUnitSeconds = 3600;
    }

    isInitialized() {
        return !!this.chart;
    }

    initialize(containerElement) {
        if (!containerElement || !this.win.LightweightCharts) {
            this.logger.error("Chart container or LightweightCharts library not found.");
            return false;
        }

        const chartBackground = '#0b1220';
        const colorType = this.win.LightweightCharts.ColorType?.Solid ?? 'solid';
        this.chart = this.win.LightweightCharts.createChart(containerElement, {
            width: containerElement.clientWidth,
            height: containerElement.clientHeight,
            layout: {
                background: { type: colorType, color: chartBackground },
                backgroundColor: chartBackground,
                textColor: '#f3f4f6',
                fontSize: 12,
            },
            grid: {
                vertLines: { color: 'rgba(148, 163, 184, 0.18)' },
                horzLines: { color: 'rgba(148, 163, 184, 0.22)' },
            },
            crosshair: {
                mode: this.win.LightweightCharts.CrosshairMode.Normal,
                vertLine: { color: 'rgba(226, 232, 240, 0.55)', labelBackgroundColor: '#334155' },
                horzLine: { color: 'rgba(226, 232, 240, 0.65)', labelBackgroundColor: '#334155' },
            },
            rightPriceScale: {
                visible: true,
                borderVisible: true,
                borderColor: 'rgba(226, 232, 240, 0.62)',
                ticksVisible: true,
                alignLabels: true,
                entireTextOnly: true,
                autoScale: true,
            },
            timeScale: {
                borderVisible: true,
                borderColor: 'rgba(226, 232, 240, 0.5)',
                ticksVisible: true,
                timeVisible: true,
                secondsVisible: false,
                tickMarkFormatter: time => this._formatChartTime(time),
            },
            localization: {
                timeFormatter: time => this._formatChartTime(time),
            },
        });

        this.candlestickSeries = this.chart.addCandlestickSeries({
            upColor: '#22c55e', downColor: '#ef4444', borderDownColor: '#ef4444',
            borderUpColor: '#22c55e', wickDownColor: '#ef4444', wickUpColor: '#22c55e',
            priceLineVisible: true,
            lastValueVisible: true,
        });

        this.lineSeries = this.chart.addLineSeries({
            color: '#38e8ff',
            lineWidth: 3,
            crosshairMarkerVisible: true,
            crosshairMarkerRadius: 4,
            priceLineVisible: true,
            lastValueVisible: true,
            visible: false,
        });

        this.volumeSeries = this.chart.addHistogramSeries({
            color: '#64748b', priceFormat: { type: 'volume' }, priceScaleId: '',
        });
        this.indicatorSeries = {
            average: this.chart.addLineSeries({ color: '#f59e0b', lineWidth: 2, priceLineVisible: false, lastValueVisible: false }),
            ma5: this.chart.addLineSeries({ color: '#facc15', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
            ma10: this.chart.addLineSeries({ color: '#a78bfa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
            ma20: this.chart.addLineSeries({ color: '#22d3ee', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
        };
        
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
                const chartItem = { ...item, time: this.toChartTime(item.time) };
                byTime.set(chartItem.time, chartItem);
            }
        }

        return Array.from(byTime.values()).sort((a, b) => {
            if (typeof a.time === 'number' && typeof b.time === 'number') {
                return a.time - b.time;
            }
            return String(a.time).localeCompare(String(b.time));
        });
    }

    _formatChartTime(time) {
        const date = new Date(Number(time) * 1000);
        if (!Number.isFinite(date.getTime())) return '';
        const pad = value => String(value).padStart(2, '0');
        const shortYear = String(date.getFullYear()).slice(-2);
        return `${shortYear}.${date.getMonth() + 1}.${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    setTimeContext(originSeconds, unitSeconds) {
        this.timeOriginSeconds = Number.isFinite(Number(originSeconds)) ? Number(originSeconds) : 0;
        this.timeUnitSeconds = Number.isFinite(Number(unitSeconds)) && Number(unitSeconds) > 0 ? Number(unitSeconds) : 3600;
    }

    toChartTime(index) {
        if (typeof index !== 'number' || !Number.isFinite(index)) return index;
        return Math.round(this.timeOriginSeconds + index * this.timeUnitSeconds);
    }

    fromChartTime(time) {
        if (typeof time !== 'number' || !Number.isFinite(time)) return time;
        return Math.round((time - this.timeOriginSeconds) / this.timeUnitSeconds);
    }

    _getForexPriceFormat(candles) {
        const lastPrice = [...candles].reverse().find(candle => Number.isFinite(Number(candle?.close)))?.close;
        const isYenStyleQuote = Number(lastPrice) >= 10;
        const precision = isYenStyleQuote ? 3 : 5;
        return {
            type: 'price',
            precision,
            minMove: 10 ** -precision,
        };
    }

    setData(candlestickData, volumeData) {
        if (!this.candlestickSeries || !this.lineSeries || !this.volumeSeries) return;
        const normalizedCandles = this._normalizeSeriesData(candlestickData);
        const priceFormat = this._getForexPriceFormat(normalizedCandles);
        this.candlestickSeries.applyOptions({ priceFormat });
        this.lineSeries.applyOptions({ priceFormat });
        this.candlestickSeries.setData(normalizedCandles);
        this.lineSeries.setData(normalizedCandles.map(candle => ({
            time: candle.time,
            value: Number(candle.close),
        })));
        this.volumeSeries.setData(this._normalizeSeriesData(volumeData));
    }

    setIndicators(indicators = {}) {
        for (const [name, series] of Object.entries(this.indicatorSeries)) {
            series.setData(this._normalizeSeriesData(indicators[name] || []));
            series.applyOptions({ visible: (indicators[name] || []).length > 0 });
        }
    }

    setIndicatorVisibility(visibility = {}) {
        for (const [name, series] of Object.entries(this.indicatorSeries)) {
            if (Object.prototype.hasOwnProperty.call(visibility, name)) series.applyOptions({ visible: Boolean(visibility[name]) });
        }
    }

    update(candle, volume) {
        if (!this.candlestickSeries || !this.lineSeries || !this.volumeSeries) return;
        try {
            if (candle) {
                const chartCandle = { ...candle, time: this.toChartTime(candle.time) };
                this.candlestickSeries.update(chartCandle);
                this.lineSeries.update({ time: chartCandle.time, value: Number(candle.close) });
            }
            if (volume) this.volumeSeries.update({ ...volume, time: this.toChartTime(volume.time) });
        } catch (error) {
            this.logger.warn('Chart realtime update skipped:', error);
        }
    }

    setMarkers(markers) {
        const activeSeries = this._getActivePriceSeries();
        if (!activeSeries) return;
        this.candlestickSeries.setMarkers([]);
        this.lineSeries.setMarkers([]);
        activeSeries.setMarkers(markers);
    }

    createPriceLine(options) {
        const series = this._getActivePriceSeries();
        if (!series) return null;
        return { series, line: series.createPriceLine(options) };
    }

    removePriceLine(priceLineHandle) {
        if (!priceLineHandle) return;
        const series = priceLineHandle.series || this._getActivePriceSeries();
        const line = priceLineHandle.line || priceLineHandle;
        if (!series || !line) return;
        series.removePriceLine(line);
    }

    _getActivePriceSeries() {
        return this.chartType === 'line' ? this.lineSeries : this.candlestickSeries;
    }

    setChartType(chartType) {
        const normalizedType = chartType === 'line' ? 'line' : 'candlestick';
        this.chartType = normalizedType;
        if (!this.candlestickSeries || !this.lineSeries) return;
        this.candlestickSeries.applyOptions({ visible: normalizedType === 'candlestick' });
        this.lineSeries.applyOptions({ visible: normalizedType === 'line' });
    }

    subscribeCrosshairMove(callback) {
        if (!this.chart) return;
        this.chart.subscribeCrosshairMove(callback);
    }

    handleResize(width, height) {
        if (!this.chart) return;
        this.chart.applyOptions({ width, height });
    }

    resetPriceScale() {
        if (!this.chart) return;
        this.chart.priceScale('right').applyOptions({ autoScale: true });
    }

    getSeries() {
        return {
            candlestickSeries: this.candlestickSeries,
            lineSeries: this.lineSeries,
            activePriceSeries: this._getActivePriceSeries(),
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
        this.lineSeries = null;
        this.volumeSeries = null;
        this.indicatorSeries = {};
        this.logger.log("ChartManager destroyed chart instance.");
    }
}
