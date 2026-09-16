import { getInitData, getDevUser, isInsideTelegram } from './telegram.js';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };

  if (isInsideTelegram()) {
    headers['X-Telegram-Init-Data'] = getInitData();
  } else {
    // Dev-режим вне Telegram: работает только если на сервере DEV_ALLOW_INSECURE=1.
    headers['X-Debug-User'] = encodeURIComponent(JSON.stringify(getDevUser()));
  }

  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data.error;
    throw err;
  }
  return data;
}

export const api = {
  me: () => request('GET', '/me'),
  setPaymentDetails: (payment_details) => request('PUT', '/me/payment-details', { payment_details }),
  myGroups: () => request('GET', '/groups'),
  createGroup: (payload) => request('POST', '/groups', payload),
  group: (id) => request('GET', `/groups/${id}`),
  join: (id) => request('POST', `/groups/${id}/join`),
  contribute: (id, cycleId, amount) => request('POST', `/groups/${id}/cycles/${cycleId}/contribute`, { amount }),
  confirm: (id, cycleId, telegram_id) => request('POST', `/groups/${id}/cycles/${cycleId}/confirm`, { telegram_id }),
  closeCycle: (id, cycleId, force = false) => request('POST', `/groups/${id}/cycles/${cycleId}/close`, { force }),
  requestLoan: (id, payload) => request('POST', `/groups/${id}/loans`, payload),
  decideLoan: (id, loanId, decision) => request('POST', `/groups/${id}/loans/${loanId}/decide`, { decision }),
  markLoanRepaid: (id, loanId) => request('POST', `/groups/${id}/loans/${loanId}/mark-repaid`),
  confirmLoanRepaid: (id, loanId) => request('POST', `/groups/${id}/loans/${loanId}/confirm-repaid`),
  startAssembly: (id, payload) => request('POST', `/groups/${id}/assembly`, payload),
  updateSettings: (id, payload) => request('PUT', `/groups/${id}/settings`, payload),
};
