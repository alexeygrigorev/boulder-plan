# Fixtures публичных страниц BETA7

Сняты 2026-09-04 с открытых страниц без авторизации:

- `beta7_route_wave.html` — карточка трассы (`/route/{id}`, пример Wave 6C/LILA)
- `berta_catalog.html` — каталог зала (`/location/bertablock/routes`)

Очищены от `<script>`/`<style>` для размера; семантическая разметка нетронута.

Обновить: скачать страницу curl'ом, вырезать script/style, заменить файл.
Парсер обязан проходить по этим fixtures (см. `../routes-parse.test.ts`).
