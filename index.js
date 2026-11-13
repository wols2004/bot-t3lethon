
const {
    default: makeWASocket,
    useMultiFileAuthState,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
    Browsers,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const { Telegraf, Markup } = require('telegraf');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

process.env.DEBUG = '';
process.env.NODE_DEBUG = '';
process.env.BAILEYS_LOG_LEVEL = 'fatal';

// ==========================================
// ⚙️ الإعدادات - كل المتغيرات هنا في الكود مباشرة
// ==========================================
const BOT_TOKEN = '8771928057:AAED_DMr2bpyKZm19L3t7iDUdAUMRyxjh60';
const ADMIN_ID = 1785091570; // ID التليجرام بتاعك
const PAIRING_CODE_ID = 'MARWAN17';
const PORT = 3000;

const CREDITS = `\n\n╭──────────────╮\n│ 👑 *✨ 𝓜𝓪𝓻𝓸 ✨* │\n│ ✈️ *TG: @HY_09* │\n╰──────────────╯`;

// ==========================================
// ⏱️ دوال مساعدة لمنع التجميد (Timeouts & Non-blocking)
// ==========================================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const yieldLoop = () => new Promise(r => setImmediate(r));

function withTimeout(promise, ms, errMsg = 'انتهت مهلة العملية') {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(errMsg)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// ==========================================
// 🌐 السيرفر (للـ hosting)
// ==========================================
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('WhatsApp Bot ONLINE\n');
}).listen(PORT, () => console.log(`🌐 السيرفر شغال على بورت ${PORT}`));

// ==========================================
// 📁 المجلدات
// ==========================================
const sessionsDir = path.join(__dirname, 'sessions');
const pluginsDir  = path.join(__dirname, 'plugins');

[sessionsDir, pluginsDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// 🗂️ نفس مكان التخزين اللي بيستخدمه message-store.js وanti-delete/anti-edit
let storeDir;
try {
    ({ tempDir: storeDir } = require(path.join(pluginsDir, 'message-store.js')));
} catch (_) {
    storeDir = path.join(__dirname, 'temp_store');
}
if (!fs.existsSync(storeDir)) { try { fs.mkdirSync(storeDir, { recursive: true }); } catch (_) {} }

// ==========================================
// 🗄️ قاعدة البيانات (SQLite عن طريق sql.js - WASM، من غير أي كومبايل C++)
// ==========================================
const initSqlJs = require('sql.js');
const dbFile = path.join(__dirname, 'bot.db');
let db = null;
let dbSaveTimer = null;

async function initDb() {
    const SQL = await initSqlJs();
    if (fs.existsSync(dbFile)) {
        try {
            db = new SQL.Database(fs.readFileSync(dbFile));
        } catch (e) {
            console.error('⚠️ فشل تحميل bot.db، هيتعمل ملف جديد:', e.message);
            db = new SQL.Database();
        }
    } else {
        db = new SQL.Database();
    }
    db.run(`
    CREATE TABLE IF NOT EXISTS users (
        cid TEXT PRIMARY KEY,
        number TEXT UNIQUE,
        linked_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );
    CREATE TABLE IF NOT EXISTS paid_users (
        user_id TEXT PRIMARY KEY,
        added_at TEXT
    );
    CREATE TABLE IF NOT EXISTS force_sub (
        chat_ref TEXT PRIMARY KEY,
        title TEXT,
        added_at TEXT
    );
    CREATE TABLE IF NOT EXISTS bot_users (
        cid TEXT PRIMARY KEY,
        seen_at TEXT
    );
    `);
    persistDb();
}

function persistDb() {
    if (dbSaveTimer) return;
    dbSaveTimer = setTimeout(() => {
        dbSaveTimer = null;
        try {
            const data = Buffer.from(db.export());
            fs.promises.writeFile(dbFile, data).catch(e => console.error('❌ خطأ في حفظ قاعدة البيانات:', e.message));
        } catch (e) {
            console.error('❌ خطأ في تصدير قاعدة البيانات:', e.message);
        }
    }, 300);
}

function dbRun(sql, params = []) {
    const stmt = db.prepare(sql);
    try { stmt.bind(params); stmt.step(); } finally { stmt.free(); }
    persistDb();
}
function dbGet(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
        stmt.bind(params);
        return stmt.step() ? stmt.getAsObject() : null;
    } finally { stmt.free(); }
}
function dbAll(sql, params = []) {
    const stmt = db.prepare(sql);
    const rows = [];
    try {
        stmt.bind(params);
        while (stmt.step()) rows.push(stmt.getAsObject());
    } finally { stmt.free(); }
    return rows;
}

