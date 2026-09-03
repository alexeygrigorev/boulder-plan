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

В AWS те же маршруты идут через API Gateway → одна Lambda.

## Деплой (позже)

Куда деплоить — покажешь отдельно. Готов `infra/template.yaml` (SAM):
Lambda (nodejs20.x) + HttpApi + DynamoDB. Фронтенд — статика на S3/CloudFront.
