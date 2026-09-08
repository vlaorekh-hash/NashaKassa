import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { router } from './routes.js';
import { telegramAuthMiddleware } from './telegramAuth.js';
import { createBot, startReminderSweep } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || '';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

if (!BOT_TOKEN) {
  console.warn('[warn] BOT_TOKEN не задан — /api будет недоступен без валидной подписи Telegram, ' +
    'но сервер всё равно запустится (можно тестировать через DEV_ALLOW_INSECURE=1).');
}

app.use('/api', telegramAuthMiddleware(BOT_TOKEN || 'dev-mode-no-token'), router);

// Если рядом лежит собранный фронтенд (webapp/dist) — отдаём его как статику.
const webappDist = path.join(__dirname, '..', '..', 'webapp', 'dist');
if (fs.existsSync(webappDist)) {
  app.use(express.static(webappDist));
  app.get('*', (req, res) => res.sendFile(path.join(webappDist, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`[server] слушает на порту ${PORT}`);
});

// Telegram разрешает только одно активное long-polling соединение на токен бота.
// При редеплое старый процесс может ещё секунду-другую доживать, пока стартует новый —
// getUpdates в этот момент вернёт 409 Conflict. Раньше это роняло весь сервер
// (необработанный reject из bot.launch() в Node 24 завершает процесс) — теперь просто
// подождём и попробуем снова, вместо того чтобы валить деплой.
async function startBotWithRetry(bot, { retries = 5, baseDelayMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await bot.launch();
      console.log('[bot] запущен (long polling)');
      return;
    } catch (err) {
      const isConflict = err?.response?.error_code === 409;
      console.error(
        `[bot] не удалось запустить (попытка ${attempt}/${retries})${isConflict ? ' — конфликт с другим экземпляром' : ''}:`,
        err?.message || err
      );
      if (attempt === retries) {
        console.error(
          '[bot] бот не поднялся после нескольких попыток — сервер и API продолжают работать, ' +
          'но бот не отвечает. Проверьте, не запущен ли где-то ещё процесс с этим же BOT_TOKEN.'
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * attempt));
    }
  }
}

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

if (BOT_TOKEN) {
  const bot = createBot(BOT_TOKEN, WEBAPP_URL);
  startBotWithRetry(bot);
  startReminderSweep(bot, WEBAPP_URL);

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
} else {
  console.log('[bot] пропущен запуск — нет BOT_TOKEN');
}