// ─── إعدادات عامة (بتفضل زي ما هي بعد أي ريستارت) ───
const q = {
    getSetting: (key) => dbGet('SELECT value FROM settings WHERE key = ?', [key]),
    setSetting: (key, val) => dbRun(
        `INSERT INTO settings(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, val]),
    getUserByCid: (cid) => dbGet('SELECT * FROM users WHERE cid = ?', [cid]),
    getUserByNumber: (num) => dbGet('SELECT * FROM users WHERE number = ?', [num]),
    upsertUser: (cid, num, at) => dbRun(
        `INSERT INTO users(cid, number, linked_at) VALUES(?, ?, ?)
         ON CONFLICT(cid) DO UPDATE SET number = excluded.number, linked_at = excluded.linked_at`, [cid, num, at]),
    deleteUserByCid: (cid) => dbRun('DELETE FROM users WHERE cid = ?', [cid]),
    deleteUserByNumber: (num) => dbRun('DELETE FROM users WHERE number = ?', [num]),
    countUsers: () => dbGet('SELECT COUNT(*) c FROM users'),
    allUsers: () => dbAll('SELECT * FROM users'),
    addPaid: (id, at) => dbRun(
        `INSERT INTO paid_users(user_id, added_at) VALUES(?, ?)
         ON CONFLICT(user_id) DO NOTHING`, [id, at]),
    delPaid: (id) => dbRun('DELETE FROM paid_users WHERE user_id = ?', [id]),
    isPaid: (id) => dbGet('SELECT 1 v FROM paid_users WHERE user_id = ?', [id]),
    allPaid: () => dbAll('SELECT * FROM paid_users'),
    addForceSub: (ref, title, at) => dbRun(
        `INSERT INTO force_sub(chat_ref, title, added_at) VALUES(?, ?, ?)
         ON CONFLICT(chat_ref) DO UPDATE SET title = excluded.title`, [ref, title, at]),
    delForceSub: (ref) => dbRun('DELETE FROM force_sub WHERE chat_ref = ?', [ref]),
    allForceSub: () => dbAll('SELECT * FROM force_sub'),
    trackBotUser: (cid, at) => dbRun(
        `INSERT INTO bot_users(cid, seen_at) VALUES(?, ?)
         ON CONFLICT(cid) DO NOTHING`, [cid, at]),
    delBotUser: (cid) => dbRun('DELETE FROM bot_users WHERE cid = ?', [String(cid)]),
    allBotUsers: () => dbAll('SELECT * FROM bot_users')
};

function getSetting(key, def = null) {
    const row = q.getSetting(key);
    return row ? row.value : def;
}
function setSetting(key, val) { q.setSetting(key, String(val)); }

function getBotMode() { return getSetting('bot_mode', 'free'); }
function setBotMode(mode) { setSetting('bot_mode', mode); }

// ==========================================
// 👥 إدارة المستخدمين (SQL بدل JSON)
// ==========================================
function getUserNumber(cid) {
    const row = q.getUserByCid(String(cid));
    return row ? row.number : null;
}
function isNumberRegistered(num) {
    const clean = num.replace(/\D/g, '');
    return !!q.getUserByNumber(clean);
}
function getCidByNumber(num) {
    const clean = num.replace(/\D/g, '');
    const row = q.getUserByNumber(clean);
    return row ? row.cid : null;
}
function setUserNumber(cid, num) {
    const clean = num.replace(/\D/g, '');
    const cidStr = String(cid);
    const existing = q.getUserByNumber(clean);
    if (existing && existing.cid !== cidStr) q.deleteUserByCid(existing.cid);
    q.upsertUser(cidStr, clean, new Date().toLocaleString('ar-EG'));
}
function removeUser(cid) { q.deleteUserByCid(String(cid)); }
function removeUserByNumber(number) {
    const clean = number.replace(/\D/g, '');
    q.deleteUserByNumber(clean);
}
function isAdmin(ctx) { return ctx.chat?.id === ADMIN_ID || ctx.from?.id === ADMIN_ID; }
function trackBotUser(cid) {
    try { q.trackBotUser(String(cid), new Date().toLocaleString('ar-EG')); } catch (_) {}
}

// ─── مستخدمين مدفوعين (وضع البوت المدفوع) ───
function addPaidUser(id) { q.addPaid(String(id), new Date().toLocaleString('ar-EG')); }
function removePaidUser(id) { q.delPaid(String(id)); }
function isPaidUser(id) { return !!q.isPaid(String(id)); }

// ─── قنوات/جروبات الاشتراك الإجباري ───
function addForceSub(ref, title) { q.addForceSub(ref, title || ref, new Date().toLocaleString('ar-EG')); }
function removeForceSub(ref) { q.delForceSub(ref); }
function listForceSub() { return q.allForceSub(); }

// ==========================================
// 🧹 تنظيف تلقائي غير متزامن (Non-blocking) عشان ميوقفش التليجرام أبداً
// ==========================================
const STORE_TTL_MS = 25 * 60 * 60 * 1000;
const CLEAN_EVERY_MS = 60 * 60 * 1000;

async function cleanOldStoreFiles() {
    const now = Date.now();
    if (!fs.existsSync(storeDir)) return;
    try {
        const folders = await fs.promises.readdir(storeDir);
        for (const folder of folders) {
            const fp = path.join(storeDir, folder);
            let st;
            try { st = await fs.promises.stat(fp); } catch (_) { continue; }
            if (!st.isDirectory()) continue;

            const files = await fs.promises.readdir(fp).catch(() => []);
            for (let i = 0; i < files.length; i++) {
                const fileFp = path.join(fp, files[i]);
                try {
                    const fst = await fs.promises.stat(fileFp);
                    if (now - fst.mtimeMs > STORE_TTL_MS) {
                        await fs.promises.unlink(fileFp);
                    }
                } catch (_) {}
                if (i % 50 === 0) await yieldLoop();
            }
            try {
                const rem = await fs.promises.readdir(fp);
                if (rem.length === 0) await fs.promises.rmdir(fp);
            } catch (_) {}
            await yieldLoop();
        }
    } catch (_) {}
}
setInterval(() => { cleanOldStoreFiles().catch(() => {}); }, CLEAN_EVERY_MS);

async function calcStoreSizeAsync() {
    let storeSize = 0;
    if (!fs.existsSync(storeDir)) return 0;
    try {
        const folders = await fs.promises.readdir(storeDir);
        for (const f of folders) {
            const fp = path.join(storeDir, f);
            let st;
            try { st = await fs.promises.stat(fp); } catch (_) { continue; }
            if (!st.isDirectory()) continue;
            const files = await fs.promises.readdir(fp).catch(() => []);
            for (let i = 0; i < files.length; i++) {
                try {
                    const fst = await fs.promises.stat(path.join(fp, files[i]));
                    storeSize += fst.size;
                } catch (_) {}
                if (i % 100 === 0) await yieldLoop();
            }
        }
    } catch (_) {}
    return storeSize;
}

// ==========================================
// 🔌 تحميل البلجنز (بكاش عشان الرام والسي بي يو)
// ==========================================
const pluginCache = new Map(); // filename -> { mtime, module }
function loadPlugins() {
    let files = [];
    try { files = fs.readdirSync(pluginsDir).filter(f => f.endsWith('.js')); } catch (_) {}
    for (const file of files) {
        const fp = path.join(pluginsDir, file);
        let mtime;
        try { mtime = fs.statSync(fp).mtimeMs; } catch (_) { continue; }
        const cached = pluginCache.get(file);
        if (!cached || cached.mtime !== mtime) {
            try {
                delete require.cache[require.resolve(fp)];
                const mod = require(fp);
                pluginCache.set(file, { mtime, module: mod });
            } catch (e) {
                console.error(`❌ خطأ في بلجن ${file}:`, e.message);
            }
        }
    }
    for (const key of [...pluginCache.keys()]) {
        if (!files.includes(key)) pluginCache.delete(key);
    }
    const list = [...pluginCache.entries()].map(([file, v]) => ({ file, ...v.module }));
    // ضمان تشغيل message-store ثم mute الأول دايماً قبل باقي البلجنز
    const priority = (p) => {
        if (p.name === 'message-store' || p.file === 'message-store.js') return 0;
        if (p.name === 'mute' || p.file === 'mute.js') return 1;
        return 2;
    };
    list.sort((a, b) => priority(a) - priority(b));
    return list;
}

// ==========================================
// 🤖 بوت التليجرام (مع حماية ضد التوقف والتعليق)
// ==========================================
const tgAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    timeout: 30000
});

const bot = new Telegraf(BOT_TOKEN, {
    handlerTimeout: 300000,
    telegram: {
        agent: tgAgent,
        attachmentAgent: tgAgent
    }
});

// نسجّل أي حد يتفاعل مع البوت (حتى لو مربطش رقم) عشان الإذاعة توصله
bot.use(async (ctx, next) => {
    if (ctx.chat?.id) trackBotUser(ctx.chat.id);
    return next();
});
bot.catch((err) => console.error('❌ Telegram handler error:', err?.message || err));

const connectLock = new Set();
const userStates = new Map(); // cid -> { type }

// دالة آمنة للرد على أزرار الانلاين بدون رمي خطأ لو الزرار قديم
async function safeAnswerCb(ctx, text) {
    try { await ctx.answerCbQuery(text); } catch (_) {}
}

// زرار بلون (Bot API 9.4: style = primary/success/danger)
function cbtn(text, data, style) {
    const b = Markup.button.callback(text, data);
    if (style) b.style = style;
    return b;
}

async function safeEdit(ctx, text, extra = {}) {
    try {
        await ctx.editMessageText(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...extra });
    } catch (e) {
        if (e.description?.includes('message is not modified')) return;
        try { await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...extra }); } catch (_) {}
    }
}

function mainMenu(ctx) {
    const btns = [
        [cbtn('🔗 اربط رقمك', 'connect', 'success')],
        [cbtn('قطع الاتصال', 'disconnect', 'danger')],
        [cbtn('الأوامر المتاحة', 'show_commands', 'primary')],
        [cbtn('إزاي أستخدم البوت', 'explain_bot', 'primary')]
    ];
    if (isAdmin(ctx)) btns.push([cbtn('👑 لوحة الأدمن', 'admin_info', 'primary')]);
    return Markup.inlineKeyboard(btns);
}

// ==========================================
// 🔒 الاشتراك الإجباري (مع Timeout لمنع تعليق البوت)
// ==========================================
async function getMissingSubs(userId) {
    const list = listForceSub();
    if (!list.length) return [];
    const missing = [];
    await Promise.all(list.map(async (ch) => {
        try {
            const member = await withTimeout(bot.telegram.getChatMember(ch.chat_ref, userId), 5000);
            if (['left', 'kicked'].includes(member.status)) missing.push(ch);
        } catch (_) {
            // البوت مش قادر يتأكد أو التليجرام اتأخر - نتخطاها عشان البوت ميقفش
        }
    }));
    return missing;
}

function forceSubKeyboard(missing) {
    const rows = missing.map(ch => {
        const uname = ch.chat_ref.startsWith('@') ? ch.chat_ref.slice(1) : null;
        return uname
            ? [Markup.button.url(`📢 ${ch.title || ch.chat_ref}`, `https://t.me/${uname}`)]
            : [Markup.button.callback(`📢 ${ch.title || ch.chat_ref}`, 'noop')];
    });
    rows.push([cbtn('✅ اشتركت، كمّل', 'recheck_sub', 'success')]);
    return Markup.inlineKeyboard(rows);
}

async function requireSubscription(ctx) {
    const uid = ctx.from?.id;
    if (!uid || uid === ADMIN_ID) return true;
    const missing = await getMissingSubs(uid);
    if (!missing.length) return true;
    await ctx.reply(
        `⛔ *لسه ما اشتركتش في القنوات دي*\nاشترك الأول عشان تقدر تستخدم البوت` + CREDITS,
        { parse_mode: 'Markdown', ...forceSubKeyboard(missing) }
    ).catch(() => {});
    return false;
}

bot.action('recheck_sub', async (ctx) => {
    await safeAnswerCb(ctx);
    const missing = await getMissingSubs(ctx.from.id);
    if (missing.length) {
        return safeEdit(ctx, `⛔ *لسه فيه قنوات مش مشترك فيها*` + CREDITS, forceSubKeyboard(missing));
    }
    safeEdit(ctx, `✅ *تمام، اتأكدنا من اشتراكك*` + CREDITS, mainMenu(ctx));
});

bot.action('noop', async (ctx) => { await safeAnswerCb(ctx); });

// لو حد خرج من قناة اشتراك إجباري وهو رقمه مربوط، نقطع رقمه فوراً
bot.on('chat_member', async (ctx) => {
    try {
        const upd = ctx.chatMember;
        const chatUsername = ctx.chat.username ? `@${ctx.chat.username}` : null;
        const chatIdRef = String(ctx.chat.id);
        const list = listForceSub();
        const matched = list.find(c => c.chat_ref === chatUsername || c.chat_ref === chatIdRef);
        if (!matched) return;
        if (['left', 'kicked'].includes(upd.new_chat_member.status)) {
            const uid = upd.new_chat_member.user.id;
            const num = getUserNumber(uid);
            await cancelPairingsOfChat(uid);
            if (num) {
                await fullDisconnect(num);
                removeUser(uid);
                bot.telegram.sendMessage(uid,
                    `⚠️ *تم قطع رقمك* لأنك خرجت من "${matched.title}"\nاشترك تاني وابعت رقمك من الأول لو حابب.` + CREDITS,
                    { parse_mode: 'Markdown' }
                ).catch(() => {});
            }
        }
    } catch (_) {}
});

