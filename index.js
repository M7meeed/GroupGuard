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
            res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:50px">
                <h2>✅ البوت متصل أو QR لم يُولَّد بعد</h2>
                <p>انتظر قليلاً وأعد تحديث الصفحة</p>
                <script>setTimeout(()=>location.reload(),5000)</script>
            </body></html>`);
        } else {
            try {
                const qrImage = await qrcodeLib.toDataURL(currentQR);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<html><body style="font-family:sans-serif;text-align:center;padding:30px;background:#f0f0f0">
                    <h2>📱 امسح هذا الكود بواتساب</h2>
                    <img src="${qrImage}" style="width:300px;height:300px;border:10px solid white;border-radius:10px"/>
                    <p style="color:gray">الصفحة تتحدث تلقائياً كل 30 ثانية</p>
                    <script>setTimeout(()=>location.reload(),30000)</script>
                </body></html>`);
            } catch (e) {
                res.writeHead(500);
                res.end('Error generating QR');
            }
        }
    } else {
        res.writeHead(302, { Location: '/qr' });
        res.end();
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`\n🌐 افتح هذا الرابط لمسح QR Code:\n   http://localhost:${PORT}/qr\n`);
});

// ===== البوت =====
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--no-first-run',
            '--no-default-browser-check',
            '--single-process'
        ]
    }
});

// ===== منع التكرار =====
const processingMessages = new Set();

// ===== إشعار الأدمن =====
async function notifyAdmin(name, number, groupName, message) {
    try {
        const text =
`🚨 *إشعار مخالفة*

👤 *المخالف:* ${name}
📞 *الرقم:* +${number}
👥 *المجموعة:* ${groupName}

💬 *الرسالة المخالفة:*
${message}`;
        await client.sendMessage(config.adminNumber, text);
    } catch (err) {
        console.log('⚠️ ما قدر يرسل إشعار للأدمن:', err.message);
    }
}

// ===== فحص الرسائل =====
function checkMessage(text) {
    if (!text) return null;

    const phonePatterns = [
        /(\+966|00966|0096 6)[\s\-]?\d{7,9}/,
        /(\+967|00967|0096 7)[\s\-]?\d{7,9}/,
        /\b05\d[\s\-]?\d{3}[\s\-]?\d{4}\b/,
        /\b9\d{8}\b/,
        /\b\d{10}\b/,
        /\+\d{7,13}/,
    ];

    for (const pattern of phonePatterns) {
        if (pattern.test(text)) return '📵 رقم جوال';
    }

    const normalized = text
        .replace(/[أإآا]/g, 'ا')
        .replace(/[ةه]/g, 'ه')
        .replace(/ى/g, 'ي')
        .toLowerCase();

    for (const word of config.bannedWords) {
        const normWord = word
            .replace(/[أإآا]/g, 'ا')
            .replace(/[ةه]/g, 'ه')
            .replace(/ى/g, 'ي')
            .toLowerCase();
        if (normalized.includes(normWord)) return `🚫 كلمة ممنوعة: "${word}"`;
    }

    return null;
}

// ===== فحص الدولة عند دخول عضو جديد =====
client.on('group_join', async (notification) => {
    try {
        const chat = await notification.getChat();
        for (const id of notification.recipientIds) {
            if (id === client.info.wid._serialized) continue;
            if (id.endsWith('@lid')) { console.log(`⚠️ تجاهل @lid: ${id}`); continue; }
            const number = id.replace('@c.us', '');
            const isAllowed = config.allowedCountryCodes.some(code => number.startsWith(code));
            if (!isAllowed) {
                const contact = await client.getContactById(id);
                const name = contact.pushname || number || 'مجهول';
                console.log(`🌍 طرد من دولة غير مسموحة: ${name}`);
                await chat.removeParticipants([id]);
                await chat.sendMessage(config.messages.foreignKick);
            }
        }
    } catch (err) {
        console.error('❌ خطأ في فحص الدولة:', err.message);
    }
});

