// Тонкая обёртка над Telegram.WebApp SDK.
// Если приложение открыто не внутри Telegram (например, при локальной разработке
// в обычном браузере), initData будет пустым — тогда используем dev-заглушку,
// которая работает вместе с DEV_ALLOW_INSECURE=1 на сервере.

const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;

export function initTelegram() {
  if (tg) {
    tg.ready();
    tg.expand();
  }
}

export function getInitData() {
  return tg?.initData || '';
}

export function getStartParam() {
  // start_param приходит либо из initDataUnsafe (запуск из бота), либо из ?startapp=
  // в query-строке, если открыли ссылку вида /?startapp=<id_кассы> напрямую.
  const fromTg = tg?.initDataUnsafe?.start_param;
  if (fromTg) return fromTg;
  const url = new URL(window.location.href);
  return url.searchParams.get('startapp') || url.searchParams.get('tgWebAppStartParam');
}

export function getDevUser() {
  // Только для локальной разработки вне Telegram.
  // Можно переключать тестового пользователя через ?dev_id=...&dev_name=... в URL.
  const url = new URL(window.location.href);
  const id = Number(url.searchParams.get('dev_id')) || 999001;
  const name = url.searchParams.get('dev_name') || 'Тест-Пользователь';
  return { id, first_name: name, username: `dev_user_${id}` };
}

export function isInsideTelegram() {
  return Boolean(tg && tg.initData);
}

export function hapticSelection() {
  tg?.HapticFeedback?.selectionChanged?.();
}

export function themeParams() {
  return tg?.themeParams || {};
}
