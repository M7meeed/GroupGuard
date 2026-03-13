const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('./config');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

// ===== فحص الرسائل =====
function checkMessage(text) {
    if (!text) return null;

    // 1. فحص أرقام الجوال
    const phonePatterns = [
        /(\+966|00966|0096 6)[\s\-]?\d{7,9}/,   // سعودي +966
        /(\+967|00967|0096 7)[\s\-]?\d{7,9}/,   // يمني +967
        /\b05\d[\s\-]?\d{3}[\s\-]?\d{4}\b/,     // 05X XXX XXXX
        /\b9\d{8}\b/,                             // 9 أرقام
        /\b\d{10}\b/,                             // 10 أرقام
        /\+\d{7,13}/,                             // أي رقم دولي
    ];

    for (const pattern of phonePatterns) {
        if (pattern.test(text)) {
            return '📵 رقم جوال';
        }
    }

    // 2. فحص الكلمات الممنوعة
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

        if (normalized.includes(normWord)) {
            return `🚫 كلمة ممنوعة: "${word}"`;
        }
    }

    return null;
}

// ===== فحص الدولة عند دخول عضو جديد =====
client.on('group_join', async (notification) => {
    try {
        const chat = await notification.getChat();

        for (const id of notification.recipientIds) {
            // تجاهل البوت نفسه
            if (id === client.info.wid._serialized) continue;

            // تجاهل الـ IDs بصيغة @lid (واتساب الجديد لا يكشف الدولة منها)
            if (id.endsWith('@lid')) {
                console.log(`⚠️ تجاهل ID بصيغة @lid: ${id}`);
                continue;
            }

            // استخراج رقم الجوال من الـ ID — الصيغة: 966XXXXXXXXX@c.us
            const number = id.replace('@c.us', '');

            const isAllowed = config.allowedCountryCodes.some(code => number.startsWith(code));

            if (!isAllowed) {
                const contact = await client.getContactById(id);
                const name = contact.pushname || number || 'مجهول';

                console.log(`🌍 عضو من دولة غير مسموحة: ${name} (${number})`);

                // طرد العضو
                await chat.removeParticipants([id]);
                console.log(`✅ تم طرد ${name}`);

                // إشعار المجموعة
                const msg = config.messages.foreignKick.replace('{name}', name);
                await chat.sendMessage(msg);
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

        // فقط في المجموعات
        if (!chat.isGroup) return;

        // تجاهل رسائل البوت نفسه
        if (msg.fromMe) return;

        const text = msg.body || '';
        const violation = checkMessage(text);

        if (!violation) return;

        const contact = await msg.getContact();
        const name = contact.pushname || contact.number || 'مجهول';

        console.log(`🚨 مخالفة من ${name}: ${violation}`);

        // 1. حذف الرسالة
        await msg.delete(true);
        console.log(`✅ تم حذف رسالة ${name}`);

        const senderId = msg.author || msg.from;

        // 2. رسالة خاصة للمخالف قبل الطرد
        try {
            const privateMsg = config.messages.privateWarning
                .replace('{reason}', violation);
            await client.sendMessage(senderId, privateMsg);
        } catch (pmErr) {
            console.log(`⚠️ ما قدر يرسل رسالة خاصة`);
        }

        // 3. طرد العضو
        await new Promise(r => setTimeout(r, 1000));
        try {
            await chat.removeParticipants([senderId]);
            console.log(`✅ تم طرد ${name}`);
            // رسالة قصيرة في المجموعة
            await chat.sendMessage(config.messages.groupNotice);
        } catch (kickErr) {
            console.error(`❌ فشل الطرد:`, kickErr.message);
        }

    } catch (err) {
        console.error('❌ خطأ:', err.message);
    }
});

// ===== أوامر الأدمن =====
client.on('message_create', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return;

        // السماح لصاحب البوت أو أي أدمن في المجموعة
        const isOwner = msg.fromMe;
        const participants = chat.participants;
        const sender = participants.find(p =>
            p.id._serialized === msg.author || p.id._serialized === msg.from
        );
        const isAdmin = sender && (sender.isAdmin || sender.isSuperAdmin);

        if (!isOwner && !isAdmin) return;

        const text = msg.body.trim();

        // أمر: !اضف كلمة
        if (text.startsWith('!اضف ')) {
            const word = text.replace('!اضف ', '').trim();
            if (word && !config.bannedWords.includes(word)) {
                config.bannedWords.push(word);
                await chat.sendMessage(`✅ تمت إضافة الكلمة: "${word}"`);
                console.log(`➕ كلمة جديدة: ${word}`);
            }
        }

        // أمر: !احذف كلمة
        else if (text.startsWith('!احذف ')) {
            const word = text.replace('!احذف ', '').trim();
            const index = config.bannedWords.indexOf(word);
            if (index > -1) {
                config.bannedWords.splice(index, 1);
                await chat.sendMessage(`🗑️ تم حذف الكلمة: "${word}"`);
            } else {
                await chat.sendMessage(`⚠️ الكلمة غير موجودة: "${word}"`);
            }
        }

        // أمر: !الكلمات
        else if (text === '!الكلمات') {
            const list = config.bannedWords.map((w, i) => `${i + 1}. ${w}`).join('\n');
            await chat.sendMessage(`📋 *الكلمات الممنوعة:*\n\n${list}`);
        }

        // أمر: !مساعدة
        else if (text === '!مساعدة') {
            await chat.sendMessage(
                `🤖 *أوامر البوت:*\n\n` +
                `*الكلمات الممنوعة:*\n` +
                `!اضف [كلمة] — إضافة كلمة ممنوعة\n` +
                `!احذف [كلمة] — حذف كلمة ممنوعة\n` +
                `!الكلمات — عرض جميع الكلمات الممنوعة\n\n` +
                `*الدول المسموحة:*\n` +
                `!اضف دولة [كود] — مثال: !اضف دولة 971\n` +
                `!احذف دولة [كود] — مثال: !احذف دولة 971\n` +
                `!الدول — عرض الدول المسموحة\n\n` +
                `!مساعدة — عرض هذه القائمة`
            );
        }

        // أمر: !اضف دولة
        else if (text.startsWith('!اضف دولة ')) {
            const code = text.replace('!اضف دولة ', '').trim();
            if (code && !config.allowedCountryCodes.includes(code)) {
                config.allowedCountryCodes.push(code);
                await chat.sendMessage(`✅ تمت إضافة الدولة: +${code}`);
            }
        }

        // أمر: !احذف دولة
        else if (text.startsWith('!احذف دولة ')) {
            const code = text.replace('!احذف دولة ', '').trim();
            const index = config.allowedCountryCodes.indexOf(code);
            if (index > -1) {
                config.allowedCountryCodes.splice(index, 1);
                await chat.sendMessage(`🗑️ تم حذف الدولة: +${code}`);
            } else {
                await chat.sendMessage(`⚠️ الكود غير موجود: ${code}`);
            }
        }

        // أمر: !الدول
        else if (text === '!الدول') {
            const list = config.allowedCountryCodes.map((c, i) => `${i + 1}. +${c}`).join('\n');
            await chat.sendMessage(`🌍 *الدول المسموحة:*\n\n${list}`);
        }

    } catch (err) {
        console.error('❌ خطأ في الأمر:', err.message);
    }
});

// ===== بدء البوت =====
client.on('qr', (qr) => {
    console.log('\n📱 امسح هذا الكود بواتساب:\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('\n✅ البوت جاهز ويعمل!\n');
    console.log('📋 الكلمات الممنوعة المفعّلة:', config.bannedWords.length);
});

client.on('auth_failure', () => {
    console.error('❌ فشل في المصادقة، احذف مجلد .wwebjs_auth وأعد التشغيل');
});

client.on('disconnected', (reason) => {
    console.log('🔌 انقطع الاتصال:', reason);
    client.initialize();
});

client.initialize();