// ===== معالجة الرسائل =====
client.on('message_create', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup || msg.fromMe) return;

        // منع التكرار — تجاهل الرسالة إذا تمت معالجتها
        const msgId = msg.id._serialized;
        if (processingMessages.has(msgId)) return;
        processingMessages.add(msgId);
        setTimeout(() => processingMessages.delete(msgId), 10000);

        const text = msg.body || '';
        const violation = checkMessage(text);
        if (!violation) return;

        const contact = await msg.getContact();
        const name = contact.pushname || contact.number || 'مجهول';
        const number = (msg.author || msg.from).replace('@c.us', '');
        const groupName = chat.name || 'غير معروف';

        console.log(`🚨 مخالفة من ${name}: ${violation}`);

        // 1. حذف الرسالة
        await msg.delete(true);

        const senderId = msg.author || msg.from;

        // 2. إشعار الأدمن
        await notifyAdmin(name, number, groupName, text);

        // 3. رسالة خاصة للمخالف
        try {
            await client.sendMessage(senderId, config.messages.privateWarning);
        } catch {}

        // 4. طرد العضو
        await new Promise(r => setTimeout(r, 1000));
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

// ===== طرد عن طريق المنشن =====
client.on('message_create', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup || msg.fromMe) return;

        // تحقق أن المرسل أدمن
        const participants = chat.participants;
        const sender = participants.find(p =>
            p.id._serialized === msg.author || p.id._serialized === msg.from
        );
        const isAdmin = sender && (sender.isAdmin || sender.isSuperAdmin);
        if (!isAdmin) return;

        // تشخيص — نطبع كل رسائل الأدمن
        const botNumber = client.info.wid.user;
        const msgBody = msg.body || '';
        const mentionedIds = (msg._data && msg._data.mentionedJidList) || [];
        console.log(`🔍 رسالة أدمن: "${msgBody}" | hasQuoted: ${msg.hasQuotedMsg} | mentions: ${JSON.stringify(mentionedIds)} | botNumber: ${botNumber}`);

        // فحص المنشن
        const botMentionedInIds = mentionedIds.some(id => id.includes(botNumber));
        const botMentionedInText = msgBody.includes('@' + botNumber);
        const botMentioned = botMentionedInIds || botMentionedInText ||
                             (msg.mentionedIds && msg.mentionedIds.some(id => id.includes(botNumber)));

        console.log(`🤖 botMentioned: ${botMentioned} | inIds: ${botMentionedInIds} | inText: ${botMentionedInText}`);

        if (!botMentioned) return;

        // تحقق أن الرسالة ردّ على رسالة شخص
        if (!msg.hasQuotedMsg) {
            await chat.sendMessage('⚠️ ردّ على الرسالة المراد حذفها ثم منشن البوت.');
            return;
        }

        const quotedMsg = await msg.getQuotedMessage();
        const targetId = quotedMsg.author || quotedMsg.from;

        // لا تطرد البوت أو الأدمن نفسه
        if (targetId === client.info.wid._serialized) return;

        const targetContact = await client.getContactById(targetId);
        const targetName = targetContact.pushname || targetId.replace('@c.us', '') || 'مجهول';

        // حذف الرسالة المنشن عليها
        try { await quotedMsg.delete(true); } catch {}
        // حذف رسالة الأدمن
        try { await msg.delete(true); } catch {}

        // رسالة خاصة للمطرود
        try {
            await client.sendMessage(targetId, config.messages.privateWarning);
        } catch {}

        // طرد العضو
        await new Promise(r => setTimeout(r, 500));
        try {
            await chat.removeParticipants([targetId]);
            await chat.sendMessage(`🚫 تم طرد *${targetName}* بقرار من الإدارة.`);
            console.log(`✅ تم طرد ${targetName} بواسطة منشن الأدمن`);
        } catch (err) {
            console.error('❌ فشل الطرد بالمنشن:', err.message);
        }

    } catch (err) {
        console.error('❌ خطأ في المنشن:', err.message);
    }
});

