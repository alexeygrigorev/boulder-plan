# Boulder Plan — serverless трекер тренировок

Мобильное serverless-приложение для болдеринг-плана на 26 недель (03.09.2026 → 07.03.2027).

- **Фронтенд:** TypeScript + Vite, mobile-first, работает с телефона.
- **Бэкенд:** TypeScript, AWS Lambda (API Gateway HTTP API). Локально — тот же код через `node --strip-types` без AWS.
- **Хранение:** локально — JSON-файл; в AWS — DynamoDB (через `infra/template.yaml`).
- **Контент:** весь план из ZIP распарсен в `content/plan.json` (185+ дней, тайм-блоки, техника, стоп-правила).

## Структура

```
content/        # plan.json + tools/ingest.ts (парсер исходных .md)
backend/        # Lambda handlers + local.ts (локальный сервер) + storage adapter
frontend/       # Vite + TS, экраны: Сегодня / Неделя / Библиотека / Прогресс
infra/          # SAM template: Lambda + HttpApi + DynamoDB (деплой позже)
```

## Локальный запуск (без AWS)

```bash
npm install
npm run ingest   # один раз: ZIP -> content/plan.json (или уже закоммичен)
npm run dev      # backend :3000 + раздача frontend
# открыть http://localhost:3000 с телефона в той же сети
```

Прогресс чек-листов хранится в браузере (localStorage) + на диске `backend/data/progress.json`
через API — так же будет работать DynamoDB в облаке.

## API (и локально, и в Lambda)

- `GET /api/health`
- `GET /api/days` — индекс дат
- `GET /api/plan?date=YYYY-MM-DD` — план дня
- `GET /api/progress?date=YYYY-MM-DD` — прогресс дня
- `PUT /api/progress` `{ date, checks, note }` — сохранить
- `GET /api/library` — библиотека упражнений T01–T26, H1–H3
- `GET /api/gyms` — залы (Berta Block scan-only + ручной)
- `GET /api/gym/routes?gymId=` — трассы зала с личными статусами
- `POST /api/qr/resolve` `{ payload, selectedGymId }` — распознать QR: кэш → открытая страница трассы (кеш 7 дней), без сети работает с сохранённым
- `POST /api/gym/sync` `{ gymId }` — обновить каталог с открытой страницы зала (частичный: SSR отдаёт только свежие карточки, лимит 15 мин)
- `POST /api/gym/routes` / `PUT /api/gym/route` — ручное добавление/дополнение трассы
- `GET /api/route?id=` — карточка: трасса + статус + попытки + таймеры
- `PUT /api/route/state` — статус (хочу/проект/сделал/флеш/пропуск)
- `POST /api/route/attempts` — попытка (идемпотентно по `clientAttemptId`)
- `POST /api/route/timer/start|stop` — время работы над трассой
- `POST /api/recommendations` — подбор трасс под упражнения (`rules_v1`, с причинами)

Фронтенд: вкладка «Трассы» — выбор зала, QR (вставка ссылки или скан
камерой, декодирование локально), карточка, попытки в один тап, подбор.
PostgreSQL из пакета адаптирован: один JSON-документ (`routes.json`
локально, `pk=routes#v1` в той же DynamoDB-таблице, без смены infra).

## BETA7: только открытые страницы, без API

Официальный API — out of scope (любительский проект для себя,
договариваться о доступе не идём, обходных путей не ищем — их нет и не надо).
Используем только то, что сайт отдаёт без авторизации:

- страница трассы (`/route/{id}`): название, грейд, сектор, стили, постановщик;
- страница зала (`/location/{gym}/routes`): свежие карточки каталога;
- beta-видео, комментарии и чужие профили не трогаем вообще.

Парсер (`backend/src/beta7parse.ts`) покрыт fixtures реальных страниц
(`backend/test/fixtures/`), загрузка — через SSRF-защищённый fetch
(allowlist `beta7.app`, только HTTPS, timeout, лимит 1.5MB).
Каталог всегда PARTIAL и никогда не архивирует трассы: дальше растёт от сканов.
Отключить сеть: `BETA7_OFF=1`.

В AWS те же маршруты идут через API Gateway → одна Lambda.

## Деплой (позже)

Куда деплоить — покажешь отдельно. Готов `infra/template.yaml` (SAM):
Lambda (nodejs20.x) + HttpApi + DynamoDB. Фронтенд — статика на S3/CloudFront.
