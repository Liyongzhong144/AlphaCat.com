import { NextRequest, NextResponse } from 'next/server';
import { BacktestEngine } from '@/lib/trading/backtest/engine';
import { HistoricalDataProvider } from '@/lib/trading/connectors/historicalDataProvider';
import type { TradingConfig, Candle } from '@/lib/trading/types';

/**
 * Fetch with retry logic and longer timeout
 */
async function fetchWithRetry(url: string, retries = 3, timeout = 30000): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      clearTimeout(timeoutId);
      return response;
    } catch (error: any) {
      if (i === retries - 1) throw error;

      console.log(`Fetch attempt ${i + 1} failed, retrying... (${error.message})`);
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1))); // Exponential backoff
    }
  }

  throw new Error('All retry attempts failed');
}

/**
 * Fetch historical candles from Binance public API (no authentication needed)
 */
async function fetchBinancePublicCandles(
  symbol: string,
  interval: string,
  startTime: number,
  endTime: number
): Promise<Candle[]> {
  // Try multiple Binance endpoints
  const endpoints = [
    'https://fapi.binance.com',
    'https://fapi1.binance.com',
    'https://fapi2.binance.com',
    'https://fapi3.binance.com',
  ];

  const limit = 1500;
  const allCandles: Candle[] = [];
  let currentStart = startTime;
  let lastError: Error | null = null;

  // Fetch in batches of 1500 candles until we reach endTime
  while (currentStart < endTime && allCandles.length < 20000) {
    let success = false;

    // Try each endpoint
    for (const baseUrl of endpoints) {
      try {
        const url = `${baseUrl}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${currentStart}&endTime=${endTime}&limit=${limit}`;

        console.log(`Fetching from ${baseUrl}...`);
        const response = await fetchWithRetry(url, 3, 30000);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (!data || data.length === 0) {
          success = true;
          break; // No more data available
        }

        // Convert Binance format to our Candle format
        const candles: Candle[] = data.map((k: any[]) => ({
          openTime: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          closeTime: k[6],
        }));

        allCandles.push(...candles);

        // Move to next batch
        if (candles.length < limit) {
          success = true;
          break; // Got less than limit, means we reached the end
        }

        // Start from the last candle's closeTime + 1ms
        currentStart = candles[candles.length - 1].closeTime + 1;

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));

        success = true;
        break; // Success, move to next batch

      } catch (error) {
        lastError = error as Error;
        console.warn(`Failed to fetch from ${baseUrl}:`, error);
        continue; // Try next endpoint
      }
    }

    if (!success) {
      throw new Error(`Failed to fetch data from all Binance endpoints. Last error: ${lastError?.message}`);
    }

    if (allCandles.length >= 20000) {
      console.log('Reached maximum candle limit (20000)');
      break;
    }
  }

  return allCandles;
}

/**
 * POST /api/trading/backtest
 *
 * Run backtest on historical data from Binance public API
 *
 * Request body:
 * {
 *   startDate: number (timestamp)
 *   endDate: number (timestamp)
 *   initialCapital: number
 *   tradingConfig: TradingConfig
 * }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      startDate,
      endDate,
      initialCapital,
      tradingConfig,
    } = body;

    // Validate required fields
    if (!startDate || !endDate || !initialCapital || !tradingConfig) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    let candles: Candle[] = [];
    let dataSource = 'generated';

    // Try to fetch from Binance public API first
    try {
      console.log(`Fetching historical data from Binance for ${tradingConfig.symbol}...`);
      console.log(`Date range: ${new Date(startDate).toISOString()} to ${new Date(endDate).toISOString()}`);

      candles = await fetchBinancePublicCandles(
        tradingConfig.symbol,
        tradingConfig.interval,
        startDate,
        endDate
      );

      if (candles.length > 0) {
        dataSource = 'binance-public';
        console.log(`Fetched ${candles.length} candles from Binance`);
        console.log(`First candle: ${new Date(candles[0].openTime).toISOString()}`);
        console.log(`Last candle: ${new Date(candles[candles.length - 1].closeTime).toISOString()}`);
      }
    } catch (error) {
      console.warn('Binance API failed, falling back to simulated data:', error);
    }

    // Fallback to simulated historical data if Binance failed
    if (candles.length === 0) {
      console.log('Using simulated historical data provider...');
      const historicalProvider = new HistoricalDataProvider();

      // Calculate number of candles needed
      const intervalMs = getIntervalMs(tradingConfig.interval);
      const candlesNeeded = Math.min(
        20000,
        Math.ceil((endDate - startDate) / intervalMs)
      );

      candles = await historicalProvider.generateHistoricalCandles(
        tradingConfig.symbol,
        tradingConfig.interval,
        candlesNeeded,
        startDate,
        endDate
      );

      console.log(`Generated ${candles.length} simulated candles`);
    }

    if (candles.length === 0) {
      return NextResponse.json(
        { error: 'No candles found for specified date range' },
        { status: 404 }
      );
    }

    // Run backtest
    const engine = new BacktestEngine({
      startDate,
      endDate,
      initialCapital,
      tradingConfig,
    });

    console.log('Running backtest...');
    const results = await engine.runBacktest(candles);
    console.log('Backtest complete');

    return NextResponse.json({
      ...results,
      candles: candles.slice(-500), // Return last 500 candles for charting
      dataSource, // 'binance-public' or 'generated'
      totalCandles: candles.length,
    });
  } catch (error) {
    console.error('Backtest error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * Helper function to convert interval string to milliseconds
 */
function getIntervalMs(interval: string): number {
  const intervalMap: Record<string, number> = {
    '1m': 60 * 1000,
    '5m': 5 * 60 * 1000,
    '15m': 15 * 60 * 1000,
    '1h': 60 * 60 * 1000,
    '4h': 4 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
  };
  return intervalMap[interval] || 60 * 1000;
}
