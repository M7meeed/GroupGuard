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
            res.end('<html><body style="text-align:center;padding:50px;font-family:sans-serif"><h2>البوت متصل</h2><script>setTimeout(()=>location.reload(),5000)</script></body></html>');
        } else {
            const qrImage = await qrcodeLib.toDataURL(currentQR);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<html><body style="text-align:center;padding:30px;background:#f0f0f0;font-family:sans-serif"><h2>امسح هذا الكود بواتساب</h2><img src="' + qrImage + '" style="width:300px;height:300px"/><script>setTimeout(()=>location.reload(),30000)</script></body></html>');
        }
    } else { res.writeHead(302, { Location: '/qr' }); res.end(); }
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🌐 http://localhost:' + PORT + '/qr'));

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
const recentJoins = new Set();

// ===== إشعار الأدمن =====
async function notifyAdmin(name, number, groupName, message) {
    try {
        await client.sendMessage(config.adminNumber,
            '🚨 *إشعار مخالفة*\n👤 *المخالف:* ' + name + '\n📞 *الرقم:* +' + number + '\n👥 *المجموعة:* ' + groupName + '\n💬 *الرسالة:* ' + message);
    } catch (e) { console.log('⚠️ فشل إشعار الأدمن'); }
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
    for (const p of phonePatterns) if (p.test(text)) return 'رقم جوال';
    const norm = text.replace(/[أإآا]/g,'ا').replace(/[ةه]/g,'ه').replace(/ى/g,'ي').toLowerCase();
    for (const word of config.bannedWords) {
        const w = word.replace(/[أإآا]/g,'ا').replace(/[ةه]/g,'ه').replace(/ى/g,'ي').toLowerCase();
        if (norm.includes(w)) return 'كلمة ممنوعة: ' + word;
    }
    return null;
}

// ===== فحص الأدمن =====
async function checkIsAdmin(chat, senderId) {
    try {
        const participants = chat.participants || [];
        const senderUser = senderId.replace('@c.us','').replace('@lid','');
        const found = participants.find(p => p.id._serialized === senderId || p.id.user === senderUser);
        if (found) return found.isAdmin || found.isSuperAdmin;
        const contact = await client.getContactById(senderId).catch(() => null);
        if (contact && contact.number) {
            const byNum = participants.find(p => p.id.user === contact.number);
            if (byNum) return byNum.isAdmin || byNum.isSuperAdmin;
        }
        return false;
    } catch { return false; }
}

// ===== طرد عضو =====
async function kickMember(chat, targetId, reason, groupMsg) {
    if (groupMsg === undefined) groupMsg = config.messages.groupNotice;
    try { await client.sendMessage(targetId, config.messages.privateWarning); } catch {}
    await new Promise(r => setTimeout(r, 500));
    await chat.removeParticipants([targetId]);
    if (groupMsg) await chat.sendMessage(groupMsg);
    console.log('✅ تم طرد ' + targetId + ' | ' + reason);
}

// ===== فحص الدولة عند الدخول =====
client.on('group_join', async (notification) => {
    try {
        const chat = await notification.getChat();
        const memberKey = (notification.recipientIds || []).sort().join(',') + '_' + chat.id._serialized;
        if (recentJoins.has(memberKey)) return;
        recentJoins.add(memberKey);
        setTimeout(() => recentJoins.delete(memberKey), 30000);

        let kicked = false;
        for (const id of notification.recipientIds) {
            if (id === client.info.wid._serialized) continue;
            let number = '';
            if (id.endsWith('@lid')) {
                try { const c = await client.getContactById(id); number = c.number || ''; } catch { continue; }
            } else { number = id.replace('@c.us', ''); }
            if (!number) continue;
            const isAllowed = config.allowedCountryCodes.some(code => number.startsWith(code));
            if (!isAllowed) {
                console.log('🌍 طرد دولة غير مسموحة: ' + number);
                await chat.removeParticipants([id]);
                kicked = true;
            }
        }
        if (kicked) await chat.sendMessage('🚫 تم طرد عضو غير مؤهل');
    } catch (err) { console.error('❌ خطأ دولة:', err.message); }
});

