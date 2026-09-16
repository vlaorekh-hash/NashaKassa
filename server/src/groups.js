import { nanoid } from 'nanoid';
import { db, upsertUser } from './db.js';
import { notify } from './notify.js';
import { currentItem as currentAssemblyItem } from './assembly.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isoInDays(days) {
  return new Date(Date.now() + days * DAY_MS).toISOString();
}

function money(n) {
  return new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
}

export function createGroup(creator, { name, type, amount, frequency_days, goal_amount, goal_deadline }) {
  if (!name || !name.trim()) throw httpError(400, 'name_required');
  if (!['rotation', 'goal'].includes(type)) throw httpError(400, 'bad_type');
  if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'bad_amount');
  const freq = Number.isFinite(frequency_days) && frequency_days > 0 ? frequency_days : 30;

  upsertUser(creator);
  const id = nanoid(10);

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO groups (id, name, type, amount, frequency_days, goal_amount, goal_deadline, created_by)
      VALUES (@id, @name, @type, @amount, @frequency_days, @goal_amount, @goal_deadline, @created_by)
    `).run({
      id,
      name: name.trim(),
      type,
      amount,
      frequency_days: freq,
      goal_amount: type === 'goal' ? (goal_amount || null) : null,
      goal_deadline: type === 'goal' ? (goal_deadline || null) : null,
      created_by: creator.telegram_id,
    });

    db.prepare(`
      INSERT INTO group_members (group_id, telegram_id, join_order) VALUES (?, ?, 1)
    `).run(id, creator.telegram_id);

    const periodEnd = type === 'goal' && goal_deadline ? goal_deadline : isoInDays(freq);
    db.prepare(`
      INSERT INTO cycles (group_id, cycle_number, recipient_telegram_id, period_end)
      VALUES (?, 1, ?, ?)
    `).run(id, type === 'rotation' ? creator.telegram_id : null, periodEnd);
  });
  tx();

  return getGroupDetail(id, creator.telegram_id);
}

export function joinGroup(groupId, user) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) throw httpError(404, 'group_not_found');
  if (group.status !== 'active') throw httpError(400, 'group_archived');

  upsertUser(user);

  const existing = db.prepare(
    'SELECT * FROM group_members WHERE group_id = ? AND telegram_id = ?'
  ).get(groupId, user.telegram_id);
  if (existing) return getGroupDetail(groupId, user.telegram_id);

  const { maxOrder } = db.prepare(
    'SELECT COALESCE(MAX(join_order), 0) AS maxOrder FROM group_members WHERE group_id = ?'
  ).get(groupId);

  db.prepare(`
    INSERT INTO group_members (group_id, telegram_id, join_order) VALUES (?, ?, ?)
  `).run(groupId, user.telegram_id, maxOrder + 1);

  const others = db.prepare(
    'SELECT telegram_id FROM group_members WHERE group_id = ? AND telegram_id != ? AND active = 1'
  ).all(groupId, user.telegram_id);
  for (const o of others) {
    notify(o.telegram_id, `${user.first_name} присоединился(-ась) к кассе «${group.name}».`, groupId);
  }

  return getGroupDetail(groupId, user.telegram_id);
}

export function listMyGroups(telegramId) {
  return db.prepare(`
    SELECT g.* FROM groups g
    JOIN group_members m ON m.group_id = g.id
    WHERE m.telegram_id = ? AND m.active = 1
    ORDER BY g.created_at DESC
  `).all(telegramId);
}

export function getGroupDetail(groupId, requesterId) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) throw httpError(404, 'group_not_found');

  const members = db.prepare(`
    SELECT m.telegram_id, m.join_order, m.active, u.first_name, u.username
    FROM group_members m JOIN users u ON u.telegram_id = m.telegram_id
    WHERE m.group_id = ? ORDER BY m.join_order ASC
  `).all(groupId);

  const isMember = members.some((m) => m.telegram_id === requesterId);
  if (!isMember) throw httpError(403, 'not_a_member');

  const creator = db.prepare(
    'SELECT telegram_id, first_name, username, payment_details FROM users WHERE telegram_id = ?'
  ).get(group.created_by);

  // Казначей: кому физически переводят взносы и кто выдаёт займы из общей суммы.
  // По умолчанию (пока не проведено учредительное собрание) — это создатель кассы.
  const treasurerId = group.treasurer_telegram_id || group.created_by;
  const treasurer = treasurerId === group.created_by
    ? creator
    : db.prepare(
        'SELECT telegram_id, first_name, username, payment_details FROM users WHERE telegram_id = ?'
      ).get(treasurerId);

  const cycle = db.prepare(`
    SELECT * FROM cycles WHERE group_id = ? AND status = 'open' ORDER BY cycle_number DESC LIMIT 1
  `).get(groupId);

  let contributions = [];
  let recipient = null;
  if (cycle) {
    contributions = db.prepare(`
      SELECT c.*, u.first_name, u.username FROM contributions c
      JOIN users u ON u.telegram_id = c.telegram_id
      WHERE c.cycle_id = ? ORDER BY c.created_at ASC
    `).all(cycle.id);

    if (cycle.recipient_telegram_id) {
      recipient = db.prepare(
        'SELECT telegram_id, first_name, username, payment_details FROM users WHERE telegram_id = ?'
      ).get(cycle.recipient_telegram_id);
    }
  }

  const activeMembers = members.filter((m) => m.active);
  const expectedTotal = group.type === 'rotation' ? group.amount * activeMembers.length : null;
  const confirmedTotal = contributions
    .filter((c) => c.status === 'confirmed')
    .reduce((sum, c) => sum + c.amount, 0);

  let fundTotal = null;
  let outstandingLoans = null;
  let availableBalance = null;
  let loans = [];

  if (group.type === 'goal') {
    ({ fundTotal, outstandingLoans } = getFundBalances(groupId));
    availableBalance = fundTotal - outstandingLoans;

    const rawLoans = db.prepare(`
      SELECT l.*, u.first_name AS borrower_first_name, u.username AS borrower_username
      FROM loans l JOIN users u ON u.telegram_id = l.borrower_telegram_id
      WHERE l.group_id = ? ORDER BY l.created_at DESC
    `).all(groupId);

    const approvals = db.prepare(`
      SELECT a.*, u.first_name, u.username FROM loan_approvals a
      JOIN users u ON u.telegram_id = a.telegram_id
      WHERE a.loan_id IN (SELECT id FROM loans WHERE group_id = ?)
    `).all(groupId);

    loans = rawLoans.map((loan) => {
      const loanApprovals = approvals.filter((a) => a.loan_id === loan.id);
      const votersNeeded = activeMembers.filter((m) => m.telegram_id !== loan.borrower_telegram_id).length;
      const approvedCount = loanApprovals.filter((a) => a.decision === 'approved').length;
      return {
        ...loan,
        approvals: loanApprovals,
        votersNeeded,
        approvedCount,
      };
    });
  }

  let assembly = null;
  if (group.type === 'goal') {
    const latest = db.prepare(
      'SELECT * FROM assemblies WHERE group_id = ? ORDER BY id DESC LIMIT 1'
    ).get(groupId);
    if (latest) {
      const openItem = currentAssemblyItem(latest);
      let votesCount = 0;
      if (openItem) {
        votesCount = db.prepare(
          'SELECT COUNT(*) AS n FROM assembly_votes WHERE assembly_id = ? AND item = ?'
        ).get(latest.id, openItem).n;
      }
      assembly = { ...latest, currentItem: openItem, votesCount, totalMembers: activeMembers.length };
    }
  }

  return {
    group,
    members,
    creator,
    treasurer,
    cycle: cycle
      ? {
          ...cycle,
          recipient,
          contributions,
          expectedTotal,
          confirmedTotal,
        }
      : null,
    fundTotal,
    outstandingLoans,
    availableBalance,
    loans,
    assembly,
    isCreator: group.created_by === requesterId,
    isTreasurer: treasurerId === requesterId,
  };
}

export function contribute(groupId, cycleId, user, amount) {
  const { group, cycle } = assertOpenCycle(groupId, cycleId);
  assertMember(groupId, user.telegram_id);
  upsertUser(user);

  db.prepare(`
    INSERT INTO contributions (cycle_id, telegram_id, amount, status)
    VALUES (?, ?, ?, 'pending')
    ON CONFLICT(cycle_id, telegram_id) DO UPDATE SET amount = excluded.amount, status = 'pending',
      confirmed_by = NULL, confirmed_at = NULL
  `).run(cycle.id, user.telegram_id, amount);

  // Кому нужно подтвердить получение: в ротационной кассе — получателю цикла,
  // в накопительной — казначею (по умолчанию это создатель, пока не выбран другой).
  const confirmerId = group.type === 'rotation' ? cycle.recipient_telegram_id : (group.treasurer_telegram_id || group.created_by);
  if (confirmerId && confirmerId !== user.telegram_id) {
    notify(confirmerId, `${user.first_name} отметил(а) взнос ${money(amount)} в кассе «${group.name}» — нужно подтвердить получение.`, groupId);
  }

  return getGroupDetail(groupId, user.telegram_id);
}

export function confirmContribution(groupId, cycleId, payerTelegramId, confirmer) {
  const { group, cycle } = assertOpenCycle(groupId, cycleId);
  const treasurerId = group.treasurer_telegram_id || group.created_by;
  const canConfirm = group.created_by === confirmer.telegram_id
    || treasurerId === confirmer.telegram_id
    || cycle.recipient_telegram_id === confirmer.telegram_id;
  if (!canConfirm) throw httpError(403, 'only_recipient_or_creator_can_confirm');

  const row = db.prepare(
    'SELECT * FROM contributions WHERE cycle_id = ? AND telegram_id = ?'
  ).get(cycle.id, payerTelegramId);
  if (!row) throw httpError(404, 'contribution_not_found');

  db.prepare(`
    UPDATE contributions SET status = 'confirmed', confirmed_by = ?, confirmed_at = datetime('now')
    WHERE id = ?
  `).run(confirmer.telegram_id, row.id);

  if (payerTelegramId !== confirmer.telegram_id) {
    notify(payerTelegramId, `Ваш взнос ${money(row.amount)} в кассе «${group.name}» подтверждён ✓`, groupId);
  }

  return getGroupDetail(groupId, confirmer.telegram_id);
}

export function closeCycleAndRotate(groupId, cycleId, requester, { force = false } = {}) {
  const { group, cycle } = assertOpenCycle(groupId, cycleId);
  const treasurerId = group.treasurer_telegram_id || group.created_by;
  const canClose = group.created_by === requester.telegram_id
    || treasurerId === requester.telegram_id
    || cycle.recipient_telegram_id === requester.telegram_id;
  if (!canClose) throw httpError(403, 'only_recipient_or_creator_can_close');

  const members = db.prepare(
    'SELECT * FROM group_members WHERE group_id = ? AND active = 1 ORDER BY join_order ASC'
  ).all(groupId);

  if (!force && group.type === 'rotation') {
    const confirmedCount = db.prepare(
      `SELECT COUNT(*) AS n FROM contributions WHERE cycle_id = ? AND status = 'confirmed'`
    ).get(cycle.id).n;
    if (confirmedCount < members.length) {
      throw httpError(409, 'not_all_confirmed');
    }
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE cycles SET status = 'closed' WHERE id = ?`).run(cycle.id);

    const nextNumber = cycle.cycle_number + 1;
    const periodEnd = new Date(Date.now() + group.frequency_days * DAY_MS).toISOString();

    if (group.type === 'rotation') {
      const nextIndex = (cycle.cycle_number) % members.length; // 0-based next recipient
      const nextRecipient = members[nextIndex].telegram_id;
      db.prepare(`
        INSERT INTO cycles (group_id, cycle_number, recipient_telegram_id, period_end)
        VALUES (?, ?, ?, ?)
      `).run(groupId, nextNumber, nextRecipient, periodEnd);
    } else {
      // goal-касса: получателя нет, просто открываем следующий период сбора взносов
      // (например следующий месяц накопления НЗ) — старые взносы навсегда остаются
      // в общей сумме fundTotal, доступной для займов.
      db.prepare(`
        INSERT INTO cycles (group_id, cycle_number, recipient_telegram_id, period_end)
        VALUES (?, ?, NULL, ?)
      `).run(groupId, nextNumber, periodEnd);
    }
  });
  tx();

  if (group.type === 'rotation') {
    const nextIndex = (cycle.cycle_number) % members.length;
    const nextRecipient = members[nextIndex].telegram_id;
    const nextRecipientUser = db.prepare('SELECT first_name FROM users WHERE telegram_id = ?').get(nextRecipient);
    const expectedTotal = group.amount * members.length;
    for (const m of members) {
      const text = m.telegram_id === nextRecipient
        ? `Цикл в кассе «${group.name}» закрыт — теперь ваша очередь получать выплату: ${money(expectedTotal)}.`
        : `Цикл в кассе «${group.name}» закрыт. Следующий получатель — ${nextRecipientUser?.first_name || 'участник группы'}.`;
      notify(m.telegram_id, text, groupId);
    }
  } else {
    for (const m of members) {
      notify(m.telegram_id, `Открыт новый период сбора взносов в кассе «${group.name}» — не забудьте отметить взнос ${money(group.amount)}.`, groupId);
    }
  }

  return getGroupDetail(groupId, requester.telegram_id);
}