// ─── /start ───
bot.start(async (ctx) => {
    if (!(await requireSubscription(ctx))) return;
    const text =
        `أهلاً بيك في *بوت الواتساب* 👋\n\n` +
        `ده اللي هتقدر تعمله:\n` +
        `• تصيد الرسايل المحذوفة والمعدلة\n` +
        `• تسترجع الميديا اللي اتمسحت\n` +
        `• يشتغل في الجروبات والخاص\n` +
        (isAdmin(ctx) ? `\nأنت الأدمن هنا 👑\n` : '') +
        CREDITS;

    const photoPath = path.join(__dirname, '1.jpg');
    if (fs.existsSync(photoPath)) {
        try {
            return await ctx.replyWithPhoto({ source: photoPath }, {
                caption: text, parse_mode: 'Markdown', ...mainMenu(ctx)
            });
        } catch (_) {}
    }
    ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...mainMenu(ctx) }).catch(() => {});
});

bot.action('back', async (ctx) => {
    await safeAnswerCb(ctx);
    safeEdit(ctx, `القائمة الرئيسية` + CREDITS, mainMenu(ctx));
});

// ─── شرح البوت ───
bot.action('explain_bot', async (ctx) => {
    await safeAnswerCb(ctx);
    const videoPath = path.join(__dirname, 'ex.mp4');
    const textPath = path.join(__dirname, 'ex.txt');
    let caption = 'اربط رقمك من زرار "اربط رقمك" وابعت الرقم بالكود بتاع الدولة، وهيجيلك كود تدخله في واتساب.';
    if (fs.existsSync(textPath)) {
        try { caption = fs.readFileSync(textPath, 'utf-8').slice(0, 1024); } catch (_) {}
    }
    if (fs.existsSync(videoPath)) {
        try {
            return await ctx.replyWithVideo({ source: videoPath }, { caption: caption + CREDITS, parse_mode: 'Markdown' });
        } catch (_) {}
    }
    ctx.reply(caption + CREDITS, { parse_mode: 'Markdown' }).catch(() => {});
});

// ─── عرض الأوامر ───
bot.action('show_commands', async (ctx) => {
    await safeAnswerCb(ctx);
    const plugins = loadPlugins();
    let menu = `🕹️ *الأوامر المتاحة*\n\n`;
    let count = 1;
    for (const plugin of plugins) {
        if (plugin.command && Array.isArray(plugin.command)) {
            for (const cmd of plugin.command) { menu += `\`${count}.\` ${cmd}\n`; count++; }
        }
    }
    if (count === 1) menu += 'مفيش أوامر دلوقتي';
    menu += CREDITS;
    safeEdit(ctx, menu, Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'back', 'primary')]]));
});

// ─── ربط رقم ───
const backKb = (to = 'back') => Markup.inlineKeyboard([[cbtn('⬅️ رجوع', to, 'primary')]]);

async function promptForNumber(ctx) {
    const cid = ctx.chat.id;
    await cancelPairingsOfChat(cid);
    userStates.set(cid, { type: 'number' });
    return safeEdit(ctx,
        `ابعت رقم الواتساب دلوقتي مع كود الدولة\nمثال: \`201012345678\`` + CREDITS,
        backKb());
}

bot.action('connect', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!(await requireSubscription(ctx))) return;
    const cid = ctx.chat.id;
    const admin = isAdmin(ctx);

    if (!admin) {
        const existingNum = getUserNumber(cid);
        if (existingNum) {
            if (sessionState(existingNum) === 'paired') {
                return safeEdit(ctx,
                    `عندك رقم مربوط بالفعل: \`+${existingNum}\`\nتقدر تقطعه وتربط رقم جديد بضغطة واحدة.` + CREDITS,
                    Markup.inlineKeyboard([
                        [cbtn('🔌 اقطعه واربط رقم جديد', 'replace_number', 'danger')],
                        [cbtn('⬅️ رجوع', 'back', 'primary')]
                    ]));
            }
            await fullDisconnect(existingNum);
        }
        if (getBotMode() === 'paid' && !isPaidUser(cid)) {
            return safeEdit(ctx, `البوت في وضع مدفوع دلوقتي 💳\nكلم الأدمن يفعّلك الأول.` + CREDITS, backKb());
        }
    }
    return promptForNumber(ctx);
});

// قطع الرقم الحالي + بدء ربط جديد
bot.action('replace_number', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!(await requireSubscription(ctx))) return;
    const cid = ctx.chat.id;
    if (!isAdmin(ctx) && getBotMode() === 'paid' && !isPaidUser(cid)) {
        return safeEdit(ctx, `البوت في وضع مدفوع دلوقتي 💳\nكلم الأدمن يفعّلك الأول.` + CREDITS, backKb());
    }
    const num = getUserNumber(cid);
    if (num) await fullDisconnect(num);
    removeUser(cid);
    return promptForNumber(ctx);
});

// إلغاء عملية ربط شغالة
bot.action('cancel_pair', async (ctx) => {
    await safeAnswerCb(ctx);
    const cid = ctx.chat.id;
    userStates.delete(cid);
    const n = await cancelPairingsOfChat(cid);
    safeEdit(ctx,
        (n ? `✅ تم إلغاء عملية الربط ومسح بياناتها.` : `مفيش عملية ربط شغالة دلوقتي.`) + CREDITS,
        Markup.inlineKeyboard([
            [cbtn('🔗 اربط رقمك', 'connect', 'success')],
            [cbtn('⬅️ رجوع', 'back', 'primary')]
        ]));
});

// ─── قطع الاتصال ───
bot.action('disconnect', async (ctx) => {
    await safeAnswerCb(ctx);
    const cid = ctx.chat.id;
    userStates.delete(cid);

    if (isAdmin(ctx)) {
        const nums = listAllNumbers();
        if (!nums.length) {
            return safeEdit(ctx, `مفيش أرقام.` + CREDITS, backKb());
        }
        const btns = nums.map(s => [cbtn(`❌ +${s} ${numberStatus(s)}`, `admin_disc_${s}`, 'danger')]);
        btns.push([cbtn('⬅️ رجوع', 'back', 'primary')]);
        return safeEdit(ctx, `اختار الرقم اللي عايز تقطعه:\n✅ متصل | ⏳ ربط جاري | ⚠️ عالق | 🛑 موقوف` + CREDITS, Markup.inlineKeyboard(btns));
    }

    const userNum = getUserNumber(cid);
    const cancelled = await cancelPairingsOfChat(cid);
    if (!userNum) {
        return safeEdit(ctx,
            (cancelled ? `✅ تم إلغاء عملية الربط الجارية ومسح بياناتها.` : `مفيش رقم مربوط بحسابك.`) + CREDITS,
            Markup.inlineKeyboard([
                [cbtn('🔗 اربط رقمك', 'connect', 'success')],
                [cbtn('⬅️ رجوع', 'back', 'primary')]
            ]));
    }
    await fullDisconnect(userNum);
    removeUser(cid);
    safeEdit(ctx, `تم قطع الرقم \`+${userNum}\` ومسح كل بياناته ✅\nتقدر دلوقتي تربط رقم جديد.` + CREDITS,
        Markup.inlineKeyboard([
            [cbtn('🔗 اربط رقمك', 'connect', 'success')],
            [cbtn('⬅️ رجوع', 'back', 'primary')]
        ]));
});

async function adminDisconnectOne(num) {
    const owner = getCidByNumber(num);
    await fullDisconnect(num);
    if (owner && String(owner) !== String(ADMIN_ID)) {
        bot.telegram.sendMessage(owner,
            `⚠️ الأدمن قطع رقمك \`+${num}\`\nتقدر تربطه تاني من الزرار.` + CREDITS,
            { parse_mode: 'Markdown' }).catch(() => {});
    }
}

bot.action(/admin_disc_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    const num = ctx.match[1];
    await adminDisconnectOne(num);
    safeEdit(ctx, `تم قطع الرقم \`+${num}\` ومسح بياناته (جلسة + داتا بيز).` + CREDITS, backKb());
});

// ==========================================
// 👑 لوحة الأدمن
// ==========================================
function adminMenuKb() {
    return Markup.inlineKeyboard([
        [cbtn('📋 قائمة الأرقام', 'admin_list', 'primary')],
        [cbtn('🧹 تنظيف الأرقام العالقة', 'admin_cleanup', 'primary'), cbtn('🗑 مسح رقم يدوي', 'admin_wipe_number', 'danger')],
        [cbtn('📢 إذاعة ذكية', 'broadcast_start', 'success')],
        [cbtn('⚙️ حالة البوت', 'bot_mode_menu', 'primary')],
        [cbtn('🔒 الاشتراك الإجباري', 'force_sub_menu', 'primary')],
        [cbtn('🔄 تحديث', 'admin_info', 'primary')],
        [cbtn('⬅️ رجوع', 'back', 'primary')]
    ]);
}

bot.action('admin_info', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    const sessions = listConnectedSessions();
    const storeSize = await calcStoreSizeAsync();
    const txt = `📊 *لوحة التحكم*\n\n` +
        `مستخدمين البوت (تليجرام): *${q.allBotUsers().length}*\n` +
        `أرقام مربوطة: *${q.countUsers().c}*\n` +
        `متصل دلوقتي: *${sessions.length}*\n` +
        `وضع البوت: *${getBotMode() === 'paid' ? 'مدفوع 💳' : 'مجاني 🆓'}*\n` +
        `التخزين: *${(storeSize / 1024 / 1024).toFixed(2)}* MB` + CREDITS;
    safeEdit(ctx, txt, adminMenuKb());
});

