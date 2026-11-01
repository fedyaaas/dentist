# Контракт проекта «Сайт стоматологии Юлии и Тихона» (MVP)

Ведущий: lead. Исполнители: frontend, booking, backend-admin.
Каждый пишет ТОЛЬКО свои файлы. Общие файлы `js/config.js` и `js/api.js` уже написаны ведущим — не менять, только использовать.

## Стек
- Чистый HTML5 + CSS + ванильный JavaScript (ES2017+, без сборщиков, без фреймворков, без npm).
- Хостинг: GitHub Pages (статичные файлы). Пути только относительные (`css/style.css`, а в admin/ — `../css/style.css`).
- Бэкенд: Google Apps Script, привязанный к Google Таблице «Учет», опубликован как Web App.
- Шрифт: Manrope (Google Fonts). Язык страниц: `lang="ru"`.
- Код должен быть понятен новичку: комментарии на русском у каждого блока и функции.

## Дизайн (вариант A «Светлая клиника»)
CSS-переменные (объявляет frontend в css/style.css, остальные используют):
```
--ink: #0E1B2B;      /* основной текст */
--muted: #4A5B6E;    /* второстепенный текст */
--accent: #1663C7;   /* синий акцент, кнопки */
--accent-dark: #0F4A96;
--accent-soft: #E6F0FC;
--surface: #F1F5FA;  /* серые подложки секций */
--line: #DCE4EE;     /* границы */
--white: #FFFFFF;
--radius: 16px; --radius-lg: 24px;
```
Общие классы из css/style.css (frontend обязан их определить, booking и admin могут использовать):
`.container` (max-width 1200px, padding 0 24px, margin auto), `.btn` (основная синяя кнопка), `.btn--ghost` (обводка), `.section`, `.section-title`, `.eyebrow` (маленькая подпись над заголовком), `.chip` (пилюля), `.card`, `.site-header` и `.site-footer` (шапка и подвал, разметку frontend копирует во все публичные страницы как есть).
Адаптив: всё работает на ширине 360px. Кнопки и поля не ниже 44px. Контраст текста ≥ 4.5:1. Никаких эмодзи — только inline SVG.

## Контент
- Врачи (MVP — в js/config.js, массив DOCTORS): Юлия (ключ `Юля`), Тихон Федоровский (ключ `Тиша`). Ключ совпадает со значениями колонки «Врач» в таблице.
- Фото: `img/yulia.jpg`, `img/tikhon.jpg` — файлов пока нет; показывать серую заглушку с подписью, если картинка не загрузилась (onerror → класс .photo--empty).
- Адрес: приём в клинике «Баланс Дент», Москва, ул. Сивашская, 7, корп. 1, 5 минут от м. Нахимовский проспект.
- Контакты: Telegram Юлия https://t.me/julia10mdl, Тихон https://t.me/tikhonfedorovsky, WhatsApp Юлия https://wa.me/79621217272, Тихон https://wa.me/79819425007.
- Акция: первая профессиональная гигиена со скидкой 15%.
- Прайс: грузится через `api.getServices()`; при ошибке — из `FALLBACK_SERVICES` в config.js.

## Страницы и владельцы файлов
| Владелец | Файлы |
|---|---|
| frontend | `index.html`, `css/style.css`, `js/main.js` |
| booking | `booking.html`, `css/booking.css`, `js/booking.js` |
| backend-admin | `apps-script/Code.gs`, `apps-script/README.md`, `admin/index.html`, `css/admin.css`, `js/admin.js` |
| lead | `js/config.js`, `js/api.js`, `README.md`, `CONTRACT.md` |

Ссылки между страницами: главная → `booking.html` (с параметром `?doctor=Юля` или `?doctor=Тиша` из карточки врача), подвал → `admin/` («Вход для персонала»).

## API (Apps Script Web App)
Базовый URL — `CONFIG.API_URL` в config.js. Если пусто — `api.js` работает в ДЕМО-режиме на выдуманных данных (сайт работает сразу после публикации).

Все ответы — JSON `{ "ok": true, "data": ... }` или `{ "ok": false, "error": "код", "message": "текст для человека" }`.

GET-запросы (параметры в query string):
- `action=services` → `data: [{ group, name, minutes, price }]` — из листа «Прайс» (group протягивается вниз, т.к. в листе он указан только у первой строки направления; строки без цены пропускаются; price — число в рублях).
- `action=slots&doctor=Юля&from=2026-11-02&days=14` → `data: [{ date: "2026-11-02", time: "15:00", doctor: "Юля" }]` — только СВОБОДНЫЕ слоты. Никаких имён пациентов.

