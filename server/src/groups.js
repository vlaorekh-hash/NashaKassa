import { nanoid } from 'nanoid';
import { db, upsertUser } from './db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function isoInDays(days) {
  return new Date(Date.now() + days * DAY_MS).toISOString();
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

  return {
    group,
    members,
    cycle: cycle
      ? {
          ...cycle,
          recipient,
          contributions,
          expectedTotal,
          confirmedTotal,
        }
      : null,
    isCreator: group.created_by === requesterId,
  };
}

export function contribute(groupId, cycleId, user, amount) {
  const { cycle } = assertOpenCycle(groupId, cycleId);
  assertMember(groupId, user.telegram_id);
  upsertUser(user);

  db.prepare(`
    INSERT INTO contributions (cycle_id, telegram_id, amount, status)
    VALUES (?, ?, ?, 'pending')
    ON CONFLICT(cycle_id, telegram_id) DO UPDATE SET amount = excluded.amount, status = 'pending',
      confirmed_by = NULL, confirmed_at = NULL
  `).run(cycle.id, user.telegram_id, amount);

  return getGroupDetail(groupId, user.telegram_id);
}

export function confirmContribution(groupId, cycleId, payerTelegramId, confirmer) {
  const { group, cycle } = assertOpenCycle(groupId, cycleId);
  const canConfirm = group.created_by === confirmer.telegram_id || cycle.recipient_telegram_id === confirmer.telegram_id;
  if (!canConfirm) throw httpError(403, 'only_recipient_or_creator_can_confirm');

  const row = db.prepare(
    'SELECT * FROM contributions WHERE cycle_id = ? AND telegram_id = ?'
  ).get(cycle.id, payerTelegramId);
  if (!row) throw httpError(404, 'contribution_not_found');

  db.prepare(`
    UPDATE contributions SET status = 'confirmed', confirmed_by = ?, confirmed_at = datetime('now')
    WHERE id = ?
  `).run(confirmer.telegram_id, row.id);

  return getGroupDetail(groupId, confirmer.telegram_id);
}

export function closeCycleAndRotate(groupId, cycleId, requester, { force = false } = {}) {
  const { group, cycle } = assertOpenCycle(groupId, cycleId);
  const canClose = group.created_by === requester.telegram_id || cycle.recipient_telegram_id === requester.telegram_id;
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

    if (group.type === 'rotation') {
      const nextNumber = cycle.cycle_number + 1;
      const nextIndex = (cycle.cycle_number) % members.length; // 0-based next recipient
      const nextRecipient = members[nextIndex].telegram_id;
      const periodEnd = new Date(Date.now() + group.frequency_days * DAY_MS).toISOString();
      db.prepare(`
        INSERT INTO cycles (group_id, cycle_number, recipient_telegram_id, period_end)
        VALUES (?, ?, ?, ?)
      `).run(groupId, nextNumber, nextRecipient, periodEnd);
    }
  });
  tx();

  return getGroupDetail(groupId, requester.telegram_id);
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
