import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

// Use production Binance Futures API
const baseUrl = 'https://fapi.binance.com';

export async function POST(request: NextRequest) {
  try {
    const { apiKey, apiSecret } = await request.json();

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { connected: false, error: 'API密钥和密钥不能为空' },
        { status: 400 }
      );
    }

    // 测试连接 - 获取账户信息
    const timestamp = Date.now();
    const recvWindow = 60000; // 60秒窗口
    const queryString = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(
        `${baseUrl}/fapi/v2/account?${queryString}&signature=${signature}`,
        {
          headers: {
            'X-MBX-APIKEY': apiKey,
          },
          signal: controller.signal,
        }
      );

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json();
        let errorMsg = errorData.msg || '连接失败';

        // 提供更详细的错误提示
        if (errorMsg.includes('Invalid API-key') || errorMsg.includes('IP')) {
          errorMsg += '\n\n请检查：\n1. API Key和Secret是否正确\n2. 是否在Binance测试网后台添加了IP白名单\n3. API权限是否包含"启用期货"';
        }

        return NextResponse.json({
          connected: false,
          error: errorMsg,
        });
      }

      const data = await response.json();
      return NextResponse.json({
        connected: true,
        balance: parseFloat(data.totalWalletBalance || '0'),
      });
    } catch (fetchError: any) {
      clearTimeout(timeoutId);

      if (fetchError.name === 'AbortError') {
        return NextResponse.json({
          connected: false,
          error: '连接超时，请检查网络或API密钥',
        });
      }

      throw fetchError;
    }
  } catch (error: any) {
    console.error('Binance connection error:', error);
    return NextResponse.json(
      {
        connected: false,
        error: error.message || '连接错误',
      },
      { status: 500 }
    );
  }
}
