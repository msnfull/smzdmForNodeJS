/**
 npm init -y
 npm install axios js-yaml
 运行：
 node app.js
 或
 node app.js /home/user/my_project/my_config.yml
 或
 node app.js ../configs/config_backup.yml
 */
/**
 * smzdm-node: SMZDM 关键词监控与 Telegram 推送 (支持指定Config路径、配置热重载、历史记录限制、中文空关键词占位符)
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const axios = require('axios');

// ================= 全局常量 =================
const PUSHED_HISTORY_LIMIT = 5000;
const EMPTY_KEYWORD_PLACEHOLDER = "空关键词"; // 新增的占位符

// 全局路径存储 (在 main 函数中初始化)
const GLOBALS = {
    CONFIG_PATH: '',
    PUSHED_PATH: ''
};

// ================= 工具类：配置与状态管理 =================
class ConfigManager {
    static load() {
        try {
            const fileContents = fs.readFileSync(GLOBALS.CONFIG_PATH, 'utf8');
            const config = yaml.load(fileContents);
            
            // 预处理 keywords，合并全局默认值
            const processedKeywords = (config.keywords || []).map(k => {
                const item = typeof k === 'string' ? { keyword: k } : k;
                
                // --- 新增逻辑：将中文占位符替换为真正的空字符串 ---
                if (item.keyword === EMPTY_KEYWORD_PLACEHOLDER) {
                    item.keyword = "";
                }
                // --------------------------------------------------

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
        } catch (e) {
            console.error("读取 pushed.json 错误，将创建新的空文件:", e.message);
        }
        return {};
    }

    static savePushed(pushedMap) {
        let keys = Object.keys(pushedMap);
        
        if (keys.length > PUSHED_HISTORY_LIMIT) {
            console.log(`[PushHistory] 记录数 (${keys.length}) 超过限制 (${PUSHED_HISTORY_LIMIT})，开始清理旧记录...`);

            const historyArray = Object.entries(pushedMap);
            historyArray.sort((a, b) => a[1] - b[1]); 

            const startIndex = historyArray.length - PUSHED_HISTORY_LIMIT;
            const trimmedArray = historyArray.slice(startIndex);

            const trimmedMap = Object.fromEntries(trimmedArray);

            console.log(`[PushHistory] 已移除 ${keys.length - trimmedArray.length} 条旧记录。`);
            fs.writeFileSync(GLOBALS.PUSHED_PATH, JSON.stringify(trimmedMap, null, 2));
        } else {
            fs.writeFileSync(GLOBALS.PUSHED_PATH, JSON.stringify(pushedMap, null, 2));
        }
    }
}

// ================= 工具类：Telegram 推送 =================
class TelegramBot {
    constructor(token, chatId) {
        this.token = token;
        this.chatId = chatId;
        this.apiUrl = `https://api.telegram.org/bot${token}/sendMessage`;
    }
    async sendMessage(text) {
        if (!text) return;
        try {
            const payload = {
                chat_id: this.chatId,
                text: text,
                parse_mode: "Markdown", 
                disable_web_page_preview: true
            };
            await axios.post(this.apiUrl, payload);
            console.log(`[Telegram] 消息发送成功`);
        } catch (error) {
            console.error(`[Telegram] 发送失败: ${error.response ? error.response.data.description : error.message}`);
        }
    }

    async pushProducts(products) {
        if (!products || products.length === 0) return;

        let msg = "【好物推荐】\n";
        products.forEach(item => {
            const title = item.article_title.replace(/[\[\]]/g, ''); 
            msg += `[${title}](${item.article_url}) \- *${item.article_price}*\n\n`;
        });

        await this.sendMessage(msg);
    }
}

// ================= 核心业务：爬虫与过滤 =================
class SmzdmCrawler {
    constructor(config) {
        this.config = config;
        this.pushedMap = ConfigManager.readPushed();
        this.bot = new TelegramBot(config.telegramBotToken, config.telegramChatId);
    }

    parsePrice(priceStr) {
        if (!priceStr) return 0;
        const match = priceStr.match(/[0-9.]+/);
        return match ? parseFloat(match[0]) : 0;
    }

    parseCount(countStr) {
        if (!countStr) return 0;
        let str = countStr.toString().toLowerCase();
        if (str.includes('k') || str.includes('万')) {
            return parseFloat(str) * 1000;
        }
        return parseInt(str) || 0;
    }

    isTitleMatch(title, rule) {
        const key = rule.keyword;
        if (!key || key === "") return true; 

        if (key.startsWith('re:')) {
            let pattern = key.substring(3);
            let flags = '';
            if (pattern.includes('(?i)')) {
                pattern = pattern.replace('(?i)', '');
                flags = 'i';
            }
            try {
                return new RegExp(pattern, flags).test(title);
            } catch (e) {
                console.error(`正则错误 [${key}]:`, e.message);
                return false;
            }
        }
        return title.toLowerCase().includes(key.toLowerCase());
    }

    getApiSearchKey(rule) {
        if (rule.searchKey !== undefined) return rule.searchKey;
        
        if (rule.keyword && rule.keyword.startsWith('re:')) {
            const clean = rule.keyword.replace('re:', '').replace(/\(\?i\)/, '');
            const match = clean.match(/[\u4e00-\u9fa5a-zA-Z0-9]+/);
            return match ? match[0] : "";
        }

        return rule.keyword; 
    }

    filterProduct(product, rule) {
        const item = {
            article_title: product.article_title,
            article_price: product.article_price,
            article_worthy: product.article_worthy,
            article_comment: product.article_comment,
            article_id: product.article_id,
            publish_date_lt: product.publish_date_lt,
            article_url: product.article_url
        };

        // 1. 去重和时间
        if (this.pushedMap[item.article_id]) return null;
        
        const itemDate = new Date(parseInt(item.publish_date_lt) * 1000);
        const limitDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); 
        if (itemDate < limitDate) return null;

        // 2. 过滤词
        if (rule.filterWords) {
            for (const badWord of rule.filterWords) {
                if (item.article_title.includes(badWord)) return null;
            }
        }

        // 3. 标题匹配
        if (!this.isTitleMatch(item.article_title, rule)) return null;

        // 4. 阈值检查
        const price = this.parsePrice(item.article_price);
        const comments = this.parseCount(item.article_comment);
        const worthy = this.parseCount(item.article_worthy);

        if (rule.minPrice && price < rule.minPrice) return null;
        if (rule.maxPrice && price > rule.maxPrice) return null;
        if (comments < (rule.lowCommentNum || 0)) return null;
        if (worthy < (rule.lowWorthyNum || 0)) return null;

        return item;
    }

    async processRule(rule) {
        const searchKey = this.getApiSearchKey(rule);
        
        const isHomepage = (searchKey === "" || searchKey === undefined);
        const logKey = isHomepage ? "[首页/全站]" : `[${searchKey}]`;
        
        console.log(`>>> 正在扫描: ${logKey}`);

        let foundItems = [];
        let page = 0;
        
        while (page < 5) { 
            try {
                const res = await axios.get("https://api.smzdm.com/v1/list", {
                    params: {
                        keyword: searchKey,
                        order: 'time',
                        type: 'good_price',
                        offset: page * 100,
                        limit: 100
                    },
                    headers: { 'User-Agent': 'Smzdm/10.4.20 RV/136 (iPhone; iOS 16.2; zh_CN)' },
                    timeout: 8000
                });

                const rows = res.data?.data?.rows;
                if (!rows || rows.length === 0) break;

                for (const row of rows) {
                    const validItem = this.filterProduct(row, rule);
                    if (validItem) {
                        foundItems.push(validItem);
                        this.pushedMap[validItem.article_id] = Date.now();
                        
                        const commentStr = validItem.article_comment || "0";
                        console.log(`  + 命中(${commentStr}评): ${validItem.article_title}`);
                    }
                }
            } catch (err) {
                console.error(`  - 请求出错 ${logKey}: ${err.message}`);
            }

            if (foundItems.length >= this.config.satisfyNum) break;
            page++;
            await new Promise(r => setTimeout(r, 1500)); 
        }
        return foundItems;
    }

    async run() {
        let allNewProducts = [];
        for (const rule of this.config.keywords) {
            const products = await this.processRule(rule);
            allNewProducts = allNewProducts.concat(products);
        }

        if (allNewProducts.length > 0) {
            console.log(`\n发现 ${allNewProducts.length} 个新商品，推送中...`);
            ConfigManager.savePushed(this.pushedMap);
            await this.bot.pushProducts(allNewProducts);
        } else {
            console.log("暂无新发现。");
        }
    }
}


// ================= 配置热重载逻辑 =================

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


// ================= 主程序入口 =================

async function main() {
    console.log("🚀 SMZDM 监控服务启动...");

    const customConfigPath = process.argv[2]; 

    if (customConfigPath) {
        GLOBALS.CONFIG_PATH = path.resolve(customConfigPath);
        console.log(`使用命令行指定配置路径: ${GLOBALS.CONFIG_PATH}`);
    } else {
        GLOBALS.CONFIG_PATH = path.join(__dirname, 'config', 'config.yml');
        console.log(`使用默认配置路径: ${GLOBALS.CONFIG_PATH}`);
    }

    GLOBALS.PUSHED_PATH = path.join(path.dirname(GLOBALS.CONFIG_PATH), 'pushed.json');
    console.log(`状态文件路径: ${GLOBALS.PUSHED_PATH}`);

    // 2. 初始化
    const config = ConfigManager.load();
    const crawler = new SmzdmCrawler(config);
    const intervalSeconds = config.tickTime || 300;
    
    // --- 诊断代码：最终确认关键词列表是否被正确加载 ---
    if (config.keywords.length === 0) {
        console.error("❌ 严重错误：关键词列表为空。请检查 config.yml 结构。");
        console.log("-------------------------------------------------------");
    }
    // ----------------------------------------------------

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