bot.action('admin_list', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    const nums = listAllNumbers();
    if (!nums.length) return safeEdit(ctx, `مفيش أرقام.` + CREDITS,
        Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'admin_info', 'primary')]]));
    let list = `📋 *الأرقام (${nums.length})*\n✅ متصل | ⏳ ربط جاري | ⚠️ عالق | 🛑 موقوف\n\n`;
    nums.forEach((s, i) => {
        const uid = getCidByNumber(s);
        list += `${i + 1}. ${numberStatus(s)} \`+${s}\`  👤 ${uid ? `\`${uid}\`` : 'غير معروف'}\n`;
    });
    safeEdit(ctx, list + CREDITS, Markup.inlineKeyboard([
        [cbtn('🧹 تنظيف العالق', 'admin_cleanup', 'primary')],
        [cbtn('❌ قطع الكل', 'admin_disc_all', 'danger')],
        [cbtn('⬅️ رجوع', 'admin_info', 'primary')]
    ]));
});

bot.action('admin_disc_all', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    const nums = listAllNumbers();
    safeEdit(ctx, `⏳ جاري قطع ${nums.length} رقم في الخلفية...` + CREDITS,
        Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'admin_info', 'primary')]]));
    setImmediate(async () => {
        await Promise.allSettled(nums.map(n => adminDisconnectOne(n)));
        safeEdit(ctx, `✅ تم قطع ${nums.length} رقم ومسح بياناتهم.` + CREDITS,
            Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'admin_info', 'primary')]]));
    });
});

// تنظيف الأرقام العالقة (جلسات ناقصة + سجلات داتا بيز من غير جلسة)
bot.action('admin_cleanup', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    const r = await reconcileSessions();
    safeEdit(ctx,
        `🧹 *تم التنظيف*\nجلسات ناقصة اتمسحت: *${r.sessions}*\nسجلات عالقة اتمسحت من الداتا بيز: *${r.rows}*` + CREDITS,
        Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'admin_list', 'primary')]]));
});

// مسح رقم يدوي بالكامل
bot.action('admin_wipe_number', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    userStates.set(ctx.chat.id, { type: 'wipe_number' });
    safeEdit(ctx, `ابعت الرقم اللي عايز تمسحه نهائياً (جلسة + داتا بيز)\nمثال: \`201012345678\`` + CREDITS,
        Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'admin_info', 'primary')]]));
});

// ==========================================
// 📢 الإذاعة الذكية بنظام المجموعات (Smart Group/Batch Broadcast)
//    تشتغل في الخلفية كـ دفعات متوازية بدون تجميد البوت نهائياً
// ==========================================
let activeBroadcast = null; // { cancelled: boolean }

bot.action('broadcast_start', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    if (activeBroadcast && !activeBroadcast.cancelled) {
        return safeEdit(ctx, `⚠️ فيه إذاعة شغالة بالفعل في الخلفية دلوقتي!` + CREDITS,
            Markup.inlineKeyboard([
                [cbtn('🛑 إيقاف الإذاعة الحالية', 'broadcast_cancel', 'danger')],
                [cbtn('⬅️ رجوع', 'admin_info', 'primary')]
            ]));
    }
    userStates.set(ctx.chat.id, { type: 'broadcast' });
    safeEdit(ctx, `ابعت الرسالة اللي عايز تذيعها (نص أو صورة أو فيديو أو ملف أو فويس)\n💡 *الإذاعة هتشتغل بنظام المجموعات الذكية في الخلفية ومش هتجمّد البوت.*` + CREDITS,
        Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'admin_info', 'primary')]]));
});

bot.action('broadcast_cancel', async (ctx) => {
    await safeAnswerCb(ctx, 'تم طلب إيقاف الإذاعة');
    if (!isAdmin(ctx)) return;
    if (activeBroadcast) activeBroadcast.cancelled = true;
});

async function sendCopyToUserSmart(targetCid, fromChatId, messageId, state) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (state.cancelled) return 'cancelled';
        try {
            await withTimeout(bot.telegram.copyMessage(targetCid, fromChatId, messageId), 10000);
            return 'sent';
        } catch (err) {
            const code = err?.response?.error_code;
            const desc = (err?.response?.description || err?.message || '').toLowerCase();
            const retryAfter = err?.response?.parameters?.retry_after;

            // لو تليجرام طلب تهدئة السرعة (FloodWait 429) نستنى المدة المطلوبة ونكمل بذكاء
            if (code === 429 && retryAfter && attempt === 1) {
                await sleep((Number(retryAfter) + 1) * 1000);
                continue;
            }
            // لو المستخدم حاظر البوت أو مسح حسابه، نمسحه من جدول الإذاعة عشان ميعطلش الإذاعات الجاية
            if (code === 403 || desc.includes('blocked') || desc.includes('deactivated') || desc.includes('chat not found') || desc.includes('user not found')) {
                q.delBotUser(targetCid);
                return 'removed';
            }
            return 'failed';
        }
    }
    return 'failed';
}

function buildProgressBar(done, total) {
    if (!total) return '🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩 100%';
    const pct = Math.min(100, Math.round((done / total) * 100));
    const filled = Math.round(pct / 10);
    return '🟩'.repeat(filled) + '⬜'.repeat(10 - filled) + ` ${pct}%`;
}

async function runBroadcastInBatches(adminChatId, message, statusMsgId) {
    const users = q.allBotUsers();
    const total = users.length;
    const BATCH_SIZE = 20; // كل جروب/دفعة 20 مستخدم في نفس اللحظة
    const totalBatches = Math.ceil(total / BATCH_SIZE) || 1;

    const state = { cancelled: false };
    activeBroadcast = state;

    let sentTg = 0;
    let removedTg = 0;
    let failedTg = 0;
    let processed = 0;
    let lastUiUpdate = Date.now();

    try {
        for (let b = 0; b < totalBatches; b++) {
            if (state.cancelled) break;

            const batch = users.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
            const results = await Promise.allSettled(
                batch.map(u => sendCopyToUserSmart(u.cid, adminChatId, message.message_id, state))
            );

            for (const r of results) {
                if (r.status === 'fulfilled') {
                    if (r.value === 'sent') sentTg++;
                    else if (r.value === 'removed') removedTg++;
                    else if (r.value === 'failed') failedTg++;
                } else {
                    failedTg++;
                }
            }
            processed += batch.length;

            // تحديث رسالة التقدم كل 3 ثواني عشان منعملش ضغط على تليجرام
            const now = Date.now();
            if (now - lastUiUpdate >= 3000 && processed < total && !state.cancelled) {
                lastUiUpdate = now;
                const progressTxt =
                    `📡 *جاري الإذاعة الذكية (بنظام المجموعات)...*\n\n` +
                    `${buildProgressBar(processed, total)}\n` +
                    `📦 المجموعة: *${b + 1} / ${totalBatches}*\n` +
                    `✅ وصلت لـ: *${sentTg}*\n` +
                    `🧹 حظروا البوت (تم تنظيفهم): *${removedTg}*\n` +
                    `⚠️ فشل: *${failedTg}*\n` +
                    `📊 الإجمالي: *${processed} / ${total}*` + CREDITS;

                bot.telegram.editMessageText(adminChatId, statusMsgId, null, progressTxt, {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([[cbtn('🛑 إيقاف الإذاعة', 'broadcast_cancel', 'danger')]])
                }).catch(() => {});
            }

            // راحة خفيفة بين كل جروب والتاني عشان نحافظ على سرعة واستقرار البوت
            await yieldLoop();
            if (b + 1 < totalBatches && !state.cancelled) {
                await sleep(900);
            }
        }

        const finalHeader = state.cancelled
            ? `🛑 *تم إيقاف الإذاعة يدوياً*`
            : `✅ *تمت الإذاعة الذكية بنجاح!*`;

        const finalTxt =
            `${finalHeader}\n\n` +
            `${buildProgressBar(processed, total)}\n` +
            `📦 المجموعات المكتملة: *${Math.ceil(processed / BATCH_SIZE)} / ${totalBatches}*\n` +
            `✅ وصلت بنجاح لـ: *${sentTg}*\n` +
            `🧹 حسابات غير نشطة/حاظرة وتم تنظيفها: *${removedTg}*\n` +
            `⚠️ فشل أخرى: *${failedTg}*\n` +
            `👥 إجمالي الفحص: *${processed} / ${total}*` + CREDITS;

        await bot.telegram.editMessageText(adminChatId, statusMsgId, null, finalTxt, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[cbtn('⬅️ رجوع للوحة الأدمن', 'admin_info', 'primary')]])
        }).catch(() => {});
    } finally {
        activeBroadcast = null;
    }
}

