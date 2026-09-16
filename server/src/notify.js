// Лёгкий слой уведомлений: бот пишет участникам кассы лично (в личку), без группового
// чата — см. обсуждение архитектуры. groups.js вызывает notify() как best-effort побочный
// эффект после изменений в базе; сама отправка никогда не блокирует и не валит API-ответ.

let bot = null;
let webappUrl = '';

export function initNotifier(botInstance, url) {
  bot = botInstance;
  webappUrl = url || '';
}

export function notify(telegramId, text, groupId) {
  if (!bot || !telegramId) return;

  const opts = {};
  if (groupId) {
    const url = `${webappUrl}?startapp=${encodeURIComponent(groupId)}`;
    opts.reply_markup = { inline_keyboard: [[{ text: 'Открыть кассу', web_app: { url } }]] };
  }

  bot.telegram.sendMessage(telegramId, text, opts).catch(() => {
    // Пользователь мог не открывать бота (нет chat_id) или заблокировать его — просто пропускаем.
  });
}