// --- НЗ / займы (только для goal-касс) ---

function getFundBalances(groupId) {
  const fundTotal = db.prepare(`
    SELECT COALESCE(SUM(c.amount), 0) AS total FROM contributions c
    JOIN cycles cy ON cy.id = c.cycle_id
    WHERE cy.group_id = ? AND c.status = 'confirmed'
  `).get(groupId).total;

  const outstandingLoans = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM loans WHERE group_id = ? AND status = 'approved'
  `).get(groupId).total;

  return { fundTotal, outstandingLoans };
}

export function requestLoan(groupId, user, { amount, reason, term_days }) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) throw httpError(404, 'group_not_found');
  if (group.type !== 'goal') throw httpError(400, 'loans_only_for_goal_groups');
  assertMember(groupId, user.telegram_id);
  upsertUser(user);

  if (!Number.isFinite(amount) || amount <= 0) throw httpError(400, 'bad_amount');
  const days = Number.isFinite(term_days) && term_days > 0 ? term_days : 30;

  const { fundTotal, outstandingLoans } = getFundBalances(groupId);
  const available = fundTotal - outstandingLoans;
  if (amount > available) throw httpError(400, 'insufficient_funds');

  const dueDate = isoInDays(days);
  db.prepare(`
    INSERT INTO loans (group_id, borrower_telegram_id, amount, reason, due_date)
    VALUES (?, ?, ?, ?, ?)
  `).run(groupId, user.telegram_id, amount, (reason || '').trim().slice(0, 300) || null, dueDate);

  const voters = db.prepare(
    'SELECT telegram_id FROM group_members WHERE group_id = ? AND telegram_id != ? AND active = 1'
  ).all(groupId, user.telegram_id);
  const reasonText = reason ? ` На: «${reason.trim().slice(0, 300)}».` : '';
  for (const v of voters) {
    notify(v.telegram_id, `${user.first_name} запросил(а) заём ${money(amount)} из фонда кассы «${group.name}».${reasonText} Нужно ваше согласие.`, groupId);
  }

  return getGroupDetail(groupId, user.telegram_id);
}

export function decideLoan(groupId, loanId, user, decision) {
  if (!['approved', 'rejected'].includes(decision)) throw httpError(400, 'bad_decision');
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) throw httpError(404, 'group_not_found');
  assertMember(groupId, user.telegram_id);

  const loan = db.prepare('SELECT * FROM loans WHERE id = ? AND group_id = ?').get(loanId, groupId);
  if (!loan) throw httpError(404, 'loan_not_found');
  if (loan.status !== 'pending') throw httpError(400, 'loan_not_pending');
  if (loan.borrower_telegram_id === user.telegram_id) throw httpError(400, 'borrower_cannot_vote');

  let finalStatus = null;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO loan_approvals (loan_id, telegram_id, decision)
      VALUES (?, ?, ?)
      ON CONFLICT(loan_id, telegram_id) DO UPDATE SET decision = excluded.decision, created_at = datetime('now')
    `).run(loanId, user.telegram_id, decision);

    const isMajorityRule = group.loan_approval_rule === 'majority';

    if (decision === 'rejected' && !isMajorityRule) {
      // Единогласное правило (по умолчанию): одного отказа достаточно, чтобы займ не состоялся.
      db.prepare(`UPDATE loans SET status = 'rejected', decided_at = datetime('now') WHERE id = ?`).run(loanId);
      finalStatus = 'rejected';
      return;
    }

    const activeMembers = db.prepare(
      'SELECT telegram_id FROM group_members WHERE group_id = ? AND active = 1'
    ).all(groupId);
    const votersNeeded = activeMembers
      .filter((m) => m.telegram_id !== loan.borrower_telegram_id)
      .map((m) => m.telegram_id);

    const decided = db.prepare(
      'SELECT telegram_id, decision FROM loan_approvals WHERE loan_id = ?'
    ).all(loanId).filter((r) => votersNeeded.includes(r.telegram_id));
    const approvedIds = decided.filter((r) => r.decision === 'approved').map((r) => r.telegram_id);
    const rejectedIds = decided.filter((r) => r.decision === 'rejected').map((r) => r.telegram_id);

    if (isMajorityRule) {
      const majorityThreshold = Math.floor(votersNeeded.length / 2) + 1;
      if (approvedIds.length >= majorityThreshold) {
        db.prepare(`UPDATE loans SET status = 'approved', decided_at = datetime('now') WHERE id = ?`).run(loanId);
        finalStatus = 'approved';
      } else if (rejectedIds.length >= majorityThreshold || decided.length === votersNeeded.length) {
        // Большинство против, либо все проголосовали и большинства "за" не набралось.
        db.prepare(`UPDATE loans SET status = 'rejected', decided_at = datetime('now') WHERE id = ?`).run(loanId);
        finalStatus = 'rejected';
      }
    } else {
      const allApproved = votersNeeded.length > 0 && votersNeeded.every((id) => approvedIds.includes(id));
      if (allApproved) {
        db.prepare(`UPDATE loans SET status = 'approved', decided_at = datetime('now') WHERE id = ?`).run(loanId);
        finalStatus = 'approved';
      }
    }
  });
  tx();

  const treasurerId = group.treasurer_telegram_id || group.created_by;
  if (finalStatus === 'rejected') {
    const ruleText = group.loan_approval_rule === 'majority' ? 'большинством участников' : 'для выдачи займа нужно согласие всех участников';
    notify(loan.borrower_telegram_id, `Заём ${money(loan.amount)} в кассе «${group.name}» отклонён — ${ruleText}.`, groupId);
  } else if (finalStatus === 'approved') {
    const ruleText = group.loan_approval_rule === 'majority' ? 'большинством голосов' : 'единогласно';
    notify(loan.borrower_telegram_id, `Заём ${money(loan.amount)} в кассе «${group.name}» одобрен ${ruleText}.`, groupId);
    if (treasurerId !== loan.borrower_telegram_id) {
      notify(treasurerId, `Заём ${money(loan.amount)} в кассе «${group.name}» одобрен — можно выдавать.`, groupId);
    }
  }

  return getGroupDetail(groupId, user.telegram_id);
}