// ─── حالة البوت (مجاني/مدفوع) ───
function botModeKb() {
    const mode = getBotMode();
    return Markup.inlineKeyboard([
        [cbtn(mode === 'free' ? '🔁 حوّل لمدفوع' : '🔁 حوّل لمجاني', 'bot_mode_toggle', mode === 'free' ? 'danger' : 'success')],
        [cbtn('➕ فعّل مستخدم (مدفوع)', 'add_paid_user', 'success')],
        [cbtn('📃 قائمة المفعّلين', 'list_paid', 'primary')],
        [cbtn('⬅️ رجوع', 'admin_info', 'primary')]
    ]);
}
bot.action('bot_mode_menu', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    safeEdit(ctx, `⚙️ *وضع البوت الحالي:* ${getBotMode() === 'paid' ? 'مدفوع 💳' : 'مجاني 🆓'}\n\n` +
        `مجاني: أي حد يقدر يربط رقمه (رقم واحد لكل شخص).\n` +
        `مدفوع: محدش يقدر يربط غير اللي الأدمن فعّله.` + CREDITS, botModeKb());
});
bot.action('bot_mode_toggle', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    setBotMode(getBotMode() === 'free' ? 'paid' : 'free');
    safeEdit(ctx, `✅ *تم التحويل لوضع:* ${getBotMode() === 'paid' ? 'مدفوع 💳' : 'مجاني 🆓'}` + CREDITS, botModeKb());
});
bot.action('add_paid_user', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    userStates.set(ctx.chat.id, { type: 'paid_id' });
    safeEdit(ctx, `ابعت الـ ID بتاع المستخدم اللي عايز تفعّله` + CREDITS,
        Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'bot_mode_menu', 'primary')]]));
});
bot.action('list_paid', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    const all = q.allPaid();
    if (!all.length) return safeEdit(ctx, `مفيش حد مفعّل دلوقتي.` + CREDITS,
        Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'bot_mode_menu', 'primary')]]));
    const btns = all.map(p => [cbtn(`❌ ${p.user_id}`, `del_paid_${p.user_id}`, 'danger')]);
    btns.push([cbtn('⬅️ رجوع', 'bot_mode_menu', 'primary')]);
    safeEdit(ctx, `📃 *المفعّلين (${all.length})*\nدوس على أي حد عشان تشيله` + CREDITS, Markup.inlineKeyboard(btns));
});
bot.action(/del_paid_(\d+)/, async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    removePaidUser(ctx.match[1]);
    safeEdit(ctx, `✅ تم إلغاء تفعيل \`${ctx.match[1]}\`` + CREDITS,
        Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'bot_mode_menu', 'primary')]]));
});

// ─── الاشتراك الإجباري ───
function forceSubMenuKb() {
    return Markup.inlineKeyboard([
        [cbtn('➕ إضافة قناة/جروب', 'force_sub_add', 'success')],
        [cbtn('🗑 حذف اشتراك', 'force_sub_del_list', 'danger')],
        [cbtn('⬅️ رجوع', 'admin_info', 'primary')]
    ]);
}
bot.action('force_sub_menu', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    const list = listForceSub();
    safeEdit(ctx, `🔒 *الاشتراك الإجباري*\nالقنوات الحالية: *${list.length}*` + CREDITS, forceSubMenuKb());
});
bot.action('force_sub_add', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    userStates.set(ctx.chat.id, { type: 'force_sub' });
    safeEdit(ctx, `ابعت يوزر القناة أو الجروب (لازم يكون البوت أدمن فيها)\nمثال: \`@my_channel\`` + CREDITS,
        Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'force_sub_menu', 'primary')]]));
});
bot.action('force_sub_del_list', async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    const list = listForceSub();
    if (!list.length) return safeEdit(ctx, `مفيش قنوات مضافة.` + CREDITS,
        Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'force_sub_menu', 'primary')]]));
    const btns = list.map(c => [cbtn(`❌ ${c.title || c.chat_ref}`, `del_fsub_${Buffer.from(c.chat_ref).toString('base64')}`, 'danger')]);
    btns.push([cbtn('⬅️ رجوع', 'force_sub_menu', 'primary')]);
    safeEdit(ctx, `اختار القناة اللي عايز تمسحها من الاشتراك الإجباري:` + CREDITS, Markup.inlineKeyboard(btns));
});
bot.action(/del_fsub_(.+)/, async (ctx) => {
    await safeAnswerCb(ctx);
    if (!isAdmin(ctx)) return;
    const ref = Buffer.from(ctx.match[1], 'base64').toString('utf-8');
    removeForceSub(ref);
    safeEdit(ctx, `✅ تم حذف القناة من الاشتراك الإجباري.` + CREDITS,
        Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'force_sub_menu', 'primary')]]));
});

// ─── استقبال الرسايل حسب الحالة ───
bot.on('message', async (ctx) => {
    const cid = ctx.chat?.id;
    if (!cid) return;
    const state = userStates.get(cid);
    if (!state) return;

    // إذاعة ذكية (أدمن فقط) - تعمل في الخلفية بدون تجميد البوت
    if (state.type === 'broadcast') {
        if (!isAdmin(ctx)) { userStates.delete(cid); return; }
        userStates.delete(cid);
        const wait = await ctx.reply('🚀 *بدأت الإذاعة الذكية بنظام المجموعات في الخلفية...*\nالبوت شغال طبيعي ومش هيتجمد أثناء الإرسال.', {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[cbtn('🛑 إيقاف الإذاعة', 'broadcast_cancel', 'danger')]])
        });
        setImmediate(() => {
            runBroadcastInBatches(cid, ctx.message, wait.message_id).catch(err => {
                console.error('❌ خطأ أثناء الإذاعة:', err);
            });
        });
        return;
    }

    if (!ctx.message?.text) return; // باقي الحالات نصية بس
    const text = ctx.message.text.trim();

    if (state.type === 'paid_id') {
        if (!isAdmin(ctx)) { userStates.delete(cid); return; }
        userStates.delete(cid);
        const id = text.replace(/\D/g, '');
        if (!id) return ctx.reply('❌ ID غلط.');
        addPaidUser(id);
        return ctx.reply(`✅ تم تفعيل \`${id}\` كمستخدم مدفوع.` + CREDITS, { parse_mode: 'Markdown' });
    }

    if (state.type === 'force_sub') {
        if (!isAdmin(ctx)) { userStates.delete(cid); return; }
        userStates.delete(cid);
        let ref = text.trim();
        if (ref.includes('t.me/')) ref = '@' + ref.split('t.me/')[1].replace(/\/$/, '');
        if (!ref.startsWith('@')) return ctx.reply('❌ ابعت يوزر يبدأ بـ @');
        try {
            const chat = await withTimeout(bot.telegram.getChat(ref), 8000);
            const me = await withTimeout(bot.telegram.getMe(), 8000);
            const member = await withTimeout(bot.telegram.getChatMember(ref, me.id), 8000);
            if (!['administrator', 'creator'].includes(member.status)) {
                return ctx.reply('❌ لازم البوت يكون أدمن في القناة/الجروب دي الأول.');
            }
            addForceSub(ref, chat.title || ref);
            return ctx.reply(`✅ تمت إضافة "${chat.title || ref}" للاشتراك الإجباري.` + CREDITS, { parse_mode: 'Markdown' });
        } catch (e) {
            return ctx.reply(`❌ مقدرتش أتأكد من القناة: ${e.message}`);
        }
    }

    if (state.type === 'wipe_number') {
        if (!isAdmin(ctx)) { userStates.delete(cid); return; }
        userStates.delete(cid);
        const num = text.replace(/\D/g, '');
        if (!num) return ctx.reply('❌ رقم غلط.');
        await adminDisconnectOne(num);
        return ctx.reply(`✅ تم مسح الرقم \`+${num}\` نهائياً (جلسة + داتا بيز).` + CREDITS, { parse_mode: 'Markdown' });
    }

    if (state.type === 'number') {
        const number = text.replace(/\D/g, '');
        if (!number || number.length < 7) return ctx.reply('❌ رقم غير صحيح، ابعته بكود الدولة.' + CREDITS, { parse_mode: 'Markdown' });

        const admin = isAdmin(ctx);
        const me = String(cid);
        if (connectLock.has(number)) return ctx.reply('⏳ جاري الربط، استنى شوية...');

        if (!admin) {
            const mine = getUserNumber(cid);
            if (mine && mine !== number) {
                if (sessionState(mine) === 'paired') {
                    userStates.delete(cid);
                    return ctx.reply(`عندك رقم مربوط بالفعل \`+${mine}\`\nاقطعه الأول لو عايز تغيره.` + CREDITS, {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([[cbtn('🔌 اقطعه واربط رقم جديد', 'replace_number', 'danger')]])
                    });
                }
                await fullDisconnect(mine);
            }
        }

        const owner = getCidByNumber(number);
        const st = sessionState(number);
        const pend = pendingPairs.get(number);

        if (pend && String(pend.cid) !== me) {
            userStates.delete(cid);
            return ctx.reply(`الرقم \`+${number}\` بيتربط دلوقتي من حساب تاني، جرب بعد دقيقتين.` + CREDITS, { parse_mode: 'Markdown' });
        }

        if (st === 'paired' && !pend && owner !== me) {
            userStates.delete(cid);
            const kb = admin
                ? Markup.inlineKeyboard([[cbtn('🔌 اقطعه', `admin_disc_${number}`, 'danger')]])
                : undefined;
            return ctx.reply(
                (owner ? `الرقم \`+${number}\` مسجل بحساب تاني.` : `الرقم \`+${number}\` متصل بالفعل.`) + CREDITS,
                { parse_mode: 'Markdown', ...(kb || {}) });
        }

        userStates.delete(cid);
        const wait = await ctx.reply('⏳ جاري تجهيز الرقم وإنشاء كود الربط...');
        connectLock.add(number);

        // تشغيل عملية الربط في الخلفية عشان ما تعطلش استقبال رسايل باقي المستخدمين في تليجرام
        setImmediate(async () => {
            try {
                await cancelPairingsOfChat(cid);
                if (st !== 'none' || owner) await fullDisconnect(number);

                const code = await startWhatsApp(number, { cid, isAdmin: admin });
                const p = pendingPairs.get(number);
                if (p) p.msgId = wait.message_id;

                await ctx.telegram.editMessageText(cid, wait.message_id, null,
                    code ?
                    `✅ *كود الربط:*\n\`${code}\`\n\nروح واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز ← ربط برقم الهاتف بدلاً من ذلك\n⏱ الكود صالح ${Math.round(PAIR_TIMEOUT_MS / 60000)} دقايق، ولو حصل أي خطأ هتتبلغ ومفيش حاجة هتفضل عالقة.` + CREDITS :
                    `الرقم متصل بالفعل.` + CREDITS,
                    { parse_mode: 'Markdown', disable_web_page_preview: true,
                      ...Markup.inlineKeyboard([
                          [cbtn('❌ إلغاء الربط', 'cancel_pair', 'danger')],
                          [cbtn('⬅️ رجوع', 'back', 'primary')]
                      ]) }
                );
            } catch (e) {
                if (e && e.cancelled) return;
                await fullDisconnect(number).catch(() => {});
                await ctx.telegram.editMessageText(cid, wait.message_id, null,
                    `❌ خطأ: ${e.message}` + CREDITS,
                    { parse_mode: 'Markdown',
                      ...Markup.inlineKeyboard([[cbtn('🔄 حاول تاني', 'connect', 'success'), cbtn('⬅️ رجوع', 'back', 'primary')]]) }
                ).catch(() => {});
            } finally {
                connectLock.delete(number);
            }
        });
    }
});

