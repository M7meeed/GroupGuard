const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrcodeLib = require('qrcode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// ===== نظام الحفظ الدائم للبيانات =====
const DATA_FILE = path.join(__dirname, 'data.json');

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const data = JSON.parse(raw);
            // دمج البيانات المحفوظة مع config
            if (data.bannedWords) config.bannedWords = data.bannedWords;
            if (data.allowedCountryCodes) config.allowedCountryCodes = data.allowedCountryCodes;
            console.log(`📂 تم تحميل البيانات: ${config.bannedWords.length} كلمة، ${config.allowedCountryCodes.length} دولة`);
        }
    } catch (err) {
        console.log('⚠️ فشل تحميل البيانات، يستخدم config الافتراضي:', err.message);
    }
}

function saveData() {
    try {
        const data = {
            bannedWords: config.bannedWords,
            allowedCountryCodes: config.allowedCountryCodes
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.log('⚠️ فشل حفظ البيانات:', err.message);
    }
}

// تحميل البيانات عند البدء
loadData();

// ===== Web Server للـ QR Code =====
let currentQR = null;
const server = http.createServer(async (req, res) => {
    if (req.url === '/qr') {
        if (!currentQR) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><body style="text-align:center;padding:50px;font-family:sans-serif">
                <h2>✅ البوت متصل</h2>
                <script>setTimeout(()=>location.reload(),5000)</script>
            </body></html>`);
        } else {
            const qrImage = await qrcodeLib.toDataURL(currentQR);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<html><body style="text-align:center;padding:30px;background:#f0f0f0;font-family:sans-serif">
                <h2>📱 امسح هذا الكود بواتساب</h2>
                <img src="${qrImage}" style="width:300px;height:300px"/>
                <script>setTimeout(()=>location.reload(),30000)</script>
            </body></html>`);
        }
    } else {
        res.writeHead(302, { Location: '/qr' });
        res.end();
    }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🌐 http://localhost:${PORT}/qr`));

// ===== البوت =====
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process']
    }
});

const processingMessages = new Set();

// ===== إشعار الأدمن =====
async function notifyAdmin(name, number, groupName, message) {
    try {
        await client.sendMessage(config.adminNumber,
`🚨 *إشعار مخالفة*
👤 *المخالف:* ${name}
📞 *الرقم:* +${number}
👥 *المجموعة:* ${groupName}
💬 *الرسالة:* ${message}`);
    } catch (err) {
        console.log('⚠️ فشل إشعار الأدمن:', err.message);
    }
}

// ===== فحص الكلمات =====
function checkMessage(text) {
    if (!text) return null;
    const phonePatterns = [
        /(\+966|00966)[\s\-]?\d{7,9}/,
        /(\+967|00967)[\s\-]?\d{7,9}/,
        /\b05\d[\s\-]?\d{3}[\s\-]?\d{4}\b/,
        /\b9\d{8}\b/,
        /\b\d{10}\b/,
        /\+\d{7,13}/,
    ];
    for (const p of phonePatterns) if (p.test(text)) return '📵 رقم جوال';
    const norm = text.replace(/[أإآا]/g,'ا').replace(/[ةه]/g,'ه').replace(/ى/g,'ي').toLowerCase();
    for (const word of config.bannedWords) {
        const w = word.replace(/[أإآا]/g,'ا').replace(/[ةه]/g,'ه').replace(/ى/g,'ي').toLowerCase();
        if (norm.includes(w)) return `🚫 كلمة ممنوعة: "${word}"`;
    }
    return null;
}

// ===== فحص إذا المرسل أدمن — يدعم @lid و @c.us =====
function isGroupAdmin(chat, senderId) {
    const participants = chat.participants || [];
    const senderUser = senderId.replace('@c.us','').replace('@lid','').replace('@s.whatsapp.net','');
    for (const p of participants) {
        const pUser = p.id.user || '';
        if (pUser === senderUser) {
            return p.isAdmin || p.isSuperAdmin || false;
        }
    }
    return false;
}

