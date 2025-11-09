const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://fxkiller.com';
const SUBMITTED_HISTORY_FILE = path.join(__dirname, '../.google-submitted-urls.json');

// 从环境变量或本地文件读取密钥
function getServiceAccountKey() {
  // 优先使用环境变量（GitHub Actions）
  if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    try {
      const keyString = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
      // 尝试解析 JSON
      const key = JSON.parse(keyString);

      console.log('✅ 从环境变量加载密钥成功');
      console.log(`   Type: ${key.type}`);
      console.log(`   Project ID: ${key.project_id}`);
      console.log(`   Client Email: ${key.client_email}`);
      console.log(`   Private Key ID: ${key.private_key_id}`);
      console.log(`   Private Key 长度: ${key.private_key ? key.private_key.length : 0}`);
      console.log(`   Private Key 开头: ${key.private_key ? key.private_key.substring(0, 50) : 'null'}`);

      return key;
    } catch (error) {
      console.error('❌ 解析环境变量失败:', error.message);
      throw new Error('环境变量 GOOGLE_SERVICE_ACCOUNT_KEY 格式错误');
    }
  }

  // 本地开发使用文件
  const KEY_FILE = path.join(__dirname, '../public/cryptocashcontrol-a101c084ca74.json');
  if (fs.existsSync(KEY_FILE)) {
    console.log('✅ 从本地文件加载密钥成功');
    return JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
  }

  throw new Error('❌ 未找到 Google Service Account 密钥');
}

// 加载已提交的 URL 历史
function loadSubmittedHistory() {
  if (fs.existsSync(SUBMITTED_HISTORY_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SUBMITTED_HISTORY_FILE, 'utf8'));
      return new Set(data.urls || []);
    } catch (error) {
      console.warn('⚠️  读取提交历史失败，将创建新文件');
      return new Set();
    }
  }
  return new Set();
}

// 保存已提交的 URL 历史
function saveSubmittedHistory(submittedUrls) {
  const data = {
    urls: Array.from(submittedUrls),
    lastUpdated: new Date().toISOString()
  };
  fs.writeFileSync(SUBMITTED_HISTORY_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// 获取所有新闻文章的 URL
function getAllNewsUrls() {
  const newsDir = path.join(__dirname, '../src/content/news');

  if (!fs.existsSync(newsDir)) {
    console.log('❌ 新闻目录不存在');
    return [];
  }

  const folders = fs.readdirSync(newsDir).filter(item => {
    const itemPath = path.join(newsDir, item);
    return fs.statSync(itemPath).isDirectory();
  });

  const urls = [];
  folders.forEach(slug => {
    urls.push(`${BASE_URL}/zh/news/${slug}`);
    urls.push(`${BASE_URL}/en/news/${slug}`);
  });

  return urls;
}

// 提交单个 URL 到 Google
async function submitUrlToGoogle(jwtClient, url) {
  try {
    const indexing = google.indexing({ version: 'v3', auth: jwtClient });

    const response = await indexing.urlNotifications.publish({
      requestBody: {
        url: url,
        type: 'URL_UPDATED'
      }
    });

    console.log(`✅ 已提交: ${url}`);
    return response;
  } catch (error) {
    console.error(`❌ 提交失败 ${url}:`, error.message);
    return null;
  }
}

// 主函数
async function main() {
  console.log('📡 开始提交 URL 到 Google Search Console...\n');

  try {
    // 获取服务账号密钥
    const key = getServiceAccountKey();

    console.log('\n🔐 开始创建 JWT 客户端...');

    // 创建 JWT 客户端 - 使用完整的 credentials 对象
    const jwtClient = new google.auth.JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: ['https://www.googleapis.com/auth/indexing'],
    });

    console.log('✅ JWT 客户端创建成功');

    // 授权
    console.log('🔑 开始授权...');
    await jwtClient.authorize();
    console.log('✅ Google API 授权成功\n');

    // 加载已提交的 URL 历史
    const submittedUrls = loadSubmittedHistory();
    console.log(`📚 已提交历史记录: ${submittedUrls.size} 个 URL\n`);

    // 获取所有新闻 URL
    const allUrls = getAllNewsUrls();

    if (allUrls.length === 0) {
      console.log('ℹ️  没有找到需要提交的文章');
      return;
    }

    // 过滤出未提交的 URL
    const newUrls = allUrls.filter(url => !submittedUrls.has(url));

    console.log(`📊 URL 统计:`);
    console.log(`  - 总计: ${allUrls.length}`);
    console.log(`  - 已提交: ${submittedUrls.size}`);
    console.log(`  - 待提交: ${newUrls.length}\n`);

    if (newUrls.length === 0) {
      console.log('✨ 所有 URL 已经提交过了');
      return;
    }

    // 批量提交（Google 每天限制 200 个）
    const maxUrls = Math.min(newUrls.length, 200);
    let successCount = 0;
    let failCount = 0;

    console.log(`🚀 开始提交 ${maxUrls} 个新 URL...\n`);

    for (let i = 0; i < maxUrls; i++) {
      const url = newUrls[i];
      const result = await submitUrlToGoogle(jwtClient, url);

      if (result) {
        successCount++;
        submittedUrls.add(url); // 添加到已提交列表
      } else {
        failCount++;
      }

      // 添加延迟避免速率限制（每秒最多 1 个请求）
      if (i < maxUrls - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 保存已提交的 URL 历史
    saveSubmittedHistory(submittedUrls);

    console.log('\n📊 提交统计:');
    console.log(`  ✅ 成功: ${successCount}`);
    console.log(`  ❌ 失败: ${failCount}`);
    console.log(`  📝 本次提交: ${maxUrls}`);
    console.log(`  💾 已保存历史记录`);

    if (newUrls.length > 200) {
      console.log(`\n⚠️  注意: Google 每天限制 200 个 URL，剩余 ${newUrls.length - 200} 个未提交`);
      console.log(`💡 提示: 明天再运行脚本将自动提交剩余的 URL`);
    }

  } catch (error) {
    console.error('❌ 执行失败:', error.message);
    console.error('   完整错误:', error.stack || error);
    if (error.message.includes('未找到')) {
      console.log('\n💡 提示:');
      console.log('  - 本地开发: 将密钥文件放在 public/cryptocashcontrol-a101c084ca74.json');
      console.log('  - GitHub Actions: 设置 GOOGLE_SERVICE_ACCOUNT_KEY 环境变量');
    }
    process.exit(1);
  }
}

main();
