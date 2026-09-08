import { useEffect, useState, useCallback } from 'react';
import { initTelegram, getStartParam, isInsideTelegram, hapticSelection } from './telegram.js';
import { api } from './api.js';
import './App.css';

const BOT_USERNAME = import.meta.env.VITE_BOT_USERNAME || 'your_bot';

function inviteLink(groupId) {
  return `https://t.me/${BOT_USERNAME}?start=${groupId}`;
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

function money(n) {
  return new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
}

export default function App() {
  const [screen, setScreen] = useState({ name: 'loading' });
  const [groups, setGroups] = useState([]);
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);

  const loadGroups = useCallback(async () => {
    const res = await api.myGroups();
    setGroups(res.groups);
  }, []);

  useEffect(() => {
    initTelegram();
    (async () => {
      try {
        const meRes = await api.me();
        setMe(meRes.user);

        const startParam = getStartParam();
        if (startParam) {
          try {
            await api.join(startParam);
          } catch (e) {
            // уже участник или касса не найдена — просто продолжаем
          }
          await loadGroups();
          setScreen({ name: 'group', id: startParam });
          return;
        }

        await loadGroups();
        setScreen({ name: 'list' });
      } catch (e) {
        setError('Не удалось загрузить данные. Попробуйте перезапустить приложение.');
      }
    })();
  }, [loadGroups]);

  if (error) return <Centered>{error}</Centered>;
  if (screen.name === 'loading') return <Centered>Загрузка…</Centered>;

  return (
    <div className="app">
      {!isInsideTelegram() && (
        <div className="devBanner">Dev-режим вне Telegram — используется тестовый пользователь</div>
      )}

      {screen.name === 'list' && (
        <GroupsList
          groups={groups}
          me={me}
          onOpen={(id) => setScreen({ name: 'group', id })}
          onCreate={() => setScreen({ name: 'create' })}
          onProfile={() => setScreen({ name: 'profile' })}
        />
      )}

      {screen.name === 'create' && (
        <CreateGroup
          onCancel={() => setScreen({ name: 'list' })}
          onCreated={async (group) => {
            await loadGroups();
            setScreen({ name: 'group', id: group.id });
          }}
        />
      )}

      {screen.name === 'group' && (
        <GroupDetail
          groupId={screen.id}
          me={me}
          onBack={async () => {
            await loadGroups();
            setScreen({ name: 'list' });
          }}
        />
      )}

      {screen.name === 'profile' && (
        <Profile onBack={() => setScreen({ name: 'list' })} />
      )}
    </div>
  );
}

function Centered({ children }) {
  return <div className="centered">{children}</div>;
}

function GroupsList({ groups, onOpen, onCreate, onProfile }) {
  return (
    <div className="screen">
      <header className="header">
        <h1>Мои кассы</h1>
        <button className="iconBtn" onClick={onProfile} title="Мои реквизиты">⚙️</button>
      </header>

      {groups.length === 0 && (
        <p className="hint">
          Пока нет ни одной кассы. Создайте свою или попросите друга прислать вам ссылку-приглашение.
        </p>
      )}

      <div className="list">
        {groups.map((g) => (
          <button key={g.id} className="card" onClick={() => onOpen(g.id)}>
            <div className="cardTitle">{g.name}</div>
            <div className="cardSub">
              {g.type === 'rotation' ? 'Ротационная касса' : 'Накопительная касса'} · {money(g.amount)}
              {g.type === 'rotation' ? ' / цикл' : ''}
            </div>
          </button>
        ))}
      </div>

      <button className="primaryBtn fixedBottom" onClick={onCreate}>+ Новая касса</button>
    </div>
  );
}

