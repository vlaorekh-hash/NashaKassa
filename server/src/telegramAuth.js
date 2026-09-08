import crypto from 'node:crypto';

/**
 * Проверка подлинности Telegram.WebApp.initData по алгоритму из документации Telegram:
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 *
 * secret_key = HMAC_SHA256("WebAppData", BOT_TOKEN)
 * hash_check  = HEX(HMAC_SHA256(secret_key, data_check_string))
 * data_check_string — все поля кроме hash, отсортированные по ключу, "key=value" через \n
 *
 * initData считается свежим, если auth_date не старше maxAgeSeconds (защита от replay-атак).
 */
export function verifyInitData(initData, botToken, { maxAgeSeconds = 86400 } = {}) {
  if (!initData || typeof initData !== 'string') {
    return { ok: false, reason: 'empty_init_data' };
  }

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'no_hash' };
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const validSignature =
    computedHash.length === hash.length &&
    crypto.timingSafeEqual(Buffer.from(computedHash, 'hex'), Buffer.from(hash, 'hex'));

  if (!validSignature) return { ok: false, reason: 'bad_signature' };

  const authDate = Number(params.get('auth_date') || 0);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (!authDate || ageSeconds > maxAgeSeconds) {
    return { ok: false, reason: 'stale_init_data' };
  }

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch {
    return { ok: false, reason: 'bad_user_json' };
  }
  if (!user || !user.id) return { ok: false, reason: 'no_user' };

  return { ok: true, user, startParam: params.get('start_param') || null };
}

/**
 * Express-мидлварь: ждёт заголовок X-Telegram-Init-Data, кладёт req.tgUser при успехе.
 * В DEV_ALLOW_INSECURE=1 (только для локальной отладки без реального Telegram) пропускает
 * запросы с заголовком X-Debug-User (JSON) без проверки подписи.
 */
export function telegramAuthMiddleware(botToken) {
  return (req, res, next) => {
    if (process.env.DEV_ALLOW_INSECURE === '1' && req.header('X-Debug-User')) {
      // HTTP-заголовки трактуются как latin1, поэтому не-ASCII (кириллица) шлём percent-encoded.
      try {
        req.tgUser = JSON.parse(decodeURIComponent(req.header('X-Debug-User')));
        return next();
      } catch {
        return res.status(400).json({ error: 'bad_debug_user' });
      }
    }

    const initData = req.header('X-Telegram-Init-Data');
    const result = verifyInitData(initData, botToken);
    if (!result.ok) {
      return res.status(401).json({ error: 'unauthorized', reason: result.reason });
    }
    req.tgUser = result.user;
    req.startParam = result.startParam;
    next();
  };
}