// ===== أوامر الأدمن =====
client.on('message_create', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return;

        // منع التكرار للأوامر
        const msgId = msg.id._serialized + '_cmd';
        if (processingMessages.has(msgId)) return;

        const isOwner = msg.fromMe;
        const participants = chat.participants;
        const sender = participants.find(p => p.id._serialized === msg.author || p.id._serialized === msg.from);
        const isAdmin = sender && (sender.isAdmin || sender.isSuperAdmin);
        if (!isOwner && !isAdmin) return;

        processingMessages.add(msgId);
        setTimeout(() => processingMessages.delete(msgId), 5000);

        const text = msg.body.trim();

        if (text.startsWith('!اضف دولة ')) {
            const code = text.replace('!اضف دولة ', '').trim();
            if (code && !config.allowedCountryCodes.includes(code)) {
                config.allowedCountryCodes.push(code);
                await chat.sendMessage(`✅ تمت إضافة الدولة: +${code}`);
            }
        } else if (text.startsWith('!احذف دولة ')) {
            const code = text.replace('!احذف دولة ', '').trim();
            const index = config.allowedCountryCodes.indexOf(code);
            if (index > -1) { config.allowedCountryCodes.splice(index, 1); await chat.sendMessage(`🗑️ تم حذف الدولة: +${code}`); }
            else await chat.sendMessage(`⚠️ الكود غير موجود: ${code}`);
        } else if (text === '!الدول') {
            await chat.sendMessage(`🌍 *الدول المسموحة:*\n\n${config.allowedCountryCodes.map((c, i) => `${i+1}. +${c}`).join('\n')}`);
        } else if (text.startsWith('!اضف ')) {
            const word = text.replace('!اضف ', '').trim();
            if (word && !config.bannedWords.includes(word)) {
                config.bannedWords.push(word);
                await chat.sendMessage(`✅ تمت إضافة الكلمة: "${word}"`);
            }
        } else if (text.startsWith('!احذف ')) {
            const word = text.replace('!احذف ', '').trim();
            const index = config.bannedWords.indexOf(word);
            if (index > -1) { config.bannedWords.splice(index, 1); await chat.sendMessage(`🗑️ تم حذف الكلمة: "${word}"`); }
            else await chat.sendMessage(`⚠️ الكلمة غير موجودة: "${word}"`);
        } else if (text === '!الكلمات') {
            await chat.sendMessage(`📋 *الكلمات الممنوعة:*\n\n${config.bannedWords.map((w, i) => `${i+1}. ${w}`).join('\n')}`);
        } else if (text === '!مساعدة') {
            await chat.sendMessage(
                `🤖 *أوامر البوت:*\n\n` +
                `!اضف [كلمة] — إضافة كلمة ممنوعة\n` +
                `!احذف [كلمة] — حذف كلمة ممنوعة\n` +
                `!الكلمات — عرض الكلمات الممنوعة\n` +
                `!اضف دولة [كود] — مثال: !اضف دولة 971\n` +
                `!احذف دولة [كود]\n` +
                `!الدول — عرض الدول المسموحة\n` +
                `!مساعدة — هذه القائمة`
            );
        }
    } catch (err) {
        console.error('❌ خطأ في الأمر:', err.message);
    }
});

// ===== بدء البوت =====
client.on('qr', (qr) => {
    currentQR = qr;
    console.log('\n📱 QR Code جاهز — افتح الرابط في المتصفح\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    currentQR = null;
    console.log('\n✅ البوت جاهز ويعمل!\n');
    console.log('📋 الكلمات الممنوعة:', config.bannedWords.length);
});

client.on('auth_failure', () => {
    console.error('❌ فشل المصادقة، احذف .wwebjs_auth وأعد التشغيل');
});

client.on('disconnected', (reason) => {
    console.log('🔌 انقطع الاتصال:', reason);
    client.initialize();
});

client.initialize();
