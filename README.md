# CLOUD — бэкенд

API для мобильного приложения CLOUD (цифровое благополучие): тихие часы, блокировка отвлекающих приложений, «обещание» со штрафом за досрочную разблокировку, прогресс и серии.

**Стек:** Node.js 22 · TypeScript · Fastify 5 · PostgreSQL 16 · Drizzle ORM · Zod · Stripe (Apple Pay / Google Pay) · Expo Push.

Документация OpenAPI (Swagger UI) доступна на `http://localhost:3000/docs` после запуска.

---

## Быстрый старт

### Через Docker

```bash
docker compose up --build
# API:  http://localhost:3000/api/v1
# Docs: http://localhost:3000/docs
```

Демо-пользователь с историей за ~6 недель (для всех экранов сразу есть данные):

```bash
docker compose exec api node dist/db/seed.js
# email: demo@cloud.app   пароль: cloud-demo-2026
```

### Локально

```bash
cp .env.example .env          # укажите DATABASE_URL и JWT_SECRET
npm install
npm run db:migrate
npm run db:seed               # необязательно: демо-данные
npm run dev                   # http://localhost:3000
```

### Тесты

Нужен PostgreSQL; тесты создают схему в базе `cloud_test` с нуля.

```bash
createdb cloud_test
npm test                      # 26 тестов: unit + интеграционные на настоящей БД
TEST_DATABASE_URL=postgres://… npm test   # другая база
```

---

## Как экраны дизайна ложатся на API

Все пути — с префиксом `/api/v1`, авторизация — `Authorization: Bearer <accessToken>`.

| Экран | Запросы |
|---|---|
| **Home** — «Good evening, Alisher», «Your night starts at 22:30», обратный отсчёт, Today / This week | `GET /home` — всё одним запросом: приветствие, инициалы, время, `secondsUntilStart`, активная сессия, минуты за сегодня и неделю с % к прошлой |
| Кнопка **Start focus mode** | `POST /sessions` → блокировка до конца сегодняшних тихих часов (или `{ "durationMinutes": 90 }` для разовой сессии) |
| **Schedule** — время, дни, приложения, сумма обещания, «Save my schedule» | `GET /apps`, `GET /schedule`, `PUT /schedule` |
| **Locked** — «The world can wait», живой отсчёт, «Protected until 07:00» | `GET /sessions/active` → `remainingSeconds`, `plannedEndAt` |
| **Penalty** — «$5», «Apple Pay •••• 2084», «Stay focused» / «Unlock and pay $5» | `GET /sessions/:id/unlock-quote`, затем `POST /sessions/:id/unlock` (заголовок `Idempotency-Key`, тело `{ "confirm": true }`) |
| **Progress** — 68.5h за месяц, ↑14%, кольцо 4/5, график недели, 18 ночей, $90, серия 7, достижения | `GET /stats/overview`, `GET /stats/week?date=YYYY-MM-DD`, `GET /achievements` |
| **Settings** — профиль, расписание, способ оплаты, уведомления, wind-down, доступность, экстренный доступ | `GET/PATCH /me`, `GET/PATCH /settings`, `GET /payment-methods`, `POST /payment-methods/setup-intent`, `POST /payment-methods`, `DELETE /me` |
| Push-уведомления | `POST /devices` (при каждом запуске), `DELETE /devices` (при выходе) |
| Аккаунт | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`, `POST /me/password` |

Ошибки всегда в одном формате:

```json
{ "error": { "code": "PAYMENT_METHOD_REQUIRED", "message": "…", "details": { } } }
```

Основные коды: `VALIDATION_ERROR` (400), `UNAUTHORIZED` / `INVALID_CREDENTIALS` (401), `PAYMENT_FAILED` (402), `NOT_FOUND` (404), `EMAIL_TAKEN`, `PAYMENT_METHOD_REQUIRED`, `SESSION_ALREADY_ACTIVE`, `SESSION_NOT_ACTIVE` (409), `RATE_LIMITED` (429).

---

## Ключевые решения

### Расписание и время
- Время хранится в минутах от локальной полуночи, дни — битовой маской (Пн = бит 0). Всё считается в часовом поясе пользователя (`timezone` при регистрации, меняется через `PATCH /me`).
- Окно 22:30 → 07:00 переходит через полночь; «понедельничная ночь» — это Пн 22:30 → Вт 07:00. Переходы на летнее время учтены (07:00 остаётся 07:00).
- Ночь «привязана к полудню»: сессия, начатая в 01:00, засчитывается предыдущей ночи.
- При регистрации создаётся расписание из дизайна (22:30–07:00, будни, $5, TikTok/Instagram/YouTube), но **выключенное**: обещание включается только по «Save my schedule».

### Сессии фокуса
- Одна активная сессия на пользователя (частичный уникальный индекс в БД).
- Воркер сам стартует сессию в начале тихих часов, завершает её утром, шлёт напоминание «wind-down» за N минут (по умолчанию 15) и пуши о достижениях. Каждое уведомление уходит ровно один раз (`notification_log`).
- Если расписание сохранили уже внутри окна (в 23:00 при старте 22:30), в эту ночь автоблокировки не будет — пользователь не окажется заблокирован внезапно.
- Эндпоинты чтения сами «дозавершают» истёкшие сессии, поэтому API корректен даже без воркера.

### Штраф за досрочную разблокировку
- Сумма и список приложений фиксируются в сессии на старте: изменение расписания посреди ночи не меняет данное обещание.
- Списание только после явного подтверждения (`confirm: true`) и с обязательным `Idempotency-Key`. Повтор с тем же ключом возвращает тот же результат и **никогда не списывает дважды**; провайдер получает ключ, производный от id платежа.
- Ответы: `200` — разблокировано; `202` — карта требует 3-D Secure (вернётся `clientSecret` для SDK, затем опрашивайте `GET /payments/:id`, окончательно платёж подтверждает вебхук); `402` — отказ, сессия остаётся активной.
- Нельзя включить расписание со штрафом > 0 без сохранённого способа оплаты. Обещание на $0 допустимо.

### Статистика
- «Screen-free» — фактическое время в сессиях (в том числе до досрочной разблокировки).
- Ночь «сдержана», если сессия завершилась по плану; досрочная разблокировка — «нарушена».
- Серия — подряд сдержанные ночи; дни вне расписания без сессий пропускаются, пропущенная запланированная ночь или разблокировка серию обнуляют. Сегодняшняя ночь, пока идёт, серию не рвёт.
- «Kept in your pocket» — сумма обещаний по сдержанным ночам. Сравнение с прошлой неделей/месяцем — за тот же отрезок (среда сравнивается с прошлыми Пн–Ср).

### Безопасность
- Пароли — scrypt (встроенный `node:crypto`), access-токен JWT на 15 минут, refresh-токен непрозрачный, в БД хранится только SHA-256. Ротация при каждом обновлении; повторное использование старого refresh-токена отзывает все сессии пользователя.
- Rate limit на вход/регистрацию/смену пароля, CORS по списку, заголовок `Authorization` вырезается из логов.
- `DELETE /me` удаляет аккаунт и все данные каскадом, отвязывая карты у провайдера.

---

## Оплата

`PAYMENT_PROVIDER=mock` (по умолчанию) — деньги не двигаются. Результат задаётся id способа оплаты, чтобы прогнать каждую ветку:

| `providerPaymentMethodId` | Поведение |
|---|---|
| `pm_mock_apple_2084` | Apple Pay •••• 2084, оплата проходит |
| `pm_mock_card_4242` | Visa •••• 4242, оплата проходит |
| `pm_mock_decline_0002` | отказ банка → 402 |
| `pm_mock_3ds_3155` | нужен 3-D Secure → 202; подтвердить: `POST /api/v1/webhooks/mock {"type":"payment.succeeded","providerPaymentId":"pi_mock_…"}` |

`PAYMENT_PROVIDER=stripe` — реальные списания:
1. Клиент вызывает `POST /payment-methods/setup-intent`, получает `clientSecret` и через Stripe SDK (Apple Pay / Google Pay / карта) сохраняет способ оплаты.
2. Передаёт полученный `pm_…` в `POST /payment-methods`.
3. При разблокировке сервер создаёт PaymentIntent `off_session` по сохранённому способу.
4. Вебхук: `https://<host>/api/v1/webhooks/stripe`, события `payment_intent.succeeded` и `payment_intent.payment_failed`, секрет в `STRIPE_WEBHOOK_SECRET`.

