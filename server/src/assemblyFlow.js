// Склеивает чистую логику голосования (assembly.js) с отправкой сообщений через бота
// (notify.js). Вызывается и из routes.js (запуск собрания через кнопку в мини-аппе),
// и из bot.js (обработка голоса — нажатия inline-кнопки в личке).

import {
  startAssembly as dbStartAssembly,
  castVote as dbCastVote,
  activeMembersOf,
  getGroup,
} from './assembly.js';
import { notify, sendWithButtons } from './notify.js';

function money(n) {
  return new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
}

function itemMessage(group, assembly, members, item) {
  if (item === 'treasurer') {
    const text =
      `Учредительное собрание «${group.name}» от ${new Date().toLocaleDateString('ru-RU')} началось. ` +
      `Задача — утвердить основные правила и устав группы.\n\n` +
      `Пункт 1. Выборы казначея. Казначей хранит на своём счету все взносы участников кассы, ` +
      `выдаёт деньги по решению участников кассы и т.д.\n\nВыберите казначея:`;
    const buttons = members.map((m, i) => [
      { text: `${i + 1}. ${m.first_name}`, callback_data: `av:${assembly.id}:treasurer:${m.telegram_id}` },
    ]);
    return { text, buttons };
  }

  if (item === 'goal') {
    const text =
      `Пункт 2. Цель и взносы. Предлагается установить цель коллективного НЗ в размере ` +
      `${money(assembly.proposed_goal_amount || 0)}, ежемесячный взнос установить в размере ` +
      `${money(assembly.proposed_monthly_amount)} с 1 участника.`;
    const buttons = [[
      { text: 'Да', callback_data: `av:${assembly.id}:goal:yes` },
      { text: 'Нет', callback_data: `av:${assembly.id}:goal:no` },
    ]];
    return { text, buttons };
  }

  // loan_rule
  const text = `Пункт 3 (последний). Решение о выдаче займа из НЗ. Принимается:`;
  const buttons = [[
    { text: '1. Единогласно', callback_data: `av:${assembly.id}:loan_rule:unanimous` },
    { text: '2. Большинством голосов', callback_data: `av:${assembly.id}:loan_rule:majority` },
  ]];
  return { text, buttons };
}

function broadcastItem(group, assembly, members, item) {
  const { text, buttons } = itemMessage(group, assembly, members, item);
  for (const m of members) sendWithButtons(m.telegram_id, text, buttons);
}

const RESULT_TEXT = {
  treasurer: (assembly, members) =>
    `Пункт 1 решён: казначеем избран(а) ${members.find((m) => m.telegram_id === assembly.result_treasurer_id)?.first_name || '—'}.`,
  goal: (assembly) =>
    `Пункт 2 решён: предложение по цели и взносу ${assembly.result_goal_decision === 'yes' ? 'принято' : 'не набрало большинства'}.`,
  loan_rule: (assembly) =>
    `Пункт 3 решён: займы из НЗ будут одобряться ${assembly.result_loan_rule === 'majority' ? 'большинством голосов' : 'единогласно'}.`,
};

export function startAssemblyFlow(groupId, requester, params) {
  const assembly = dbStartAssembly(groupId, requester, params);
  const group = getGroup(groupId);
  const members = activeMembersOf(groupId);
  broadcastItem(group, assembly, members, 'treasurer');
  return assembly;
}

// Вызывается при нажатии inline-кнопки голосования (bot.js) — возвращает текст всплывающего
// уведомления для ctx.answerCbQuery, а сама рассылка следующего пункта/устава — побочный эффект.
export function recordVote(assemblyId, telegramId, item, choice) {
  const result = dbCastVote(assemblyId, telegramId, item, choice);

  if (!result.itemResolved) {
    return { ok: true, toast: 'Голос принят ✓' };
  }

  const { assembly, nextItem, members, group } = result;

  const resultText = RESULT_TEXT[result.itemResolved](assembly, members);
  for (const m of members) notify(m.telegram_id, resultText, group.id);

  if (nextItem) {
    broadcastItem(group, assembly, members, nextItem);
  } else {
    for (const m of members) {
      notify(m.telegram_id, 'Собрание окончено. Устав сформирован и будет отправлен каждому участнику.', group.id);
    }
    for (const m of members) {
      notify(m.telegram_id, assembly.charter_text, null);
    }
  }

  return { ok: true, toast: 'Голос принят ✓' };
}