// ==========================================
// 📱 واتساب - الكور الأساسي
// ==========================================
const sockets = {};                    // رقم -> سوكيت نشط
const reconnectAttempts = new Map();   // رقم -> عدد محاولات إعادة الاتصال
const reconnectTimers = new Map();     // رقم -> مؤقت إعادة الاتصال
const watchdogs = new Map();           // رقم -> interval لمراقبة صحة الاتصال
const pendingPairs = new Map();        // رقم -> { cid, isAdmin, paired, codeSent, msgId, timer }
const epochs = new Map();              // رقم -> رقم نسخة
const msgRetryCounterMap = new Map();

const PAIR_TIMEOUT_MS = 3 * 60 * 1000;
const FATAL_CODES = [401, 403, 411];
const MAX_RECONNECT_ATTEMPTS = 10;
const stoppedSessions = new Set();

const cleanDigits = (n) => String(n || '').replace(/\D/g, '');
const getEpoch = (n) => epochs.get(n) || 0;
const bumpEpoch = (n) => { epochs.set(n, getEpoch(n) + 1); return getEpoch(n); };

// كاش لنسخة Baileys عشان منطلبهاش من الإنترنت مع كل إعادة اتصال وتتسبب في تعليق البوت
let cachedWaVersion = null;
let cachedWaVersionAt = 0;
async function getWaVersionSafe() {
    if (cachedWaVersion && Date.now() - cachedWaVersionAt < 60 * 60 * 1000) {
        return cachedWaVersion;
    }
    try {
        const res = await withTimeout(fetchLatestBaileysVersion(), 4000);
        if (res?.version) {
            cachedWaVersion = res.version;
            cachedWaVersionAt = Date.now();
        }
    } catch (_) {}
    return cachedWaVersion;
}

// 🪄 دالة العلاج الذاتي (Auto Self-Healing) لما يحصل كود 500 متكرر
function healCorruptedSessionKeys(cleanNum) {
    const sessionPath = path.join(sessionsDir, cleanNum);
    if (!fs.existsSync(sessionPath)) return;
    try {
        const files = fs.readdirSync(sessionPath);
        let cleaned = 0;
        for (const f of files) {
            if (f === 'creds.json' || f.startsWith('app-state-sync-key')) continue;
            if (f.startsWith('session-') || f.startsWith('sender-key-') || f.startsWith('pre-key-')) {
                try {
                    fs.unlinkSync(path.join(sessionPath, f));
                    cleaned++;
                } catch (_) {}
            }
        }
        if (cleaned > 0) console.log(`🩺 تم عمل علاج ذاتي وتنظيف ${cleaned} ملف تشفير معلق للرقم ${cleanNum} مع الحفاظ على الربط!`);
    } catch (_) {}
}

// ─── قراءة حالة الجلسة ───
function isPairedCreds(creds) {
    return !!(creds && (creds.registered || creds.account || (creds.me?.id && creds.me.name !== '~')));
}
function readSessionCreds(num) {
    try { return JSON.parse(fs.readFileSync(path.join(sessionsDir, num, 'creds.json'), 'utf-8')); }
    catch (_) { return null; }
}
function sessionDirs() {
    try {
        return fs.readdirSync(sessionsDir).filter(f => {
            try { return fs.statSync(path.join(sessionsDir, f)).isDirectory(); } catch (_) { return false; }
        });
    } catch (_) { return []; }
}
function listConnectedSessions() { return sessionDirs().filter(n => isPairedCreds(readSessionCreds(n))); }
function countConnectedSessions() { return listConnectedSessions().length; }

function sessionState(num) {
    if (isPairedCreds(readSessionCreds(num))) return 'paired';
    if (pendingPairs.has(num) || sockets[num] || fs.existsSync(path.join(sessionsDir, num))) return 'pending';
    return 'none';
}
function listAllNumbers() {
    return [...new Set([...sessionDirs(), ...pendingPairs.keys(), ...q.allUsers().map(u => u.number)])];
}
function numberStatus(n) {
    const st = sessionState(n);
    if (stoppedSessions.has(n)) return '🛑';
    return st === 'paired' ? '✅' : st === 'pending' ? '⏳' : '⚠️';
}

// ─── تجاهل أخطاء التشفير المعروفة اللي بتحصل عادي في بايليز ───
const ignoreErrors = ['Bad MAC', 'Key used already', 'No session', 'Failed to decrypt'];
process.on('uncaughtException', (err) => {
    if (ignoreErrors.some(e => err?.message?.includes(e))) return;
    console.error('❌ Uncaught:', err);
});
process.on('unhandledRejection', (err) => {
    if (ignoreErrors.some(e => err?.message?.includes(e))) return;
    console.error('❌ Unhandled:', err);
});

// ─── إشعارات تليجرام لعملية الربط ───
function tgUpdatePairMsg(p, text, kb) {
    const extra = { parse_mode: 'Markdown', disable_web_page_preview: true, ...kb };
    const send = () => bot.telegram.sendMessage(p.cid, text + CREDITS, extra).catch(() => {});
    if (p.msgId) bot.telegram.editMessageText(p.cid, p.msgId, null, text + CREDITS, extra).catch(send);
    else send();
}
const retryKb = () => Markup.inlineKeyboard([[cbtn('🔄 حاول تاني', 'connect', 'success'), cbtn('⬅️ رجوع', 'back', 'primary')]]);

// ─── فصل السوكيت من غير ما أي handler يعيد الاتصال ───
function detachSocket(num) {
    const sock = sockets[num];
    delete sockets[num];
    clearWatchdog(num);
    const t = reconnectTimers.get(num);
    if (t) { clearTimeout(t); reconnectTimers.delete(num); }
    reconnectAttempts.delete(num);
    if (sock) {
        try {
            sock.ev.removeAllListeners('connection.update');
            sock.ev.removeAllListeners('messages.upsert');
            sock.ev.removeAllListeners('messages.update');
            sock.ev.removeAllListeners('creds.update');
        } catch (_) {}
    }
    return sock;
}

async function fullDisconnect(numRaw) {
    const num = cleanDigits(numRaw);
    if (!num) return;
    stoppedSessions.delete(num);
    bumpEpoch(num);
    const p = pendingPairs.get(num);
    if (p?.timer) clearTimeout(p.timer);
    pendingPairs.delete(num);

    const sock = detachSocket(num);
    if (sock) {
        if (isPairedCreds(sock.authState?.creds)) {
            try { await Promise.race([sock.logout(), sleep(4000)]); } catch (_) {}
        }
        try { sock.end(undefined); } catch (_) {}
    }
    wipeSessionData(num);
}

async function abortPairing(num, text) {
    const p = pendingPairs.get(num);
    await fullDisconnect(num);
    if (p && p.codeSent && text) tgUpdatePairMsg(p, text, retryKb());
}
async function expirePairing(num) {
    const p = pendingPairs.get(num);
    if (!p || p.paired) return;
    await abortPairing(num, `⏱ *انتهت مهلة كود الربط* للرقم \`+${num}\`\nاتمسحت بياناته، اطلب كود جديد.`);
}
async function cancelPairingsOfChat(cid) {
    let n = 0;
    for (const [num, p] of [...pendingPairs.entries()]) {
        if (String(p.cid) === String(cid)) { await fullDisconnect(num); n++; }
    }
    return n;
}

