import { NextRequest, NextResponse } from 'next/server';
import { BinanceConnector } from '@/lib/trading/connectors/binance';
import { XAUUSDStrategy } from '@/lib/trading/strategies/xauusd-strategy';
import type { TradingConfig } from '@/lib/trading/types';

/**
 * POST /api/trading/live
 *
 * Execute live trading operations
 *
 * Actions:
 * - 'start': Start live trading bot
 * - 'stop': Stop live trading bot
 * - 'execute_signal': Execute a manual trade based on current signal
 * - 'close_position': Close current position
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, tradingConfig, symbol = 'XAUUSDT' } = body;

    if (!action) {
      return NextResponse.json(
        { error: 'Action is required' },
        { status: 400 }
      );
    }

    const apiKey = process.env.BINANCE_API_KEY || '';
    const apiSecret = process.env.BINANCE_API_SECRET || '';
    const useTestnet = process.env.BINANCE_TESTNET === 'true';

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { error: 'Binance API credentials not configured' },
        { status: 500 }
      );
    }

    const binance = new BinanceConnector({
      apiKey,
      apiSecret,
      testnet: useTestnet,
    });

    // Test connection
    const connected = await binance.testConnection();
    if (!connected) {
      return NextResponse.json(
        { error: 'Failed to connect to Binance API' },
        { status: 500 }
      );
    }

    switch (action) {
      case 'execute_signal': {
        if (!tradingConfig) {
          return NextResponse.json(
            { error: 'Trading config is required for execute_signal' },
            { status: 400 }
          );
        }

        // Fetch recent candles
        const candles = await binance.getHistoricalCandles(
          symbol,
          tradingConfig.interval,
          200 // Sufficient for indicators
        );

        // Generate signal
        const strategy = new XAUUSDStrategy(tradingConfig);
        const signal = strategy.generateSignal(candles);

        if (signal.type === 'none') {
          return NextResponse.json({
            message: 'No trading signal',
            signal,
          });
        }

        // Check if there's already a position
        const existingPosition = await binance.getPosition(symbol);
        if (existingPosition && existingPosition.positionAmount !== 0) {
          return NextResponse.json(
            {
              error: 'Position already exists. Close it first.',
              position: existingPosition,
            },
            { status: 400 }
          );
        }

        // Execute trade
        const side = signal.type === 'long' ? 'BUY' : 'SELL';
        const quantity = tradingConfig.risk.positionSize;

        const order = await binance.placeMarketOrder(symbol, side, quantity);

        // Place stop loss
        const stopLossSide = signal.type === 'long' ? 'SELL' : 'BUY';
        const signalSide: 'long' | 'short' = signal.type === 'long' ? 'long' : 'short';
        const stopLossPrice = signal.indicators
          ? strategy.calculateStopLoss(
              signal.price,
              signalSide,
              signal.indicators
            )
          : signal.price * (signal.type === 'long' ? 0.99 : 1.01);

        const stopOrder = await binance.placeStopOrder(
          symbol,
          stopLossSide,
          quantity,
          stopLossPrice
        );

        return NextResponse.json({
          message: 'Trade executed successfully',
          signal,
          order,
          stopOrder,
        });
      }

      case 'close_position': {
        const order = await binance.closePosition(symbol);

        if (!order) {
          return NextResponse.json({
            message: 'No position to close',
          });
        }

        // Cancel any open orders
        const openOrders = await binance.getOpenOrders(symbol);
        for (const openOrder of openOrders) {
          await binance.cancelOrder(symbol, openOrder.orderId);
        }

        return NextResponse.json({
          message: 'Position closed successfully',
          order,
        });
      }

      case 'start': {
        // Note: Actual bot implementation would require a persistent process
        // This is a placeholder for the API endpoint
        return NextResponse.json({
          message: 'Live trading bot start functionality not yet implemented',
          info: 'Use execute_signal for manual trading',
        });
      }

      case 'stop': {
        return NextResponse.json({
          message: 'Live trading bot stop functionality not yet implemented',
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Live trading error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/trading/live
 *
 * Get current signal without executing
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'XAUUSDT';
    const interval = searchParams.get('interval') || '1m';

    const apiKey = process.env.BINANCE_API_KEY || '';
    const apiSecret = process.env.BINANCE_API_SECRET || '';
    const useTestnet = process.env.BINANCE_TESTNET === 'true';

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { error: 'Binance API credentials not configured' },
        { status: 500 }
      );
    }

    const binance = new BinanceConnector({
      apiKey,
      apiSecret,
      testnet: useTestnet,
    });

    // Fetch recent candles
    const candles = await binance.getHistoricalCandles(symbol, interval, 200);

    // Default config for signal generation
    const defaultConfig: TradingConfig = {
      symbol,
      interval: interval as TradingConfig['interval'],
      strategy: {
        aggressiveness: 2,
        trailingActivation: 0.8,
        trailingDistance: 1.0,
        indicators: {
          keltner: { maPeriod: 15, atrPeriod: 10, atrMultiple: 0.5 },
          bollinger: { period: 15, deviation: 1.0 },
          macd: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
          cci: { period: 20 },
          supertrend: { period: 10, multiplier: 3.0 },
        },
      },
      risk: {
        maxDailyLoss: 1000,
        maxDrawdown: 0.25,
        maxPositions: 1,
        positionSize: 10, // USDT
        leverage: 10, // 10x leverage
        stopLossMultiple: 1.5,
        takeProfitLevels: [1.5, 2.5, 4.0],
      },
    };

    const strategy = new XAUUSDStrategy(defaultConfig);
    const signal = strategy.generateSignal(candles);

    return NextResponse.json({ signal });
  } catch (error) {
    console.error('Get signal error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