// ===== فحص الدولة عند الدخول =====
client.on('group_join', async (notification) => {
    try {
        const chat = await notification.getChat();
        for (const id of notification.recipientIds) {
            if (id === client.info.wid._serialized) continue;

            let number = '';
            if (id.endsWith('@lid')) {
                try {
                    const contact = await client.getContactById(id);
                    number = contact.number || '';
                } catch {
                    console.log(`⚠️ ما قدر يجيب رقم @lid: ${id}`);
                    continue;
                }
            } else {
                number = id.replace('@c.us', '');
            }

            if (!number) continue;

            const isAllowed = config.allowedCountryCodes.some(code => number.startsWith(code));
            if (!isAllowed) {
                console.log(`🌍 طرد دولة غير مسموحة: ${number}`);
                await chat.removeParticipants([id]);
            }
        }
    } catch (err) {
        console.error('❌ خطأ فحص الدولة:', err.message);
    }
});

// ===== معالج رسائل المجموعة =====
client.on('message', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return;

        const msgId = msg.id._serialized;
        if (processingMessages.has(msgId)) return;
        processingMessages.add(msgId);
        setTimeout(() => processingMessages.delete(msgId), 10000);

        const senderId = msg.author || msg.from;
        const text = msg.body || '';
        const botNumber = client.info.wid.user;

        // ===== أوامر ! =====
        if (text.trim().startsWith('!')) {
            const isOwner = msg.fromMe;
            const adminCheck = isGroupAdmin(chat, senderId);
            if (!isOwner && !adminCheck) return;

            const cmd = text.trim();
            console.log(`⚙️ أمر: "${cmd}"`);

            if (cmd.startsWith('!اضف دولة ')) {
                const code = cmd.replace('!اضف دولة ','').trim();
                if (code && !config.allowedCountryCodes.includes(code)) {
                    config.allowedCountryCodes.push(code);
                    saveData(); // ✅ حفظ فوري
                    await chat.sendMessage(`✅ تمت إضافة الدولة: +${code}`);
                } else {
                    await chat.sendMessage(`⚠️ الكود موجود مسبقاً أو فارغ`);
                }
            } else if (cmd.startsWith('!احذف دولة ')) {
                const code = cmd.replace('!احذف دولة ','').trim();
                const i = config.allowedCountryCodes.indexOf(code);
                if (i > -1) {
                    config.allowedCountryCodes.splice(i, 1);
                    saveData(); // ✅ حفظ فوري
                    await chat.sendMessage(`🗑️ تم حذف الدولة: +${code}`);
                } else {
                    await chat.sendMessage(`⚠️ الكود غير موجود`);
                }
            } else if (cmd === '!الدول') {
                await chat.sendMessage(`🌍 *الدول المسموحة:*\n\n${config.allowedCountryCodes.map((c,i)=>`${i+1}. +${c}`).join('\n')}`);
            } else if (cmd.startsWith('!اضف ')) {
                const word = cmd.replace('!اضف ','').trim();
                if (word && !config.bannedWords.includes(word)) {
                    config.bannedWords.push(word);
                    saveData(); // ✅ حفظ فوري
                    await chat.sendMessage(`✅ تمت إضافة الكلمة: "${word}"`);
                } else {
                    await chat.sendMessage(`⚠️ الكلمة موجودة مسبقاً أو فارغة`);
                }
            } else if (cmd.startsWith('!احذف ')) {
                const word = cmd.replace('!احذف ','').trim();
                const i = config.bannedWords.indexOf(word);
                if (i > -1) {
                    config.bannedWords.splice(i, 1);
                    saveData(); // ✅ حفظ فوري
                    await chat.sendMessage(`🗑️ تم حذف الكلمة: "${word}"`);
                } else {
                    await chat.sendMessage(`⚠️ الكلمة غير موجودة`);
                }
            } else if (cmd === '!الكلمات') {
                const list = config.bannedWords.length
                    ? config.bannedWords.map((w,i)=>`${i+1}. ${w}`).join('\n')
                    : 'لا توجد كلمات ممنوعة حالياً';
                await chat.sendMessage(`📋 *الكلمات الممنوعة:*\n\n${list}`);
            } else if (cmd === '!مساعدة') {
                await chat.sendMessage(
                    `🤖 *أوامر البوت:*\n\n` +
                    `!اضف [كلمة] — إضافة كلمة ممنوعة\n` +
                    `!احذف [كلمة] — حذف كلمة ممنوعة\n` +
                    `!الكلمات — عرض الكلمات\n` +
                    `!اضف دولة [كود] — مثال: !اضف دولة 971\n` +
                    `!احذف دولة [كود]\n` +
                    `!الدول — عرض الدول المسموحة\n` +
                    `!مساعدة — هذه القائمة`
                );
            }
            return;
        }

        // ===== فحص المنشن — طرد يدوي من الأدمن =====
        const mentionedIds = (msg._data && msg._data.mentionedJidList) || [];
        const botMentioned = mentionedIds.some(id =>
            id.replace('@c.us','').replace('@s.whatsapp.net','') === botNumber
        );

        if (botMentioned) {
            const isOwner = msg.fromMe;
            const adminCheck = isGroupAdmin(chat, senderId);
            console.log(`👮 منشن | senderId: ${senderId} | isAdmin: ${adminCheck}`);

            if (!isOwner && !adminCheck) return;

            if (!msg.hasQuotedMsg) {
                await chat.sendMessage('⚠️ ردّ على رسالة الشخص المراد طرده ثم منشن البوت.');
                return;
            }

            const quotedMsg = await msg.getQuotedMessage();
            const targetId = quotedMsg.author || quotedMsg.from;
            if (!targetId || targetId === client.info.wid._serialized) return;

            const targetContact = await client.getContactById(targetId).catch(() => null);
            const targetName = targetContact?.pushname || targetId.replace('@c.us','') || 'مجهول';

            // ✅ حذف رسالة المخالف (المقتبسة) فقط — ليس رسالة الأدمن
            try {
                await quotedMsg.delete(true);
                console.log(`🗑️ تم حذف رسالة المخالف`);
            } catch (e) {
                console.log(`⚠️ فشل حذف رسالة المخالف: ${e.message}`);
            }

            // إرسال رسالة خاصة للمطرود
            try { await client.sendMessage(targetId, config.messages.privateWarning); } catch {}

            await new Promise(r => setTimeout(r, 500));

            // طرد العضو
            try {
                await chat.removeParticipants([targetId]);
                console.log(`✅ طرد يدوي: ${targetName}`);
            } catch (e) {
                console.log(`⚠️ فشل الطرد: ${e.message}`);
            }

            // رسالة القروب
            await chat.sendMessage(`🚫 تم طرد *${targetName}* من قبل الإدارة`);
            return;
        }

        // ===== فحص المخالفات التلقائية =====
        if (msg.fromMe) return;

        const violation = checkMessage(text);
        if (!violation) return;

        const contact = await msg.getContact();
        const name = contact.pushname || contact.number || 'مجهول';
        const number = senderId.replace('@c.us','').replace('@lid','');

        console.log(`🚨 مخالفة من ${name}: ${violation}`);

        // حذف الرسالة
        try { await msg.delete(true); } catch {}

        // إشعار الأدمن
        await notifyAdmin(name, number, chat.name || '', text);

        // رسالة خاصة للمخالف
        try { await client.sendMessage(senderId, config.messages.privateWarning); } catch {}

        await new Promise(r => setTimeout(r, 500));

        // طرد العضو
        try {
            await chat.removeParticipants([senderId]);
            await chat.sendMessage(config.messages.groupNotice);
            console.log(`✅ تم طرد ${name}`);
        } catch (kickErr) {
            console.error(`❌ فشل الطرد:`, kickErr.message);
        }

    } catch (err) {
        console.error('❌ خطأ:', err.message);
    }
});

// ===== بدء البوت =====
client.on('qr', (qr) => { currentQR = qr; qrcode.generate(qr, { small: true }); console.log('📱 QR جاهز'); });
client.on('ready', () => { currentQR = null; console.log('\n✅ البوت جاهز!\n📋 الكلمات:', config.bannedWords.length); });
client.on('auth_failure', () => console.error('❌ فشل المصادقة'));
client.on('disconnected', (r) => { console.log('🔌 انقطع:', r); client.initialize(); });
client.initialize();