function CreateGroup({ onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('rotation');
  const [amount, setAmount] = useState('5000');
  const [frequencyDays, setFrequencyDays] = useState('30');
  const [goalAmount, setGoalAmount] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    try {
      const res = await api.createGroup({
        name,
        type,
        amount: Number(amount),
        frequency_days: Number(frequencyDays),
        goal_amount: type === 'goal' && goalAmount ? Number(goalAmount) : null,
      });
      onCreated(res.group);
    } catch (e2) {
      setErr('Не получилось создать кассу. Проверьте поля и попробуйте снова.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="screen">
      <header className="header">
        <button className="iconBtn" onClick={onCancel}>←</button>
        <h1>Новая касса</h1>
      </header>

      <form className="form" onSubmit={submit}>
        <label>
          Название
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Касса подруг" required />
        </label>

        <label>Тип кассы</label>
        <div className="segment">
          <button type="button" className={type === 'rotation' ? 'segActive' : ''} onClick={() => setType('rotation')}>
            Ротационная
          </button>
          <button type="button" className={type === 'goal' ? 'segActive' : ''} onClick={() => setType('goal')}>
            Накопительная
          </button>
        </div>
        <p className="fieldHint">
          {type === 'rotation'
            ? 'Все платят одинаковую сумму каждый цикл, весь сбор целиком получает один участник по очереди.'
            : 'Все копят к общей цели, без ротации выплат — например, на подарок или общий праздник.'}
        </p>

        <label>
          {type === 'rotation' ? 'Взнос за цикл, ₽' : 'Рекомендуемый взнос, ₽'}
          <input type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>

        <label>
          Периодичность цикла, дней
          <input type="number" min="1" value={frequencyDays} onChange={(e) => setFrequencyDays(e.target.value)} required />
        </label>

        {type === 'goal' && (
          <label>
            Цель, ₽ (необязательно)
            <input type="number" min="1" value={goalAmount} onChange={(e) => setGoalAmount(e.target.value)} />
          </label>
        )}

        {err && <p className="error">{err}</p>}

        <button className="primaryBtn" type="submit" disabled={saving}>
          {saving ? 'Создаём…' : 'Создать кассу'}
        </button>
      </form>
    </div>
  );
}

function GroupDetail({ groupId, me, onBack }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState(null);

  const reload = useCallback(async () => {
    const res = await api.group(groupId);
    setData(res);
  }, [groupId]);

  useEffect(() => {
    reload().catch(() => setErr('Не удалось загрузить кассу'));
  }, [reload]);

  if (err) return <Centered>{err}</Centered>;
  if (!data) return <Centered>Загрузка…</Centered>;

  const { group, members, cycle, isCreator } = data;
  const isRecipient = cycle?.recipient?.telegram_id === me.telegram_id;
  const canManage = isCreator || isRecipient;

  const myContribution = cycle?.contributions.find((c) => c.telegram_id === me.telegram_id);
  const confirmedCount = cycle?.contributions.filter((c) => c.status === 'confirmed').length || 0;
  const allConfirmed = cycle && confirmedCount === members.filter((m) => m.active).length;

  // Целевая сумма: для ротационной кассы — взнос × число участников (задаётся сервером),
  // для накопительной — общая цель, если её указали при создании (необязательное поле).
  const targetAmount = group.type === 'rotation' ? cycle?.expectedTotal : group.goal_amount;
  const collectedAmount = cycle?.confirmedTotal ?? 0;
  const progressPercent = targetAmount ? Math.min(100, Math.round((collectedAmount / targetAmount) * 100)) : null;

  const doContribute = async () => {
    setBusy(true);
    try {
      hapticSelection();
      await api.contribute(groupId, cycle.id, group.amount);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const doConfirm = async (telegramId) => {
    setBusy(true);
    try {
      await api.confirm(groupId, cycle.id, telegramId);
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const doClose = async (force) => {
    setBusy(true);
    try {
      await api.closeCycle(groupId, cycle.id, force);
      await reload();
    } catch (e) {
      if (e.code === 'not_all_confirmed') {
        setErr(null);
        alert('Не все подтвердили взнос. Можно принудительно закрыть цикл кнопкой ниже, если это осознанное решение.');
      }
    } finally {
      setBusy(false);
    }
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink(groupId));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // буфер обмена может быть недоступен — молча игнорируем
    }
  };

  return (
    <div className="screen">
      <header className="header">
        <button className="iconBtn" onClick={onBack}>←</button>
        <h1>{group.name}</h1>
      </header>

      <section className="panel">
        <div className="row spread">
          <span className="muted">
            {group.type === 'rotation' ? 'Ротационная касса' : 'Накопительная касса'}
            {cycle && group.type === 'rotation' ? ` · цикл №${cycle.cycle_number}` : ''}
          </span>
          <button className="linkBtn" onClick={copyInvite}>{copied ? 'Скопировано ✓' : 'Пригласить'}</button>
        </div>

        {cycle && (
          <>
            <div className="summaryHeader">
              <div className="summaryCollected">{money(collectedAmount)}</div>
              <div className="summaryTarget muted">
                {targetAmount != null ? `из ${money(targetAmount)}` : 'цель не задана'}
                {progressPercent != null ? ` · ${progressPercent}%` : ''}
              </div>
            </div>

            {progressPercent != null && (
              <div className="progressTrack">
                <div className="progressFill" style={{ width: `${progressPercent}%` }} />
              </div>
            )}

            {group.type === 'rotation' && cycle.recipient && (
              <div className="nextRecipient">
                <span className="muted">Получит</span>
                <div className="recipientLine">
                  <span className="recipientName">{cycle.recipient.first_name}{isRecipient ? ' (вы)' : ''}</span>
                  <span className="recipientAmount">{targetAmount != null ? money(targetAmount) : '—'}</span>
                  <span className="recipientDate">{formatDate(cycle.period_end)}</span>
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {cycle && group.type === 'rotation' && !isRecipient && (
        <section className="panel">
          <h2>Ваш взнос — {money(group.amount)}</h2>
          {cycle.recipient?.payment_details ? (
            <p className="hint">Переведите через СБП по реквизитам получателя: <b>{cycle.recipient.payment_details}</b></p>
          ) : (
            <p className="hint">Получатель ещё не указал реквизиты для перевода — уточните у него в чате.</p>
          )}

          {!myContribution && (
            <button className="primaryBtn" disabled={busy} onClick={doContribute}>
              Я перевёл(а) — отметить
            </button>
          )}
          {myContribution?.status === 'pending' && (
            <p className="hint">Отмечено, ждём подтверждения от получателя.</p>
          )}
          {myContribution?.status === 'confirmed' && <p className="hint success">Взнос подтверждён ✓</p>}
        </section>
      )}

      {cycle && group.type === 'rotation' && (
        <section className="panel">
          <h2>Журнал взносов</h2>
          <div className="ledger">
            {members.filter((m) => m.active).map((m) => {
              const c = cycle.contributions.find((x) => x.telegram_id === m.telegram_id);
              return (
                <div className="ledgerRow" key={m.telegram_id}>
                  <span>{m.first_name}</span>
                  <span className={`status status-${c?.status || 'none'}`}>
                    {c?.status === 'confirmed' ? 'подтверждено' : c?.status === 'pending' ? 'ожидает подтверждения' : 'не отмечено'}
                  </span>
                  {canManage && c?.status === 'pending' && (
                    <button className="smallBtn" disabled={busy} onClick={() => doConfirm(m.telegram_id)}>
                      Подтвердить
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {canManage && (
            <div className="manageActions">
              <button className="primaryBtn" disabled={busy} onClick={() => doClose(false)}>
                Закрыть цикл и передать следующему
              </button>
              {!allConfirmed && isCreator && (
                <button className="dangerBtn" disabled={busy} onClick={() => doClose(true)}>
                  Закрыть принудительно (не все подтвердили)
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <section className="panel">
        <h2>Участники ({members.length})</h2>
        <div className="ledger">
          {members.map((m) => (
            <div className="ledgerRow" key={m.telegram_id}>
              <span>#{m.join_order} {m.first_name}{m.telegram_id === me.telegram_id ? ' (вы)' : ''}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Profile({ onBack }) {
  const [value, setValue] = useState('');
  const [saved, setSaved] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    await api.setPaymentDetails(value);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="screen">
      <header className="header">
        <button className="iconBtn" onClick={onBack}>←</button>
        <h1>Мои реквизиты</h1>
      </header>
      <form className="form" onSubmit={save}>
        <p className="hint">
          Это увидят участники ваших касс, когда придёт ваша очередь получать выплату —
          например: «СБП, Т-Банк, +7 900 000-00-00».
        </p>
        <label>
          Как вам перевести деньги
          <textarea value={value} onChange={(e) => setValue(e.target.value)} rows={3} />
        </label>
        <button className="primaryBtn" type="submit">Сохранить</button>
        {saved && <p className="hint success">Сохранено ✓</p>}
      </form>
    </div>
  );
}
