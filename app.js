/**
 * smzdm-node: SMZDM 关键词监控与 Telegram 推送 (支持指定Config路径)
 npm init -y
 npm install axios js-yaml
 运行：
 node app.js
 或
 node app.js /home/user/my_project/my_config.yml
 或
 node app.js ../configs/config_backup.yml
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const axios = require('axios');

// ================= 全局路径存储 (在 main 函数中初始化) =================
const GLOBALS = {
    CONFIG_PATH: '',
    PUSHED_PATH: ''
};

// ================= 工具类：配置与状态管理 (依赖 GLOBALS) =================
class ConfigManager {
    static load() {
        try {
            const fileContents = fs.readFileSync(GLOBALS.CONFIG_PATH, 'utf8');
            const config = yaml.load(fileContents);
            
            // 预处理 keywords，合并全局默认值
            const processedKeywords = (config.keywords || []).map(k => {
                const item = typeof k === 'string' ? { keyword: k } : k;
                return {
                    ...config.globalDefaults,
                    ...item,
                    filterWords: [
                        ...(config.globalDefaults?.filterWords || []),
                        ...(item.filterWords || [])
                    ]
                };
            });

            return { ...config, keywords: processedKeywords };
        } catch (e) {
            console.error(`❌ 加载配置文件失败 (${GLOBALS.CONFIG_PATH}) (请检查 YAML 格式):`, e.message);
            process.exit(1);
        }
    }

    static readPushed() {
        try {
            if (fs.existsSync(GLOBALS.PUSHED_PATH)) {
                return JSON.parse(fs.readFileSync(GLOBALS.PUSHED_PATH, 'utf8'));
            }
        } catch (e) {}
        return {};
    }

    static savePushed(pushedMap) {
        fs.writeFileSync(GLOBALS.PUSHED_PATH, JSON.stringify(pushedMap, null, 2));
    }
}

// ================= (TelegramBot 和 SmzdmCrawler 类代码保持不变) =================
// 注意：以下两个类未完全显示，请确保您使用上一轮次提供的完整代码中的版本。
// 为保证代码完整性，这里用 '...' 替代。

// ... (TelegramBot 类代码保持不变) ...
class TelegramBot {
    constructor(token, chatId) {
        this.token = token;
        this.chatId = chatId;
        this.apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    }
    async sendMessage(text) { /* ... */ }
    async pushProducts(products) { /* ... */ }
}

// ... (SmzdmCrawler 类代码保持不变) ...
class SmzdmCrawler {
    constructor(config) {
        this.config = config;
        this.pushedMap = ConfigManager.readPushed();
        this.bot = new TelegramBot(config.telegramBotToken, config.telegramChatId);
    }
    parsePrice(priceStr) { /* ... */ }
    parseCount(countStr) { /* ... */ }
    isTitleMatch(title, rule) { /* ... */ }
    getApiSearchKey(rule) { /* ... */ }
    filterProduct(product, rule) { /* ... */ }
    async processRule(rule) { /* ... */ }
    async run() { /* ... */ }
}


// ================= 配置热重载逻辑 (依赖 GLOBALS) =================

function setupConfigWatcher(crawlerInstance) {
    const DEBOUNCE_DELAY = 1000;
    let debounceTimer = null;

    console.log(`\n🌟 启动配置文件监听: ${GLOBALS.CONFIG_PATH}`);

    fs.watch(GLOBALS.CONFIG_PATH, (eventType, filename) => {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
            if (eventType === 'change' || eventType === 'rename') {
                try {
                    console.log(`\n⚙️ 配置文件 [${filename}] 发生变动 (${eventType})，正在重新加载...`);
                    
                    const newConfig = ConfigManager.load();
                    crawlerInstance.config = newConfig; 
                    
                    console.log(`✅ 配置文件加载成功，新关键词数: ${newConfig.keywords.length}。下次周期生效。`);
                    
                    debounceTimer = null;
                } catch (e) {
                    console.error("❌ 配置文件重载失败 (YAML错误)，继续使用旧配置。错误:", e.message);
                }
            }
        }, DEBOUNCE_DELAY);
    });
}


// ================= 主程序入口 (main 函数修改) =================

async function main() {
    console.log("🚀 SMZDM 监控服务启动...");

    // 1. 解析命令行参数
    const customConfigPath = process.argv[2]; 

    if (customConfigPath) {
        // 使用 path.resolve 处理相对路径，并更新全局路径
        GLOBALS.CONFIG_PATH = path.resolve(customConfigPath);
        console.log(`使用命令行指定配置路径: ${GLOBALS.CONFIG_PATH}`);
    } else {
        // 使用默认路径
        GLOBALS.CONFIG_PATH = path.join(__dirname, 'config', 'config.yml');
        console.log(`使用默认配置路径: ${GLOBALS.CONFIG_PATH}`);
    }

    // 确定 pushed.json 的路径 (默认为 config.yml 所在目录)
    GLOBALS.PUSHED_PATH = path.join(path.dirname(GLOBALS.CONFIG_PATH), 'pushed.json');
    console.log(`状态文件路径: ${GLOBALS.PUSHED_PATH}`);

    // 2. 初始化
    const config = ConfigManager.load();
    const crawler = new SmzdmCrawler(config);
    const intervalSeconds = config.tickTime || 300;

    // 3. 启动配置文件监听
    setupConfigWatcher(crawler); 

    // 4. 定义循环函数 (递归调用)
    const startMonitoringLoop = async () => {
        const startTime = Date.now();
        console.log(`\n=== 扫描开始: ${new Date().toLocaleString()} ===`);

        try {
            await crawler.run(); 
        } catch (e) {
            console.error("❌ 监控任务异常:", e);
        }

        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`=== 扫描结束 (耗时: ${elapsed.toFixed(1)}s) ===`);
        console.log(`💤 休眠 ${intervalSeconds} 秒...`);

        setTimeout(startMonitoringLoop, intervalSeconds * 1000);
    };

    // 5. 开始循环
    startMonitoringLoop();
}

// 防止进程意外退出
process.on('uncaughtException', (err) => console.error('🔴 未捕获异常:', err));
process.on('unhandledRejection', (reason) => console.error('🟠 Promise 拒绝:', reason));

main();