POST-запросы: тело — JSON-строка, заголовок `Content-Type: text/plain;charset=utf-8` (чтобы не было CORS preflight):
- `{ action:"book", doctor, date, time, service, name, phone, telegram, comment, website }` → `data: { date, time, doctor }`. `website` — скрытое поле-ловушка для ботов: если не пустое — вернуть ok:true, ничего не записывать. Ошибки: `slot_taken`, `bad_input`.
- `{ action:"login", password }` → `data: { token, name }`. Пароль хранится в Script Properties (`STAFF_PASSWORD`), НЕ в коде. Токен живёт 12 часов (Script Properties; счётчик неудачных входов — CacheService).
- `{ action:"admin_list", token, sheet, limit }` → `data: { headers:[...], rows:[[...]] }`. sheet ∈ `appointments`, `visits`, `expenses`, `patients`. Последние `limit` строк (по умолчанию 50), новые сверху.
- `{ action:"admin_add", token, sheet, row }` → `data: { added: true }`. sheet ∈ `visits`, `expenses`, `patients`, `slots`. row — объект с ключами из раздела «Листы».
- `{ action:"admin_update_status", token, rowId, status }` → смена статуса записи в листе «Онлайн-запись».
- Ошибка авторизации: `error: "auth"`.

## Листы Google Таблицы
Существующие листы НЕ ломаем. Скрипт создаёт два новых, если их нет (функция `setup()`):

**«Окна»** — сюда персонал вписывает, когда врач готов принимать:
`Дата | Время | Врач | Длительность (мин) | Комментарий`
Дата — настоящая дата Google Sheets (или строка дд.мм.гггг), Время — `15:00`, Врач — `Юля`/`Тиша`. Одна строка = один слот.

**«Онлайн-запись»** — сюда пишут сайт и Telegram-бот:
`ID | Создано | Дата | Время | Врач | Пациент | Телефон | Telegram | Услуга | Комментарий | Статус | chat_id`
(`chat_id` — Telegram пациента, только для записей через бота; с сайта пусто. Без выбора врача в «Врач» пишется `Юля и Тиша`.)
Статус: `новая` → `подтверждена` / `отменена` / `пришёл`. Слот занят, если есть строка с теми же Дата+Время+Врач и статусом не `отменена`.

Существующие листы, куда пишет админка (добавление строки в конец, колонки как сейчас):
- «Визиты»: `(Пациент) | Дата визита | Тип работы | Диагноз/ состояние | Врач | Цена | Зуб` (первая колонка без заголовка — пациент; заголовки во 2-й строке листа, в 1-й — итог выручки).
- «Расходы»: `Дата | Категория | Статья | Сумма | Комментарий` (заголовки во 2-й строке, в 1-й — итоги). Категория: `расход` или `доход`.
- «Пациенты»: `ID | ФИО | TG | Дата рождения | Телефон | Последний визит | Плановая дата сл. визита | Статус напоминания | Врач | Фото` (ID — следующий номер; в листе есть пустые строки с одними номерами — новая запись заполняет первую строку, где есть ID, но пустое ФИО).

Ключи row для admin_add:
- visits: `{ patient, date, type, note, doctor, price, tooth }`
- expenses: `{ date, category, item, amount, comment }`
- patients: `{ name, telegram, birthday, phone, doctor }`
- slots: `{ date, time, doctor, minutes, comment }`

## Telegram-бот (apps-script/Bot.gs, владелец backend-admin)
- Второй файл того же проекта Apps Script. Вебхук — тот же `/exec` с параметром `?tg=<TG_WEBHOOK_SECRET>`; `doPost` узнаёт обновление Telegram по полю `update_id` и отвечает `ok`. API сайта не меняется.
- Запись из бота и с сайта идёт через одну функцию `createBooking_` (Code.gs) — одна проверка занятости и блокировка. Уведомление о каждой новой записи получают все чаты из `STAFF_CHAT_IDS` (врачи входят командой `/login <пароль>`).
- Свойства скрипта: `TELEGRAM_BOT_TOKEN`, `SITE_URL`, `STAFF_PASSWORD`; сами создаются `TG_WEBHOOK_SECRET`, `STAFF_CHAT_IDS`, `BOT_USERNAME`; по желанию `WEBAPP_URL`, `TELEGRAM_CHAT_ID` (запасной чат).
- Ссылки, которые бот даёт пациенту: `https://t.me/<bot>?start=plan_<Код>` и `<SITE_URL>/booking.html?service=<услуга, urlencoded>&plan=<Код>` — booking.html может подставить услугу из `service` и передать `plan` в комментарий (необязательно).

**«Планы»** (создаёт `setup()`, пишет бот):
`ID | Создано | Пациент | Телефон | Услуга | Комментарий врача | Желательно до | Код | chat_id пациента | Статус | Напомнено`
Статус: `активен` → `записан` → `выполнен`.

## Безопасность
Репозиторий публичный: никаких паролей, личных данных, реальных пациентов в коде и демо-данных. Демо-имена вида «Пример: Анна К.». Всё, что приходит от пользователя, вставлять в DOM через textContent, не innerHTML.
