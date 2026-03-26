const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrcodeLib = require('qrcode');
const http = require('http');
const config = require('./config');

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

// ===== الدالة الرئيسية للطرد =====
async function kickMember(chat, targetId, reason) {
    try {
        await client.sendMessage(targetId, config.messages.privateWarning);
    } catch {}
    await new Promise(r => setTimeout(r, 500));
    await chat.removeParticipants([targetId]);
    await chat.sendMessage(config.messages.groupNotice);
    console.log(`✅ تم طرد ${targetId} | السبب: ${reason}`);
}

// ===== فحص الدولة عند الدخول =====
client.on('group_join', async (notification) => {
    try {
        const chat = await notification.getChat();
        for (const id of notification.recipientIds) {
            if (id === client.info.wid._serialized) continue;
            if (id.endsWith('@lid')) continue;
            const number = id.replace('@c.us', '');
            const isAllowed = config.allowedCountryCodes.some(code => number.startsWith(code));
            if (!isAllowed) {
                console.log(`🌍 طرد دولة غير مسموحة: ${number}`);
                await chat.removeParticipants([id]);
                await chat.sendMessage(config.messages.foreignKick);
            }
        }
    } catch (err) {
        console.error('❌ خطأ فحص الدولة:', err.message);
    }
});

// ===== معالج موحّد لجميع الرسائل =====
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

        // ===== تشخيص =====
        console.log(`📨 رسالة | من: ${senderId} | نص: "${text.substring(0,50)}" | ردّ: ${msg.hasQuotedMsg}`);

        // ===== فحص المنشن =====
        const botId = client.info.wid._serialized; // مثال: 249125058815@c.us
        const botNumber = client.info.wid.user;     // مثال: 249125058815
        const mentionedIds = (msg._data && msg._data.mentionedJidList) || [];

        // نفحص إذا المنشن يحتوي رقم البوت بأي صيغة
        const botMentioned = mentionedIds.length > 0 && (
            mentionedIds.some(id => id.includes(botNumber)) ||
            mentionedIds.some(id => id.replace('@lid','').replace('@c.us','') === botNumber) ||
            mentionedIds.length === 1  // إذا في منشن واحد فقط في رسالة الأدمن نفترض أنه البوت
        );

        console.log(`🤖 botId: ${botId} | botNumber: ${botNumber} | mentions: ${JSON.stringify(mentionedIds)} | botMentioned: ${botMentioned}`);

        if (botMentioned) {
            // تحقق أن المرسل أدمن
            const participants = chat.participants;
            const sender = participants.find(p => p.id._serialized === senderId);
            const isAdmin = sender && (sender.isAdmin || sender.isSuperAdmin);

            console.log(`👮 isAdmin: ${isAdmin}`);

            if (!isAdmin) return;

            if (!msg.hasQuotedMsg) {
                await chat.sendMessage('⚠️ ردّ على رسالة الشخص المراد طرده ثم منشن البوت.');
                return;
            }

            const quotedMsg = await msg.getQuotedMessage();
            const targetId = quotedMsg.author || quotedMsg.from;
            if (targetId === client.info.wid._serialized) return;

            const targetContact = await client.getContactById(targetId);
            const targetName = targetContact.pushname || targetId.replace('@c.us','') || 'مجهول';

            try { await quotedMsg.delete(true); } catch {}
            try { await msg.delete(true); } catch {}

            await kickMember(chat, targetId, 'منشن الأدمن');
            await chat.sendMessage(`🚫 تم طرد *${targetName}* بقرار من الإدارة.`);
            return;
        }

        // ===== فحص المخالفات =====
        if (senderId === client.info.wid._serialized) return;

        const violation = checkMessage(text);
        if (!violation) return;

        const contact = await msg.getContact();
        const name = contact.pushname || contact.number || 'مجهول';
        const number = senderId.replace('@c.us', '');

        console.log(`🚨 مخالفة من ${name}: ${violation}`);

        await msg.delete(true);
        await notifyAdmin(name, number, chat.name || '', text);
        await kickMember(chat, senderId, violation);

    } catch (err) {
        console.error('❌ خطأ:', err.message);
    }
});