export function markLoanRepaid(groupId, loanId, user) {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ? AND group_id = ?').get(loanId, groupId);
  if (!loan) throw httpError(404, 'loan_not_found');
  if (loan.status !== 'approved') throw httpError(400, 'loan_not_approved');
  if (loan.borrower_telegram_id !== user.telegram_id) throw httpError(403, 'only_borrower_can_mark');

  db.prepare(`UPDATE loans SET repay_marked_at = datetime('now') WHERE id = ?`).run(loanId);

  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  const treasurerId = group ? (group.treasurer_telegram_id || group.created_by) : null;
  if (treasurerId && treasurerId !== user.telegram_id) {
    notify(treasurerId, `${user.first_name} отметил(а) возврат займа ${money(loan.amount)} в кассе «${group.name}» — подтвердите получение.`, groupId);
  }

  return getGroupDetail(groupId, user.telegram_id);
}

export function confirmLoanRepaid(groupId, loanId, confirmer) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) throw httpError(404, 'group_not_found');
  const treasurerId = group.treasurer_telegram_id || group.created_by;
  if (treasurerId !== confirmer.telegram_id) throw httpError(403, 'only_treasurer_can_confirm');

  const loan = db.prepare('SELECT * FROM loans WHERE id = ? AND group_id = ?').get(loanId, groupId);
  if (!loan) throw httpError(404, 'loan_not_found');
  if (loan.status !== 'approved') throw httpError(400, 'loan_not_approved');

  db.prepare(`
    UPDATE loans SET status = 'repaid', repay_confirmed_by = ?, repay_confirmed_at = datetime('now')
    WHERE id = ?
  `).run(confirmer.telegram_id, loanId);

  if (loan.borrower_telegram_id !== confirmer.telegram_id) {
    notify(loan.borrower_telegram_id, `Возврат займа ${money(loan.amount)} в кассе «${group.name}» подтверждён, спасибо!`, groupId);
  }

  return getGroupDetail(groupId, confirmer.telegram_id);
}

export function setPaymentDetails(user, text) {
  upsertUser(user);
  db.prepare('UPDATE users SET payment_details = ? WHERE telegram_id = ?').run(text || null, user.telegram_id);
}

// --- helpers ---

function assertMember(groupId, telegramId) {
  const m = db.prepare(
    'SELECT 1 FROM group_members WHERE group_id = ? AND telegram_id = ? AND active = 1'
  ).get(groupId, telegramId);
  if (!m) throw httpError(403, 'not_a_member');
}

function assertOpenCycle(groupId, cycleId) {
  const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
  if (!group) throw httpError(404, 'group_not_found');
  const cycle = db.prepare('SELECT * FROM cycles WHERE id = ? AND group_id = ?').get(cycleId, groupId);
  if (!cycle) throw httpError(404, 'cycle_not_found');
  if (cycle.status !== 'open') throw httpError(400, 'cycle_closed');
  return { group, cycle };
}

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}