> Перед запуском реальных списаний проверьте у юриста условия: штраф за досрочную разблокировку — это платёж по добровольному обязательству пользователя, его нужно ясно описать в оферте и в правилах App Store / Google Play.

---

## Что должен делать мобильный клиент

Сервер не может сам заблокировать приложения на телефоне — это делает клиент, сервер хранит «истину» об обещании:

- **iOS:** Screen Time API (`FamilyControls` + `ManagedSettings` + `DeviceActivity`). Приложения выбираются через `FamilyActivityPicker` — Apple отдаёт непрозрачные токены, их храните на устройстве; на сервер отправляйте логические id из `GET /apps` (`tiktok`, `instagram`…). Расписание `DeviceActivitySchedule` строится из `GET /schedule`.
- **Android:** `UsageStatsManager` + Accessibility Service / оверлей; пакеты — поле `androidPackage` в `GET /apps`.
- Блокировка снимается, когда `GET /sessions/active` возвращает `null` или после ответа `200` на `/unlock`.
- Push-токен — `POST /devices` при каждом запуске (`PUSH_PROVIDER=expo` для Expo; для нативных APNs/FCM добавьте свою реализацию `PushSender` в `src/services/push.ts`).

---

## Структура

```
src/
  index.ts              запуск: миграции → каталог приложений → API + воркер
  app.ts                Fastify, Swagger, CORS, rate limit, обработчик ошибок
  config.ts             переменные окружения (проверяются Zod при старте)
  context.ts            db, платёжный провайдер, push, часы — передаются в сервисы
  db/                   схема Drizzle, клиент, миграции, сид демо-данных
  lib/                  расчёт времени расписания, пароли, форматирование, ошибки
  plugins/auth.ts       JWT-аутентификация
  routes/               HTTP-эндпоинты по экранам
  services/             бизнес-логика: расписание, сессии, оплата, статистика, достижения, уведомления
  worker/jobs.ts        автостарт/автозавершение сессий, wind-down напоминания
drizzle/                SQL-миграции
test/                   unit- и интеграционные тесты (vitest + PostgreSQL)
```

Изменили схему → `npm run db:generate` создаст новую миграцию в `drizzle/`.

## Масштабирование

Воркер — простой `setInterval` внутри процесса API. При нескольких репликах включайте его только на одной (`RUN_WORKER=true` на одной, `false` на остальных) или вынесите `runWorkerTick` в отдельный процесс/cron. Воркер проходит по всем включённым расписаниям за тик — этого хватит на десятки тысяч пользователей; дальше стоит хранить `next_start_at` с индексом и выбирать только ближайшие окна.
