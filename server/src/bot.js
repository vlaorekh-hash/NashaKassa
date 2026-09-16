import { Telegraf } from 'telegraf';
import { db } from './db.js';
import { recordVote } from './assemblyFlow.js';

export function createBot(botToken, webappUrl) {
  const bot = new Telegraf(botToken);

  // Голосование учредительного собрания — нажатие inline-кнопки в личке бота.
  // callback_data вида "av:<assemblyId>:<item>:<choice>".
  bot.action(/^av:(\d+):(treasurer|goal|loan_rule):(.+)$/, async (ctx) => {
    const [, assemblyId, item, choice] = ctx.match;
    try {
      const result = recordVote(Number(assemblyId), ctx.from.id, item, choice);
      await ctx.answerCbQuery(result.toast);
    } catch (err) {
      const toast = err.code === 'item_not_open'
        ? 'Этот пункт уже завершён'
        : err.code === 'not_a_member'
          ? 'Вы не участник этой кассы'
          : 'Не получилось учесть голос';
      await ctx.answerCbQuery(toast).catch(() => {});
      return;
    }
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  });

  bot.start((ctx) => {
    const startParam = ctx.startPayload; // deep-link payload, напр. groupId для приглашения
    const url = startParam ? `${webappUrl}?startapp=${encodeURIComponent(startParam)}` : webappUrl;
    return ctx.reply(
      'Привет! Это касса взаимопомощи — совместные накопления и ротационные кассы с друзьями.\n\n' +
        'Открой мини-приложение, чтобы создать кассу или посмотреть свои группы.',
      {
        reply_markup: {
          inline_keyboard: [[{ text: '📂 Открыть кассу', web_app: { url } }]],
        },
      }
    );
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      'Команды:\n/start — открыть мини-приложение\n\n' +
        'Приглашение в кассу — это ссылка вида t.me/<bot>?start=<id_кассы>, ' +
        'её можно взять на экране кассы внутри приложения.'
    )
  );

  return bot;
}

/**
 * Раз в час проверяет открытые циклы, у которых до окончания периода <= 2 дней,
 * и шлёт напоминание участникам, которые ещё не подтвердили взнос за этот цикл.
 */
export function startReminderSweep(bot, webappUrl, { intervalMs = 60 * 60 * 1000 } = {}) {
  const sweep = async () => {
    try {
      const soonCycles = db.prepare(`
        SELECT c.*, g.name AS group_name, g.id AS group_id
        FROM cycles c JOIN groups g ON g.id = c.group_id
        WHERE c.status = 'open'
          AND datetime(c.period_end) <= datetime('now', '+2 days')
      `).all();

      for (const cycle of soonCycles) {
        const members = db.prepare(
          'SELECT telegram_id FROM group_members WHERE group_id = ? AND active = 1'
        ).all(cycle.group_id);

        const confirmedOrPending = new Set(
          db.prepare('SELECT telegram_id FROM contributions WHERE cycle_id = ?')
            .all(cycle.id)
            .map((r) => r.telegram_id)
        );

        for (const m of members) {
          if (confirmedOrPending.has(m.telegram_id)) continue;
          const url = `${webappUrl}?startapp=${encodeURIComponent(cycle.group_id)}`;
          await bot.telegram
            .sendMessage(
              m.telegram_id,
              `Напоминание: в кассе «${cycle.group_name}» скоро закрывается цикл, а взнос ещё не отмечен.`,
              { reply_markup: { inline_keyboard: [[{ text: 'Открыть кассу', web_app: { url } }]] } }
            )
            .catch(() => {}); // пользователь мог не открывать бота — просто пропускаем
        }
      }
    } catch (err) {
      console.error('reminder sweep failed', err);
    }
  };

  sweep();
  return setInterval(sweep, intervalMs);
}
