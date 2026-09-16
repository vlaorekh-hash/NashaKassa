// Учредительное собрание кассы: 3 пункта устава голосуются по очереди
// (казначей → цель/взнос → правило одобрения займов). Вся Telegram-специфика
// (отправка сообщений, кнопки, callback-и) живёт в assemblyFlow.js и bot.js —
// здесь только состояние в базе и подсчёт голосов.

import { db } from './db.js';

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function money(n) {
  return new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
}

export function getGroup(groupId) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
}

export function activeMembersOf(groupId) {
  return db.prepare(`
    SELECT m.telegram_id, m.join_order, u.first_name, u.username
    FROM group_members m JOIN users u ON u.telegram_id = m.telegram_id
    WHERE m.group_id = ? AND m.active = 1 ORDER BY m.join_order ASC
  `).all(groupId);
}

export function getActiveAssembly(groupId) {
  return db.prepare(
    `SELECT * FROM assemblies WHERE group_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
  ).get(groupId);
}

export function getLatestAssembly(groupId) {
  return db.prepare(`SELECT * FROM assemblies WHERE group_id = ? ORDER BY id DESC LIMIT 1`).get(groupId);
}

// Следующий пункт повестки, который ещё не решён (порядок фиксированный).
// null — собрание либо не активно, либо все три пункта уже решены.
export function currentItem(assembly) {
  if (!assembly || assembly.status !== 'active') return null;
  if (assembly.result_treasurer_id == null) return 'treasurer';
  if (assembly.result_goal_decision == null) return 'goal';
  if (assembly.result_loan_rule == null) return 'loan_rule';
  return null;
}

export function startAssembly(groupId, requester, { goal_amount, monthly_amount }) {
  const group = getGroup(groupId);
  if (!group) throw httpError(404, 'group_not_found');
  if (group.type !== 'goal') throw httpError(400, 'assembly_only_for_goal_groups');
  if (group.created_by !== requester.telegram_id) throw httpError(403, 'only_creator_can_start_assembly');
  if (getActiveAssembly(groupId)) throw httpError(409, 'assembly_already_active');

  if (!Number.isFinite(monthly_amount) || monthly_amount <= 0) throw httpError(400, 'bad_monthly_amount');
  const goalAmt = Number.isFinite(goal_amount) && goal_amount > 0 ? goal_amount : null;

  const info = db.prepare(`
    INSERT INTO assemblies (group_id, proposed_goal_amount, proposed_monthly_amount, started_by)
    VALUES (?, ?, ?, ?)
  `).run(groupId, goalAmt, monthly_amount, requester.telegram_id);

  return db.prepare('SELECT * FROM assemblies WHERE id = ?').get(info.lastInsertRowid);
}

function tallyVotes(assemblyId, item) {
  return db.prepare(
    'SELECT telegram_id, choice FROM assembly_votes WHERE assembly_id = ? AND item = ?'
  ).all(assemblyId, item);
}

function buildCharter(assembly, group, members) {
  const treasurer = members.find((m) => m.telegram_id === assembly.result_treasurer_id);
  const ruleText = assembly.result_loan_rule === 'majority'
    ? 'большинством голосов'
    : 'единогласно (согласие всех участников)';
  const goalLine = assembly.result_goal_decision === 'yes'
    ? `Цель — ${money(assembly.proposed_goal_amount || 0)}, ежемесячный взнос — ${money(assembly.proposed_monthly_amount)} с участника.`
    : `Предложение не набрало большинства — действуют прежние параметры кассы (взнос ${money(group.amount)}${group.goal_amount ? `, цель ${money(group.goal_amount)}` : ''}).`;
  const membersList = members.map((m, i) => `${i + 1}. ${m.first_name}`).join('\n');

  return `УСТАВ КАССЫ «${group.name}»
Принят на учредительном собрании ${new Date().toLocaleDateString('ru-RU')}

1. Казначей: ${treasurer ? treasurer.first_name : '—'}. Казначей хранит на своём счету взносы участников и выдаёт средства по решению кассы.
2. Цель и взносы: ${goalLine}
3. Займы из общего фонда: решение о выдаче займа принимается ${ruleText}.

Участники кассы на момент принятия устава:
${membersList}

Устав действует до изменения новым решением участников.`;
}

// Записывает голос участника по текущему открытому пункту. Если это был последний
// недостающий голос по пункту — подводит итог (и, если пункт был последним, завершает
// собрание и формирует устав). Возвращает достаточно данных, чтобы вызывающий код
// (assemblyFlow.js) разослал следующее сообщение или финальный устав.
export function castVote(assemblyId, telegramId, item, choice) {
  const assembly = db.prepare('SELECT * FROM assemblies WHERE id = ?').get(assemblyId);
  if (!assembly || assembly.status !== 'active') throw httpError(400, 'assembly_not_active');

  const openItem = currentItem(assembly);
  if (openItem !== item) throw httpError(400, 'item_not_open');

  const members = activeMembersOf(assembly.group_id);
  if (!members.some((m) => m.telegram_id === telegramId)) throw httpError(403, 'not_a_member');

  db.prepare(`
    INSERT INTO assembly_votes (assembly_id, item, telegram_id, choice)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(assembly_id, item, telegram_id) DO UPDATE SET choice = excluded.choice, created_at = datetime('now')
  `).run(assemblyId, item, telegramId, String(choice));

  const votes = tallyVotes(assemblyId, item);
  const votedIds = new Set(votes.map((v) => v.telegram_id));
  const allVoted = members.every((m) => votedIds.has(m.telegram_id));

  if (!allVoted) {
    return { itemResolved: null, votesCount: votes.length, totalNeeded: members.length };
  }

  const group = getGroup(assembly.group_id);

  if (item === 'treasurer') {
    const counts = new Map();
    for (const v of votes) counts.set(v.choice, (counts.get(v.choice) || 0) + 1);
    let winner = null;
    let winnerCount = -1;
    for (const m of members) { // порядок join_order — детерминированный тай-брейк в пользу более раннего участника
      const c = counts.get(String(m.telegram_id)) || 0;
      if (c > winnerCount) {
        winner = m.telegram_id;
        winnerCount = c;
      }
    }
    db.prepare('UPDATE assemblies SET result_treasurer_id = ? WHERE id = ?').run(winner, assemblyId);
    db.prepare('UPDATE groups SET treasurer_telegram_id = ? WHERE id = ?').run(winner, assembly.group_id);
  } else if (item === 'goal') {
    const yes = votes.filter((v) => v.choice === 'yes').length;
    const no = votes.filter((v) => v.choice === 'no').length;
    const decision = yes >= no ? 'yes' : 'no';
    db.prepare('UPDATE assemblies SET result_goal_decision = ? WHERE id = ?').run(decision, assemblyId);
    if (decision === 'yes') {
      db.prepare('UPDATE groups SET amount = ?, goal_amount = ? WHERE id = ?')
        .run(assembly.proposed_monthly_amount, assembly.proposed_goal_amount, assembly.group_id);
    }
  } else if (item === 'loan_rule') {
    const unanimous = votes.filter((v) => v.choice === 'unanimous').length;
    const majority = votes.filter((v) => v.choice === 'majority').length;
    const rule = majority > unanimous ? 'majority' : 'unanimous';
    db.prepare('UPDATE assemblies SET result_loan_rule = ? WHERE id = ?').run(rule, assemblyId);
    db.prepare('UPDATE groups SET loan_approval_rule = ? WHERE id = ?').run(rule, assembly.group_id);
  }

  let updated = db.prepare('SELECT * FROM assemblies WHERE id = ?').get(assemblyId);
  const nextItem = currentItem(updated);

  if (!nextItem) {
    const finalGroup = getGroup(assembly.group_id);
    const charterText = buildCharter(updated, finalGroup, members);
    db.prepare(`
      UPDATE assemblies SET status = 'completed', completed_at = datetime('now'), charter_text = ?
      WHERE id = ?
    `).run(charterText, assemblyId);
    updated = db.prepare('SELECT * FROM assemblies WHERE id = ?').get(assemblyId);
  }

  return {
    itemResolved: item,
    nextItem,
    assembly: updated,
    members,
    group: getGroup(assembly.group_id),
  };
}