function markPaired(num, p) {
    p.paired = true;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    if (!p.isAdmin) { try { setUserNumber(p.cid, num); } catch (_) {} }
}

function scheduleReconnect(cleanNum, delay) {
    const old = reconnectTimers.get(cleanNum);
    if (old) clearTimeout(old);
    const t = setTimeout(async () => {
        reconnectTimers.delete(cleanNum);
        if (sockets[cleanNum]) return;
        if (!fs.existsSync(path.join(sessionsDir, cleanNum))) return;
        try {
            await startWhatsApp(cleanNum);
        } catch (e) {
            console.error(`❌ فشل إعادة اتصال ${cleanNum}:`, e.message);
            if (!sockets[cleanNum] && fs.existsSync(path.join(sessionsDir, cleanNum))) {
                const attempt = (reconnectAttempts.get(cleanNum) || 0) + 1;
                reconnectAttempts.set(cleanNum, attempt);
                scheduleReconnect(cleanNum, Math.min(30000, 2000 * attempt));
            }
        }
    }, delay);
    reconnectTimers.set(cleanNum, t);
}

// فحص تطابق الأمر مع قائمة أوامر البلجن (يدعم الأوامر من كلمة أو كلمتين مثل "كتم" و "فك كتم")
function matchesPluginCommand(cleanText, cmdList) {
    if (!cleanText || !Array.isArray(cmdList)) return false;
    const lowerText = cleanText.trim().toLowerCase();
    const firstWord = lowerText.split(/\s+/)[0];
    for (const rawCmd of cmdList) {
        const cmd = String(rawCmd || '').trim().toLowerCase();
        if (!cmd) continue;
        if (cmd.includes(' ')) {
            if (lowerText === cmd || lowerText.startsWith(cmd + ' ') || lowerText.startsWith(cmd + '\n')) {
                return true;
            }
        } else if (firstWord === cmd) {
            return true;
        }
    }
    return false;
}

async function startWhatsApp(phoneNumber, pairInfo = null) {
    const cleanNum = cleanDigits(phoneNumber);
    if (!cleanNum) return null;
    const sessionPath = path.join(sessionsDir, cleanNum);

    if (sockets[cleanNum]) return null;

    const myEpoch = getEpoch(cleanNum);
    const stale = () => getEpoch(cleanNum) !== myEpoch;
    const cancelledErr = () => { const e = new Error('تم إلغاء عملية الربط.'); e.cancelled = true; return e; };
    const dropOrphanDir = () => {
        if (!pendingPairs.has(cleanNum) && !sockets[cleanNum]) {
            try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (_) {}
        }
    };

    if (!pairInfo && !fs.existsSync(sessionPath)) return null;
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const paired = isPairedCreds(state.creds);

    let credsQueue = Promise.resolve();
    const safeSaveCreds = () => {
        credsQueue = credsQueue.then(() => saveCreds()).catch(() => {});
        return credsQueue;
    };

    if (!paired && !pairInfo) {
        if (!stale()) await abortPairing(cleanNum, `⚠️ *الربط ماكملش* للرقم \`+${cleanNum}\`\nاتمسحت بياناته، اطلب كود جديد.`);
        return null;
    }

    const version = await getWaVersionSafe();

    if (stale() || sockets[cleanNum]) {
        if (stale()) { dropOrphanDir(); if (pairInfo) throw cancelledErr(); }
        return null;
    }

    const silentLogger = pino({ level: 'fatal' });
    const sock = makeWASocket({
        ...(version ? { version } : {}),
        auth: {
            creds: state.creds,
            keys: typeof makeCacheableSignalKeyStore === 'function'
                ? makeCacheableSignalKeyStore(state.keys, silentLogger)
                : state.keys
        },
        printQRInTerminal: false,
        logger: silentLogger,
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: false,
        emitOwnEvents: false,
        generateHighQualityLinkPreview: false,
        keepAliveIntervalMs: 25000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        retryRequestDelayMs: 250,
        msgRetryCounterMap,
        getMessage: async () => undefined
    });

    sockets[cleanNum] = sock;

    sock.ev.on('creds.update', () => {
        if (sockets[cleanNum] !== sock) return;
        safeSaveCreds();
        const p = pendingPairs.get(cleanNum);
        if (p && !p.paired && isPairedCreds(state.creds)) markPaired(cleanNum, p);
    });

    // ─── استقبال الرسايل + تشغيل البلجنز (دعم كامل للمصفوفة + فك التغليف + الحذف + الكتم) ───
    sock.ev.on('messages.upsert', async ({ messages, type: upsertType }) => {
        if (sockets[cleanNum] !== sock || !sock.user) return;
        if (upsertType !== 'notify' && upsertType !== 'append') return;

        const plugins = loadPlugins();

        for (const msg of messages) {
            if (!msg) continue;
            if (msg.key?.remoteJid === 'status@broadcast') continue;

            const isRevokeStub = msg.messageStubType === 1 || msg.messageStubType === 'REVOKE';
            if (!msg.message && !isRevokeStub) continue;

            const innerMsg = msg.message?.ephemeralMessage?.message ||
                             msg.message?.viewOnceMessage?.message ||
                             msg.message?.viewOnceMessageV2?.message ||
                             msg.message?.viewOnceMessageV2Extension?.message ||
                             msg.message?.deviceSentMessage?.message ||
                             msg.message || {};

            const text = innerMsg.conversation ||
                         innerMsg.extendedTextMessage?.text ||
                         innerMsg.imageMessage?.caption ||
                         innerMsg.videoMessage?.caption || '';
            const isFromMe = !!msg.key?.fromMe;

            for (const plugin of plugins) {
                if (!plugin.execute && typeof plugin.onMessage !== 'function') continue;

                // 1) البلجنز اللي بتراقب كل الرسايل (زي message-store أو anti-delete أو فحص المكتومين في mute)
                if (typeof plugin.onMessage === 'function') {
                    try {
                        const handled = await plugin.onMessage(sock, msg);
                        if (handled === true) break; // لو الرسالة اتمسحت بسبب الكتم نوقف باقي المعالجة عليها
                    } catch (err) {
                        console.error(`❌ خطأ في onMessage لبلجن ${plugin.file || plugin.name}:`, err.message);
                    }
                } else if (!plugin.command) {
                    try {
                        await plugin.execute(sock, msg);
                    } catch (err) {
                        console.error(`❌ خطأ في بلجن ${plugin.file || plugin.name}:`, err.message);
                    }
                }

                // 2) البلجنز اللي ليها أوامر (مثل .help أو كتم) - تشتغل لما صاحب الرقم المربوط نفسه يكتب الأمر
                if (upsertType === 'notify' && plugin.command && matchesPluginCommand(text, plugin.command) && isFromMe) {
                    try {
                        await plugin.execute(sock, msg);
                    } catch (err) {
                        try { await sock.sendMessage(msg.key.remoteJid, { text: `❌ خطأ: ${err.message}` }); } catch (_) {}
                    }
                }
            }
        }
    });

    // ─── التقاط رسائل الحذف في Baileys v7 لو وصلت عن طريق messages.update ───
    sock.ev.on('messages.update', async (updates) => {
        if (sockets[cleanNum] !== sock || !sock.user) return;
        const plugins = loadPlugins();
        const antiDeletePlugin = plugins.find(p => p.name === 'anti-delete' || p.file === 'anti-delete.js');
        if (!antiDeletePlugin?.execute) return;

        for (const item of updates) {
            const u = item.update || {};
            const proto = u.message?.protocolMessage || u.message?.ephemeralMessage?.message?.protocolMessage;
            const isRevoke = u.messageStubType === 1 ||
                             u.messageStubType === 'REVOKE' ||
                             u.message === null ||
                             (proto && (proto.type === 0 || proto.type === 'REVOKE'));

            if (isRevoke && item.key) {
                const mergedDeletedKey = {
                    ...(item.key || {}),
                    ...(proto?.key || {}),
                    fromMe: !!(proto?.key?.fromMe || item.key?.fromMe),
                    participant: proto?.key?.participant || item.key?.participant || u.key?.participant
                };
                const syntheticMsg = {
                    key: u.key || item.key,
                    pushName: u.pushName || '',
                    message: {
                        protocolMessage: {
                            type: 0,
                            key: mergedDeletedKey
                        }
                    }
                };
                try {
                    await antiDeletePlugin.execute(sock, syntheticMsg);
                } catch (err) {
                    console.error('❌ خطأ في anti-delete (update):', err.message);
                }
            }
        }
    });

    // ─── إدارة الاتصال ───
    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (sockets[cleanNum] !== sock) return;
        if (!connection) return;
        console.log(`📡 ${cleanNum}: ${connection}`);

        if (connection === 'close') {
            delete sockets[cleanNum];
            clearWatchdog(cleanNum);

            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const nowPaired = isPairedCreds(state.creds);
            const p = pendingPairs.get(cleanNum);

            if (!nowPaired) {
                if (p && !p.codeSent) return;
                console.log(`🧹 ربط ${cleanNum} ماكملش (code ${statusCode ?? '?'}) - إلغاء ومسح`);
                await abortPairing(cleanNum, `❌ *الربط فشل أو اتقطع* للرقم \`+${cleanNum}\`\nاتمسحت بياناته، اطلب كود جديد وجرب تاني.`);
                return;
            }

            const errMsg = lastDisconnect?.error?.message || '';
            console.log(`⚠️ ${cleanNum} اتقفل - code=${statusCode ?? 'بدون'} msg=${errMsg}`);

            if (FATAL_CODES.includes(statusCode)) {
                console.log(`⚠️ ${cleanNum} جلسة ميتة (code ${statusCode})`);
                const owner = getCidByNumber(cleanNum);
                await fullDisconnect(cleanNum);
                const msgTxt = `⚠️ *الرقم \`+${cleanNum}\` الجلسة بتاعته بطلت صالحة* (code ${statusCode})\nاتمسحت بياناته وتقدر تربطه تاني.` + CREDITS;
                bot.telegram.sendMessage(ADMIN_ID, msgTxt, { parse_mode: 'Markdown' }).catch(() => {});
                if (owner && String(owner) !== String(ADMIN_ID)) {
                    bot.telegram.sendMessage(owner, msgTxt, { parse_mode: 'Markdown' }).catch(() => {});
                }
                return;
            }

            try { await safeSaveCreds(); } catch (_) {}
            if (stale() || sockets[cleanNum]) return;
            const attempt = (reconnectAttempts.get(cleanNum) || 0) + 1;
            reconnectAttempts.set(cleanNum, attempt);

            if (statusCode === 500 && attempt >= 2) {
                healCorruptedSessionKeys(cleanNum);
            }

            let delay;
            if (statusCode === DisconnectReason.restartRequired) {
                delay = 500;
            } else if (statusCode === 500) {
                delay = Math.min(30000, 3000 * attempt);
            } else if (attempt >= MAX_RECONNECT_ATTEMPTS) {
                console.log(`⏳ ${cleanNum} وصل لـ ${attempt} محاولة (آخر code ${statusCode ?? 'بدون'}) - هنكمل محاولة بهدوء كل 60 ثانية بدون فك الربط!`);
                delay = 60000;
            } else {
                delay = Math.min(25000, 2000 * attempt);
            }

            console.log(`🔄 إعادة اتصال ${cleanNum} بعد ${delay}ms...`);
            scheduleReconnect(cleanNum, delay);

        } else if (connection === 'open') {
            reconnectAttempts.set(cleanNum, 0);
            console.log(`✅ متصل: ${cleanNum}`);
            startWatchdog(cleanNum);
            const p = pendingPairs.get(cleanNum);
            if (p) {
                if (!p.paired) markPaired(cleanNum, p);
                if (p.timer) clearTimeout(p.timer);
                pendingPairs.delete(cleanNum);
                tgUpdatePairMsg(p, `✅ الرقم \`+${cleanNum}\` اتربط بنجاح!`,
                    Markup.inlineKeyboard([[cbtn('⬅️ رجوع', 'back', 'primary')]]));
            }
        }
    });

    // ─── كود الربط (مع Timeout عشان السوكيت لو علق ميجمدش البوت) ───
    let pairingCode = null;
    if (!paired) {
        const pend = { cid: pairInfo.cid, isAdmin: !!pairInfo.isAdmin, paired: false, codeSent: false, msgId: null, timer: null };
        pendingPairs.set(cleanNum, pend);
        await sleep(3000);
        if (stale()) throw cancelledErr();
        try {
            const code = await withTimeout(sock.requestPairingCode(cleanNum, PAIRING_CODE_ID), 20000, 'انتهت مهلة طلب كود الربط');
            pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
            console.log(`🔑 كود الربط لـ ${cleanNum}: ${pairingCode}`);
        } catch (e) {
            if (!stale()) await fullDisconnect(cleanNum);
            throw new Error('فشل في إنشاء كود الربط، حاول مرة أخرى.');
        }
        if (stale()) throw cancelledErr();
        pend.codeSent = true;
        pend.timer = setTimeout(() => expirePairing(cleanNum).catch(() => {}), PAIR_TIMEOUT_MS);
    }

    return pairingCode;
}