// ===== معالج الرسائل الموحّد =====
client.on('message', async (msg) => {
    try {
        const chat = await msg.getChat();
        if (!chat.isGroup) return;

        const msgId = msg.id._serialized;
        if (processingMessages.has(msgId)) return;
        processingMessages.add(msgId);
        setTimeout(() => processingMessages.delete(msgId), 10000);

        const senderId = msg.author || msg.from;
        const text = (msg.body || '').trim();
        const botNumber = client.info.wid.user;

        // ===== أوامر الأدمن =====
        if (text.startsWith('!')) {
            const isAdmin = await checkIsAdmin(chat, senderId);
            console.log('⚙️ أمر: "' + text + '" | isAdmin: ' + isAdmin + ' | sender: ' + senderId);
            if (!isAdmin) return;

            if (text.startsWith('!اضف دولة ')) {
                const code = text.replace('!اضف دولة ','').trim();
                if (code && !config.allowedCountryCodes.includes(code)) { config.allowedCountryCodes.push(code); await chat.sendMessage('✅ تمت إضافة الدولة: +' + code); }
            } else if (text.startsWith('!احذف دولة ')) {
                const code = text.replace('!احذف دولة ','').trim();
                const i = config.allowedCountryCodes.indexOf(code);
                if (i > -1) { config.allowedCountryCodes.splice(i,1); await chat.sendMessage('🗑️ تم حذف الدولة: +' + code); }
                else await chat.sendMessage('⚠️ الكود غير موجود');
            } else if (text === '!الدول') {
                await chat.sendMessage('🌍 *الدول المسموحة:*\n\n' + config.allowedCountryCodes.map((c,i) => (i+1) + '. +' + c).join('\n'));
            } else if (text.startsWith('!اضف ')) {
                const word = text.replace('!اضف ','').trim();
                if (word && !config.bannedWords.includes(word)) { config.bannedWords.push(word); await chat.sendMessage('✅ تمت إضافة الكلمة: "' + word + '"'); }
            } else if (text.startsWith('!احذف ')) {
                const word = text.replace('!احذف ','').trim();
                const i = config.bannedWords.indexOf(word);
                if (i > -1) { config.bannedWords.splice(i,1); await chat.sendMessage('🗑️ تم حذف الكلمة: "' + word + '"'); }
                else await chat.sendMessage('⚠️ الكلمة غير موجودة');
            } else if (text === '!الكلمات') {
                await chat.sendMessage('📋 *الكلمات الممنوعة:*\n\n' + config.bannedWords.map((w,i) => (i+1) + '. ' + w).join('\n'));
            } else if (text === '!مساعدة') {
                await chat.sendMessage('🤖 *أوامر البوت:*\n\n!اضف [كلمة]\n!احذف [كلمة]\n!الكلمات\n!اضف دولة [كود]\n!احذف دولة [كود]\n!الدول\n!مساعدة');
            }
            return;
        }

        // ===== فحص المنشن — للأدمن فقط =====
        const mentionedIds = (msg._data && msg._data.mentionedJidList) || [];
        const botMentioned = mentionedIds.length > 0 && (
            mentionedIds.some(id => id.includes(botNumber)) || mentionedIds.length === 1
        );

        if (botMentioned) {
            const isAdmin = await checkIsAdmin(chat, senderId);
            console.log('👮 منشن | isAdmin: ' + isAdmin + ' | sender: ' + senderId);
            if (!isAdmin) return;

            if (!msg.hasQuotedMsg) {
                await chat.sendMessage('⚠️ ردّ على رسالة الشخص المراد طرده ثم منشن البوت.');
                return;
            }

            const quotedMsg = await msg.getQuotedMessage();
            const targetId = quotedMsg.author || quotedMsg.from;
            if (targetId === client.info.wid._serialized) return;

            const targetContact = await client.getContactById(targetId).catch(() => null);
            const targetName = (targetContact && targetContact.pushname) || targetId.replace('@c.us','') || 'مجهول';

            try { await quotedMsg.delete(true); } catch {}
            await kickMember(chat, targetId, 'منشن الأدمن', null);
            await chat.sendMessage('🚫 تم طرد *' + targetName + '* من قبل الإدارة');
            return;
        }

        // ===== فحص المخالفات التلقائية =====
        if (senderId === client.info.wid._serialized) return;
        const violation = checkMessage(text);
        if (!violation) return;

        const contact = await msg.getContact();
        const name = contact.pushname || contact.number || 'مجهول';
        const number = senderId.replace('@c.us', '');

        console.log('🚨 مخالفة من ' + name + ': ' + violation);
        await msg.delete(true);
        await notifyAdmin(name, number, chat.name || '', text);
        await kickMember(chat, senderId, violation);

    } catch (err) { console.error('❌ خطأ:', err.message); }
});

// ===== بدء البوت =====
client.on('qr', (qr) => { currentQR = qr; qrcode.generate(qr, {small:true}); console.log('📱 QR جاهز'); });
client.on('ready', () => { currentQR = null; console.log('\n✅ البوت جاهز!\n📋 الكلمات: ' + config.bannedWords.length); });
client.on('auth_failure', () => console.error('❌ فشل المصادقة'));
client.on('disconnected', (r) => { console.log('🔌 انقطع:', r); client.initialize(); });
client.initialize();