// ===== أوامر الأدمن =====
client.on('message', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return;

        const senderId = msg.author || msg.from;
        const isOwner = senderId === client.info.wid._serialized;
        const participants = chat.participants;
        const sender = participants.find(p => p.id._serialized === senderId);
        const isAdmin = sender && (sender.isAdmin || sender.isSuperAdmin);
        if (!isOwner && !isAdmin) return;

        const text = msg.body.trim();
        if (!text.startsWith('!')) return;

        const cmdId = msg.id._serialized + '_cmd';
        if (processingMessages.has(cmdId)) return;
        processingMessages.add(cmdId);
        setTimeout(() => processingMessages.delete(cmdId), 5000);

        if (text.startsWith('!اضف دولة ')) {
            const code = text.replace('!اضف دولة ','').trim();
            if (code && !config.allowedCountryCodes.includes(code)) {
                config.allowedCountryCodes.push(code);
                await chat.sendMessage(`✅ تمت إضافة الدولة: +${code}`);
            }
        } else if (text.startsWith('!احذف دولة ')) {
            const code = text.replace('!احذف دولة ','').trim();
            const i = config.allowedCountryCodes.indexOf(code);
            if (i > -1) { config.allowedCountryCodes.splice(i,1); await chat.sendMessage(`🗑️ تم حذف الدولة: +${code}`); }
            else await chat.sendMessage(`⚠️ الكود غير موجود`);
        } else if (text === '!الدول') {
            await chat.sendMessage(`🌍 *الدول المسموحة:*\n\n${config.allowedCountryCodes.map((c,i)=>`${i+1}. +${c}`).join('\n')}`);
        } else if (text.startsWith('!اضف ')) {
            const word = text.replace('!اضف ','').trim();
            if (word && !config.bannedWords.includes(word)) {
                config.bannedWords.push(word);
                await chat.sendMessage(`✅ تمت إضافة الكلمة: "${word}"`);
            }
        } else if (text.startsWith('!احذف ')) {
            const word = text.replace('!احذف ','').trim();
            const i = config.bannedWords.indexOf(word);
            if (i > -1) { config.bannedWords.splice(i,1); await chat.sendMessage(`🗑️ تم حذف الكلمة: "${word}"`); }
            else await chat.sendMessage(`⚠️ الكلمة غير موجودة`);
        } else if (text === '!الكلمات') {
            await chat.sendMessage(`📋 *الكلمات الممنوعة:*\n\n${config.bannedWords.map((w,i)=>`${i+1}. ${w}`).join('\n')}`);
        } else if (text === '!مساعدة') {
            await chat.sendMessage(
                `🤖 *أوامر البوت:*\n\n` +
                `!اضف [كلمة] — إضافة كلمة ممنوعة\n` +
                `!احذف [كلمة] — حذف كلمة ممنوعة\n` +
                `!الكلمات — عرض الكلمات\n` +
                `!اضف دولة [كود]\n` +
                `!احذف دولة [كود]\n` +
                `!الدول — عرض الدول\n` +
                `!مساعدة — هذه القائمة`
            );
        }
    } catch (err) {
        console.error('❌ خطأ أمر:', err.message);
    }
});

// ===== بدء البوت =====
client.on('qr', (qr) => { currentQR = qr; qrcode.generate(qr, { small: true }); console.log('📱 QR جاهز'); });
client.on('ready', () => { currentQR = null; console.log('\n✅ البوت جاهز!\n📋 الكلمات:', config.bannedWords.length); });
client.on('auth_failure', () => console.error('❌ فشل المصادقة'));
client.on('disconnected', (r) => { console.log('🔌 انقطع:', r); client.initialize(); });
client.initialize();