// ─── مراقبة صحة الاتصال ───
function startWatchdog(cleanNum) {
    clearWatchdog(cleanNum);
    const id = setInterval(async () => {
        const sock = sockets[cleanNum];
        if (!sock) return clearWatchdog(cleanNum);
        const wsState = sock.ws?.readyState ?? (sock.ws?.isClosed ? 3 : 1);
        if (wsState === 2 || wsState === 3) {
            if (sockets[cleanNum] !== sock) return;
            console.log(`♻️ سوكيت ${cleanNum} مقفول، بنعمله إعادة اتصال هادي`);
            detachSocket(cleanNum);
            try { sock.end(undefined); } catch (_) {}
            scheduleReconnect(cleanNum, 1500);
        }
    }, 60000);
    watchdogs.set(cleanNum, id);
}
function clearWatchdog(cleanNum) {
    const id = watchdogs.get(cleanNum);
    if (id) { clearInterval(id); watchdogs.delete(cleanNum); }
}

function wipeSessionData(cleanNum) {
    const sessionPath = path.join(sessionsDir, cleanNum);
    try { fs.rmSync(sessionPath, { recursive: true, force: true, maxRetries: 3 }); } catch (_) {}
    const userStoreDir = path.join(storeDir, cleanNum);
    if (fs.existsSync(userStoreDir)) { try { fs.rmSync(userStoreDir, { recursive: true, force: true }); } catch (_) {} }
    removeUserByNumber(cleanNum);
}

function disconnectNumber(num) { return fullDisconnect(num); }

// ─── تنضيف الأرقام العالقة ───
async function reconcileSessions() {
    let sessions = 0, rows = 0;
    for (const n of sessionDirs()) {
        if (pendingPairs.has(n)) continue;
        if (!isPairedCreds(readSessionCreds(n))) { await fullDisconnect(n); sessions++; }
    }
    const live = new Set(listConnectedSessions());
    for (const u of q.allUsers()) {
        if (!live.has(u.number) && !pendingPairs.has(u.number)) { q.deleteUserByCid(u.cid); rows++; }
    }
    return { sessions, rows };
}

// ─── استعادة الجلسات عند التشغيل ───
async function restoreAll() {
    await reconcileSessions();
    for (const f of listConnectedSessions()) {
        try { await startWhatsApp(f); } catch (e) { console.error(`❌ فشل استعادة ${f}:`, e.message); }
        await sleep(5000);
    }
}

// ==========================================
// 🛡️ مراقب اتصال التليجرام الذاتي (Telegram Polling Watchdog)
//    لو الـ Polling وقف أو علق لأي سبب شبكي، بيعيد تشغيله تلقائياً
// ==========================================
let tgLaunching = false;
let tgFailCount = 0;

async function startTelegramPolling() {
    if (tgLaunching) return;
    tgLaunching = true;
    try {
        await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
        bot.launch({
            allowedUpdates: ['message', 'callback_query', 'chat_member'],
            dropPendingUpdates: false
        }).catch((err) => {
            console.error('⚠️ توقف Polling التليجرام، جاري إعادة التشغيل خلال 5 ثواني:', err?.message || err);
            tgLaunching = false;
            setTimeout(() => startTelegramPolling(), 5000);
        });
        console.log('✅ بوت التليجرام شغال وجاهز لاستقبال الرسايل!');
    } catch (e) {
        console.error('❌ خطأ في تشغيل التليجرام:', e.message);
        tgLaunching = false;
        setTimeout(() => startTelegramPolling(), 5000);
    }
}

setInterval(async () => {
    try {
        await withTimeout(bot.telegram.getMe(), 15000, 'Telegram ping timeout');
        tgFailCount = 0;
        if (bot.polling && bot.polling.started === false && !tgLaunching) {
            console.log('♻️ إعادة تفعيل Polling التليجرام تلقائياً...');
            startTelegramPolling();
        }
    } catch (e) {
        tgFailCount++;
        console.warn(`⚠️ فشل فحص اتصال التليجرام (${tgFailCount}): ${e.message}`);
        if (tgFailCount >= 3) {
            tgFailCount = 0;
            try { bot.stop('restart'); } catch (_) {}
            tgLaunching = false;
            setTimeout(() => startTelegramPolling(), 2000);
        }
    }
}, 45000);

// ==========================================
// 🚀 التشغيل (تليجرام يشتغل فوراً واستعادة واتساب في الخلفية)
// ==========================================
(async () => {
    console.log('🤖 WhatsApp Bot - Telegram Panel v2');
    await initDb();
    console.log('🗄️ قاعدة البيانات جاهزة');
    console.log('📂 Plugins:', pluginsDir);

    // تشغيل التليجرام الأول فوراً عشان يرد على الرسايل من أول ثانية
    await startTelegramPolling();

    // استعادة جلسات الواتساب في الخلفية بدون تعطيل التليجرام
    restoreAll().catch(e => console.error('❌ خطأ أثناء استعادة الجلسات:', e.message));

    const shutdown = () => {
        try { bot.stop('SIGTERM'); } catch (_) {}
        try { if (db) fs.writeFileSync(dbFile, Buffer.from(db.export())); } catch (_) {}
        process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
})();
