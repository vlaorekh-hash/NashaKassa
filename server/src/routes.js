import { Router } from 'express';
import {
  createGroup,
  joinGroup,
  listMyGroups,
  getGroupDetail,
  contribute,
  confirmContribution,
  closeCycleAndRotate,
  setPaymentDetails,
  requestLoan,
  decideLoan,
  markLoanRepaid,
  confirmLoanRepaid,
} from './groups.js';

export const router = Router();

function currentUser(req) {
  const u = req.tgUser;
  return {
    telegram_id: u.id,
    first_name: u.first_name || 'Без имени',
    username: u.username || null,
  };
}

function handle(fn) {
  return (req, res) => {
    try {
      const result = fn(req);
      res.json(result ?? { ok: true });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: err.code || 'internal_error' });
    }
  };
}

router.get('/me', handle((req) => ({ user: currentUser(req) })));

router.put('/me/payment-details', handle((req) => {
  setPaymentDetails(currentUser(req), String(req.body.payment_details || '').slice(0, 300));
  return { ok: true };
}));

router.get('/groups', handle((req) => ({ groups: listMyGroups(req.tgUser.id) })));

router.post('/groups', handle((req) => {
  const { name, type, amount, frequency_days, goal_amount, goal_deadline } = req.body;
  return createGroup(currentUser(req), {
    name,
    type,
    amount: Number(amount),
    frequency_days: Number(frequency_days),
    goal_amount: goal_amount ? Number(goal_amount) : null,
    goal_deadline: goal_deadline || null,
  });
}));

router.get('/groups/:id', handle((req) => getGroupDetail(req.params.id, req.tgUser.id)));

router.post('/groups/:id/join', handle((req) => joinGroup(req.params.id, currentUser(req))));

router.post('/groups/:id/cycles/:cycleId/contribute', handle((req) => {
  const amount = Number(req.body.amount);
  return contribute(req.params.id, Number(req.params.cycleId), currentUser(req), amount);
}));

router.post('/groups/:id/cycles/:cycleId/confirm', handle((req) => {
  const payerId = Number(req.body.telegram_id);
  return confirmContribution(req.params.id, Number(req.params.cycleId), payerId, currentUser(req));
}));

router.post('/groups/:id/cycles/:cycleId/close', handle((req) => {
  return closeCycleAndRotate(req.params.id, Number(req.params.cycleId), currentUser(req), {
    force: Boolean(req.body.force),
  });
}));

router.post('/groups/:id/loans', handle((req) => {
  const { amount, reason, term_days } = req.body;
  return requestLoan(req.params.id, currentUser(req), {
    amount: Number(amount),
    reason,
    term_days: Number(term_days),
  });
}));

router.post('/groups/:id/loans/:loanId/decide', handle((req) => {
  return decideLoan(req.params.id, Number(req.params.loanId), currentUser(req), String(req.body.decision || ''));
}));

router.post('/groups/:id/loans/:loanId/mark-repaid', handle((req) => {
  return markLoanRepaid(req.params.id, Number(req.params.loanId), currentUser(req));
}));

router.post('/groups/:id/loans/:loanId/confirm-repaid', handle((req) => {
  return confirmLoanRepaid(req.params.id, Number(req.params.loanId), currentUser(req));
}));router.get('/me', handle((req) => ({ user: currentUser(req) })));

router.put('/me/payment-details', handle((req) => {
  setPaymentDetails(currentUser(req), String(req.body.payment_details || '').slice(0, 300));
  return { ok: true };
}));

router.get('/groups', handle((req) => ({ groups: listMyGroups(req.tgUser.id) })));

router.post('/groups', handle((req) => {
  const { name, type, amount, frequency_days, goal_amount, goal_deadline } = req.body;
  return createGroup(currentUser(req), {
    name,
    type,
    amount: Number(amount),
    frequency_days: Number(frequency_days),
    goal_amount: goal_amount ? Number(goal_amount) : null,
    goal_deadline: goal_deadline || null,
  });
}));

router.get('/groups/:id', handle((req) => getGroupDetail(req.params.id, req.tgUser.id)));

router.post('/groups/:id/join', handle((req) => joinGroup(req.params.id, currentUser(req))));

router.post('/groups/:id/cycles/:cycleId/contribute', handle((req) => {
  const amount = Number(req.body.amount);
  return contribute(req.params.id, Number(req.params.cycleId), currentUser(req), amount);
}));

router.post('/groups/:id/cycles/:cycleId/confirm', handle((req) => {
  const payerId = Number(req.body.telegram_id);
  return confirmContribution(req.params.id, Number(req.params.cycleId), payerId, currentUser(req));
}));

router.post('/groups/:id/cycles/:cycleId/close', handle((req) => {
  return closeCycleAndRotate(req.params.id, Number(req.params.cycleId), currentUser(req), {
    force: Boolean(req.body.force),
  });
}));
