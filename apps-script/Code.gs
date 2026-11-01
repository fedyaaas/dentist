/**
 * ============================================================
 * Бэкенд сайта стоматологии на Google Apps Script.
 * Скрипт привязан к Google Таблице «Учет» и опубликован как
 * веб-приложение. Сайт (GitHub Pages) общается с ним через
 * js/api.js по контракту из CONTRACT.md.
 *
 * Ответ ВСЕГДА — JSON:
 *   { ok: true,  data: ... }
 *   { ok: false, error: "код", message: "текст для человека" }
 *
 * Секреты (пароль персонала, токен Telegram-бота) хранятся
 * в «Свойствах скрипта», а НЕ в этом файле. Этот файл можно
 * спокойно класть в публичный репозиторий.
 * ============================================================
 */

// ------------------------------------------------------------
// Настройки
// ------------------------------------------------------------

/** Часовой пояс клиники: все даты и время считаем по Москве. */
var TZ = 'Europe/Moscow';

/** Врачи: ровно так, как они записаны в колонке «Врач». */
var DOCTORS = ['Юля', 'Тиша'];

/** Что пишем в колонку «Врач» листа «Онлайн-запись», когда врачи принимают вместе. */
var TEAM_DOCTOR = 'Юля и Тиша';

/** Допустимые статусы онлайн-записи. */
var STATUSES = ['новая', 'подтверждена', 'отменена', 'пришёл'];

/** Названия листов таблицы. */
var SHEETS = {
  slots: 'Окна',
  appointments: 'Онлайн-запись',
  visits: 'Визиты',
  expenses: 'Расходы',
  patients: 'Пациенты',
  price: 'Прайс',
};

/** Заголовки новых листов (создаются функцией setup). */
var SLOTS_HEADERS = ['Дата', 'Время', 'Врач', 'Длительность (мин)', 'Комментарий'];
// 12-я колонка chat_id — Telegram-чат пациента, если он записался через бота
// (с сайта остаётся пустой). Нужна, чтобы бот мог написать пациенту.
var APPT_HEADERS = ['ID', 'Создано', 'Дата', 'Время', 'Врач', 'Пациент', 'Телефон', 'Telegram', 'Услуга', 'Комментарий', 'Статус', 'chat_id'];

/**
 * Как устроены листы, которые читает админка:
 *   headerRow — в какой строке заголовки (у «Визиты» и «Расходы» — во 2-й,
 *               потому что в 1-й строке посчитаны итоги);
 *   width     — сколько колонок слева берём (правее могут быть заметки/итоги).
 */
var LIST_LAYOUT = {
  appointments: { sheet: SHEETS.appointments, headerRow: 1, width: 11 },
  visits: { sheet: SHEETS.visits, headerRow: 2, width: 7 },
  expenses: { sheet: SHEETS.expenses, headerRow: 2, width: 5 },
  patients: { sheet: SHEETS.patients, headerRow: 1, width: 10 },
};

/** Время жизни токена входа — 12 часов (в миллисекундах). */
var TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** Защита от перебора пароля: не больше 5 ошибок за 10 минут. */
var LOGIN_MAX_FAILS = 5;
var LOGIN_WINDOW_SEC = 10 * 60;

// ------------------------------------------------------------
// Точки входа веб-приложения
// ------------------------------------------------------------

/**
 * GET-запросы: публичные данные для сайта.
 *   ?action=services                          — прайс
 *   ?action=slots&from=2026-11-02&days=14     — свободные окна (общие для команды)
 *   ?action=slots&doctor=Юля&from=...&days=... — старый вариант: окна одного врача
 * Любая ошибка превращается в JSON { ok:false, ... }.
 */
function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    switch (p.action) {
      case 'services':
        return jsonOk(getServices_());
      case 'slots':
        return jsonOk(getFreeSlots_(p.doctor, p.from, p.days));
      default:
        // Без action просто сообщаем, что сервер жив (удобно для проверки URL).
        return jsonOk({ alive: true });
    }
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * POST-запросы: тело — JSON-строка (Content-Type: text/plain,
 * чтобы браузер не делал предварительный CORS-запрос).
 * Действия: book, login, admin_list, admin_add, admin_update_status.
 */
function doPost(e) {
  try {
    var body = {};
    try {
      body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (parseErr) {
      throw apiError_('bad_input', 'Не удалось прочитать запрос.');
    }

    // Обновление от Telegram (вебхук бота, см. Bot.gs). Узнаём его по полю
    // update_id. Telegram стучится на <exec>?tg=<секрет>; заголовки запроса
    // Apps Script не видит, поэтому секрет передаётся в адресе. Без верного
    // секрета запрос молча игнорируется. Отвечаем всегда коротким «ok».
    if (body && typeof body.update_id === 'number') {
      var tgSecret = PropertiesService.getScriptProperties().getProperty('TG_WEBHOOK_SECRET');
      var tgGiven = (e && e.parameter && e.parameter.tg) || '';
      if (tgSecret && tgGiven === tgSecret) {
        try {
          handleTelegramUpdate_(body);
        } catch (tgErr) {
          Logger.log('Бот: ' + (tgErr && tgErr.stack ? tgErr.stack : tgErr));
        }
      }
      return ContentService.createTextOutput('ok');
    }

    switch (body.action) {
      case 'book':
        return jsonOk(book_(body));
      case 'login':
        return jsonOk(login_(body.password));
      case 'admin_list':
        requireAuth_(body.token);
        return jsonOk(adminList_(body.sheet, body.limit));
      case 'admin_add':
        requireAuth_(body.token);
        return jsonOk(adminAdd_(body.sheet, body.row || {}));
      case 'admin_update_status':
        requireAuth_(body.token);
        return jsonOk(adminUpdateStatus_(body.rowId, body.status));
      default:
        throw apiError_('bad_action', 'Неизвестное действие.');
    }
  } catch (err) {
    return jsonError(err);
  }
}

// ------------------------------------------------------------
// Первичная настройка (запустить вручную один раз)
// ------------------------------------------------------------

/**
 * Создаёт листы «Окна» и «Онлайн-запись», если их ещё нет:
 * жирные заголовки, закреплённая первая строка, текстовый формат
 * у колонок времени (чтобы «15:00» не превращалось в дробное число).
 * Существующие листы НЕ трогает. Запускать из редактора: выбрать
 * функцию setup и нажать «Выполнить».
 */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var slots = ensureSheet_(ss, SHEETS.slots, SLOTS_HEADERS);
  slots.getRange('A:A').setNumberFormat('dd.MM.yyyy'); // дата
  slots.getRange('B:B').setNumberFormat('@');          // время как текст
  slots.setColumnWidth(5, 240);

  var appt = ensureSheet_(ss, SHEETS.appointments, APPT_HEADERS);
  appt.getRange('B:D').setNumberFormat('@');           // создано, дата, время — текст
  appt.getRange('G:G').setNumberFormat('@');           // телефон — текст
  appt.setColumnWidth(10, 240);
  // Колонка chat_id появилась позже — добавляем заголовок в уже существующий лист
  var chatHead = appt.getRange(1, APPT_HEADERS.length);
  if (String(chatHead.getValue()).trim() === '') {
    chatHead.setValue('chat_id').setFontWeight('bold');
  }
  appt.getRange(1, APPT_HEADERS.length, appt.getMaxRows(), 1).setNumberFormat('@');

  // Лист «Планы» для Telegram-бота (константы — в Bot.gs)
  var plans = ensureSheet_(ss, PLAN_SHEET, PLAN_HEADERS);
  plans.getRange('B:B').setNumberFormat('@');           // создано
  plans.getRange('D:D').setNumberFormat('@');           // телефон
  plans.getRange('G:G').setNumberFormat('dd.MM.yyyy');  // желательно до
  plans.getRange('H:K').setNumberFormat('@');           // код, chat_id, статус, напомнено
  plans.setColumnWidth(6, 260);

  // Подсказка в журнале выполнения
  Logger.log('Готово. Листы «%s», «%s» и «%s» на месте.', SHEETS.slots, SHEETS.appointments, PLAN_SHEET);
}

/**
 * Возвращает лист с именем name; если его нет — создаёт
 * и пишет в первую строку заголовки headers (жирным, с закреплением).
 */
function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

// ------------------------------------------------------------
// Прайс
// ------------------------------------------------------------

/**
 * Читает лист «Прайс» и возвращает [{ group, name, minutes, price }].
 * - Направление (group) указано только у первой строки блока —
 *   «протягиваем» его вниз на следующие строки.
 * - Цена бывает числом или строкой вида «р. 4 500,00» — разбираем.
 * - Строки без цены (или с «р. -») пропускаем.
 */
function getServices_() {
  var sh = getSheet_(SHEETS.price);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, 4).getValues();

  var out = [];
  var group = '';
  values.forEach(function (r) {
    var g = cleanText_(r[0]);
    if (g) group = g; // новое направление
    var name = cleanText_(r[1]);
    var price = parseMoney_(r[3]);
    if (!name || price === null || price <= 0) return;
    var minutes = parseMoney_(r[2]);
    out.push({
      group: group,
      name: name,
      minutes: minutes && minutes > 0 ? Math.round(minutes) : null,
      price: price,
    });
  });
  return out;
}

// ------------------------------------------------------------
// Свободные окна
// ------------------------------------------------------------

/**
 * Свободные слоты в диапазоне дат [from, from + days).
 *
 * Два режима:
 *  - doctor ПУСТОЙ (основной: Юлия и Тихон принимают вместе) — берём все
 *    строки «Окна», колонку «Врач» не смотрим, дубли по дата+время убираем;
 *    время занято, если на эту дату+время есть любая активная запись.
 *    В ответе doctor = ''.
 *  - doctor передан (старый вариант, для совместимости) — только окна
 *    этого врача; занято, если есть запись этого врача ИЛИ общая запись
 *    команды на то же время.
 * В обоих режимах убираем прошедшие и слишком близкие окна
 * (раньше, чем «сейчас + 1 час»).
 * Возвращает отсортированный массив [{ date, time, doctor }] — без имён пациентов.
 */
function getFreeSlots_(doctor, fromISO, days) {
  doctor = String(doctor || '').trim();
  var team = doctor === '';
  if (!team && DOCTORS.indexOf(doctor) === -1) throw apiError_('bad_input', 'Неизвестный врач.');

  var from = parseDateISO(fromISO) || todayISO_();
  var n = parseInt(days, 10);
  if (!(n > 0)) n = 14;
  if (n > 90) n = 90;
  var to = addDaysISO_(from, n); // не включительно

  var busy = getBusyKeys_();
  var minKey = nowPlusHourKey_();
  var seen = {};
  var out = [];

  readSlotRows_().forEach(function (s) {
    if (!team && s.doctor !== doctor) return;
    if (s.date < from || s.date >= to) return;
    if (isSlotBusy_(busy, s.date, s.time, doctor)) return;
    var key = slotKey_(s.date, s.time, doctor);
    if (seen[key]) return; // дубль (одно и то же время вписано дважды)
    if (s.date + ' ' + s.time < minKey) return; // прошло или скоро начнётся
    seen[key] = true;
    out.push({ date: s.date, time: s.time, doctor: doctor });
  });

  out.sort(function (a, b) {
    var x = a.date + a.time, y = b.date + b.time;
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return out;
}

/**
 * Читает лист «Окна» и возвращает все корректные строки
 * в виде [{ date:'yyyy-MM-dd', time:'HH:mm', doctor }].
 * doctor может быть пустой строкой — это общее окно команды.
 * Строки с непонятной датой или временем молча пропускаются.
 */
function readSlotRows_() {
  var sh = getSheet_(SHEETS.slots);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var range = sh.getRange(2, 1, last - 1, 3);
  var values = range.getValues();
  var display = range.getDisplayValues(); // время надёжнее брать как видимый текст

  var out = [];
  for (var i = 0; i < values.length; i++) {
    var date = parseDateISO(values[i][0]);
    var time = parseTime(values[i][1], display[i][1]);
    var doctor = cleanText_(values[i][2]);
    if (date && time) out.push({ date: date, time: time, doctor: doctor });
  }
  return out;
}

/**
 * Собирает занятые слоты из «Онлайн-запись» для всех записей со статусом
 * не «отменена». Возвращает объект-множество с двумя видами ключей:
 *   «дата|время|врач» — как записано в колонке «Врач»;
 *   «дата|время»      — без врача (для общего режима команды).
 */
function getBusyKeys_() {
  var sh = getSheet_(SHEETS.appointments);
  var busy = {};
  var last = sh.getLastRow();
  if (last < 2) return busy;
  var range = sh.getRange(2, 1, last - 1, APPT_HEADERS.length);
  var values = range.getValues();
  var display = range.getDisplayValues();
  for (var i = 0; i < values.length; i++) {
    var status = cleanText_(values[i][10]).toLowerCase();
    if (status === 'отменена') continue;
    var date = parseDateISO(values[i][2]);
    var time = parseTime(values[i][3], display[i][3]);
    var doctor = cleanText_(values[i][4]);
    if (!date || !time) continue;
    busy[date + '|' + time] = true;
    busy[slotKey_(date, time, doctor)] = true;
  }
  return busy;
}

/**
 * Занято ли время.
 * doctor пустой → занято, если есть любая активная запись на дата+время.
 * doctor указан → занято, если есть запись этого врача или общая запись команды.
 */
function isSlotBusy_(busy, date, time, doctor) {
  if (!doctor) return !!busy[date + '|' + time];
  return !!(busy[slotKey_(date, time, doctor)] || busy[slotKey_(date, time, TEAM_DOCTOR)]);
}

/** Ключ слота для сравнения: «2026-11-02|15:00|Юля». */
function slotKey_(date, time, doctor) {
  return date + '|' + time + '|' + doctor;
}

// ------------------------------------------------------------
// Онлайн-запись пациента
// ------------------------------------------------------------

/**
 * Запись с сайта (action=book).
 * 1) Ловушка для ботов: если заполнено скрытое поле website —
 *    отвечаем «успех», но ничего не пишем.
 * 2) Всё остальное делает общая функция createBooking_ (её же
 *    использует Telegram-бот).
 */
function book_(b) {
  if (String(b.website || '').trim() !== '') {
    return {
      date: parseDateISO(b.date) || String(b.date || ''),
      time: parseTime(b.time) || String(b.time || ''),
      doctor: String(b.doctor || '').trim(),
    };
  }
  var rec = createBooking_({
    doctor: b.doctor, date: b.date, time: b.time, service: b.service,
    name: b.name, phone: b.phone, telegram: b.telegram, comment: b.comment,
    chatId: '', // с сайта chat_id не знаем
  });
  return { date: rec.date, time: rec.time, doctor: rec.doctor };
}

/**
 * Общая функция бронирования — для сайта и для Telegram-бота.
 * b = { doctor, date, time, service, name, phone, telegram, comment, chatId }
 *
 * 1) Проверяем данные (дата, время, имя ≤ 80, телефон 10–11 цифр).
 *    Врач необязателен: по умолчанию Юлия и Тихон принимают вместе, и в
 *    колонку «Врач» пишется «Юля и Тиша». Если врач передан — он должен
 *    быть из списка, и слот проверяется по старым правилам.
 * 2) Под блокировкой (LockService) проверяем, что слот есть в «Окна»
 *    и ещё свободен, и сразу добавляем строку — так два человека
 *    не смогут занять одно и то же время.
 * 3) Рассылаем уведомление персоналу (Bot.gs → notifyStaffNewBooking_).
 * Возвращает { id, date, time, doctor, name, phone, telegram, service, comment, chatId }.
 * Ошибки: bad_input, slot_taken, busy.
 */
function createBooking_(b) {
  var doctor = String(b.doctor || '').trim();
  var date = parseDateISO(b.date);
  var time = parseTime(b.time);
  var name = cleanText_(b.name);
  var phone = cleanText_(b.phone);
  var phoneDigits = phone.replace(/\D/g, '');
  var telegram = cleanText_(b.telegram).slice(0, 64);
  var service = cleanText_(b.service).slice(0, 150);
  var comment = cleanText_(b.comment).slice(0, 500);
  var chatId = String(b.chatId || '').trim();

  if (doctor && DOCTORS.indexOf(doctor) === -1) throw apiError_('bad_input', 'Неизвестный врач.');
  if (!date || !time) throw apiError_('bad_input', 'Выберите дату и время.');
  if (!name || name.length > 80) throw apiError_('bad_input', 'Укажите имя (до 80 символов).');
  if (phoneDigits.length < 10 || phoneDigits.length > 11) {
    throw apiError_('bad_input', 'Проверьте номер телефона: нужно 10–11 цифр.');
  }

  var id;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_('busy', 'Сервер занят, попробуйте ещё раз через минуту.');
  try {
    // Слот должен существовать в «Окна» (без врача — любое окно на это время)…
    var exists = readSlotRows_().some(function (s) {
      return s.date === date && s.time === time && (!doctor || s.doctor === doctor);
    });
    if (!exists) throw apiError_('slot_taken', 'Это время недоступно. Выберите другое.');
    // …не должен быть в прошлом…
    if (date + ' ' + time < nowPlusHourKey_()) {
      throw apiError_('slot_taken', 'Это время уже прошло. Выберите другое.');
    }
    // …и не должен быть занят.
    if (isSlotBusy_(getBusyKeys_(), date, time, doctor)) {
      throw apiError_('slot_taken', 'Это время только что заняли. Выберите другое.');
    }

    var sh = getSheet_(SHEETS.appointments);
    id = nextId_(sh, 2);
    var created = Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm');
    var row = [
      id,
      created,
      isoToRu_(date),
      time,
      doctor || TEAM_DOCTOR,
      safeCell_(name),
      safeCell_(phone),
      safeCell_(telegram),
      safeCell_(service),
      safeCell_(comment),
      'новая',
      chatId,
    ];
    writeRow_(sh, sh.getLastRow() + 1, row,
      ['0', '@', '@', '@', '@', '@', '@', '@', '@', '@', '@', '@']);
    SpreadsheetApp.flush(); // записать до снятия блокировки
  } finally {
    lock.releaseLock();
  }

  var rec = {
    id: id, date: date, time: time, doctor: doctor || TEAM_DOCTOR,
    name: name, phone: phone, telegram: telegram, service: service,
    comment: comment, chatId: chatId, status: 'новая',
  };

  // Уведомление персоналу в Telegram (если бот настроен). Любая ошибка
  // здесь не мешает записи — она уже сохранена.
  try {
    notifyStaffNewBooking_(rec);
  } catch (e) {
    Logger.log('Уведомление о записи: ' + e);
  }

  return { id: id, date: date, time: time, doctor: doctor || '', name: name, phone: phone,
    telegram: telegram, service: service, comment: comment, chatId: chatId };
}

// ------------------------------------------------------------
// Вход персонала
// ------------------------------------------------------------

/**
 * Проверяет пароль персонала (свойство скрипта STAFF_PASSWORD).
 * Защита от перебора: после 5 неудачных попыток за 10 минут
 * вход блокируется для всех на эти 10 минут (счётчик в CacheService).
 * При успехе выдаёт случайный токен, который живёт 12 часов.
 *
 * Почему токен хранится в Script Properties, а не в CacheService:
 * CacheService держит данные максимум 6 часов, а по контракту нужно 12.
 * Поэтому храним «токен → время истечения» в свойствах скрипта
 * и при каждом входе удаляем просроченные токены.
 */
function login_(password) {
  checkStaffPassword_(password);
  var props = PropertiesService.getScriptProperties();
  cleanupTokens_(props);
  var token = Utilities.getUuid();
  props.setProperty('TOKEN_' + token, String(Date.now() + TOKEN_TTL_MS));
  return { token: token, name: 'Персонал' };
}

/**
 * Проверка пароля персонала — общая для админки сайта и для /login в боте.
 * Ничего не возвращает; при неверном пароле бросает ошибку "auth",
 * при превышении лимита попыток — "too_many". Лимит общий (глобальный):
 * не больше 5 неудачных попыток за 10 минут.
 */
function checkStaffPassword_(password) {
  var cache = CacheService.getScriptCache();
  var fails = parseInt(cache.get('login_fails') || '0', 10);
  if (fails >= LOGIN_MAX_FAILS) {
    throw apiError_('too_many', 'Слишком много попыток. Подождите 10 минут.');
  }

  var props = PropertiesService.getScriptProperties();
  var real = props.getProperty('STAFF_PASSWORD');
  if (!real) throw apiError_('not_configured', 'Пароль персонала не задан в настройках скрипта.');

  if (typeof password !== 'string' || password !== real) {
    cache.put('login_fails', String(fails + 1), LOGIN_WINDOW_SEC);
    throw apiError_('auth', 'Неверный пароль.');
  }
}

/**
 * Проверяет токен из запроса админки. Если токена нет или он
 * просрочен — ошибка с кодом "auth" (админка вернёт на экран входа).
 */
function requireAuth_(token) {
  if (!token || typeof token !== 'string' || !/^[0-9a-f-]{36}$/i.test(token)) {
    throw apiError_('auth', 'Нужно войти заново.');
  }
  var props = PropertiesService.getScriptProperties();
  var exp = parseInt(props.getProperty('TOKEN_' + token) || '0', 10);
  if (!exp || exp < Date.now()) {
    if (exp) props.deleteProperty('TOKEN_' + token);
    throw apiError_('auth', 'Сессия истекла, войдите заново.');
  }
}

/** Удаляет из свойств скрипта все просроченные токены. */
function cleanupTokens_(props) {
  var all = props.getProperties();
  var now = Date.now();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('TOKEN_') === 0 && parseInt(all[k], 10) < now) props.deleteProperty(k);
  });
}

/**
 * Выйти на всех устройствах: удаляет все токены.
 * Запускать вручную из редактора, например после смены пароля.
 */
function logoutEverywhere() {
  var props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).forEach(function (k) {
    if (k.indexOf('TOKEN_') === 0) props.deleteProperty(k);
  });
}

// ------------------------------------------------------------
// Админка: чтение
// ------------------------------------------------------------

/**
 * Последние `limit` строк листа (новые сверху): { headers, rows }.
 * sheet ∈ appointments | visits | expenses | patients.
 * - Учитывает, что у «Визиты» и «Расходы» заголовки во 2-й строке.
 * - Пустые строки пропускает; у «Пациенты» пропускает заготовки,
 *   где есть только ID без ФИО.
 * - Числа отдаёт числами, всё остальное — так, как видно в таблице
 *   (даты «16.05.2026», время «15:00»).
 */
function adminList_(sheetKey, limit) {
  var layout = LIST_LAYOUT[sheetKey];
  if (!layout) throw apiError_('bad_input', 'Неизвестный лист.');
  var n = parseInt(limit, 10);
  if (!(n > 0)) n = 50;
  if (n > 500) n = 500;

  var sh = getSheet_(layout.sheet);
  var w = layout.width;
  var headers = sh.getRange(layout.headerRow, 1, 1, w).getDisplayValues()[0]
    .map(function (h) { return cleanText_(h); });
  if (sheetKey === 'visits' && !headers[0]) headers[0] = 'Пациент'; // в листе колонка без заголовка

  var first = layout.headerRow + 1;
  var last = sh.getLastRow();
  if (last < first) return { headers: headers, rows: [] };

  var range = sh.getRange(first, 1, last - first + 1, w);
  var values = range.getValues();
  var display = range.getDisplayValues();

  var rows = [];
  for (var i = values.length - 1; i >= 0 && rows.length < n; i--) {
    var raw = values[i];
    var disp = display[i];
    // Пустая строка?
    var empty = disp.every(function (c) { return String(c).trim() === ''; });
    if (empty) continue;
    // Заготовка в «Пациенты»: есть только ID
    if (sheetKey === 'patients' && cleanText_(disp[1]) === '') continue;

    rows.push(raw.map(function (v, j) {
      return typeof v === 'number' ? v : String(disp[j]);
    }));
  }
  return { headers: headers, rows: rows };
}

// ------------------------------------------------------------
// Админка: добавление строк
// ------------------------------------------------------------

/**
 * Добавляет строку в лист. sheet ∈ visits | expenses | patients | slots.
 * Ключи row описаны в CONTRACT.md. Все тексты защищены от формул.
 */
function adminAdd_(sheetKey, row) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_('busy', 'Сервер занят, попробуйте ещё раз.');
  try {
    var result;
    switch (sheetKey) {
      case 'visits': result = addVisit_(row); break;
      case 'expenses': result = addExpense_(row); break;
      case 'patients': result = addPatient_(row); break;
      case 'slots': result = addSlot_(row); break;
      default: throw apiError_('bad_input', 'Неизвестный лист.');
    }
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Визит → лист «Визиты»:
 * (Пациент) | Дата визита | Тип работы | Диагноз/ состояние | Врач | Цена | Зуб
 */
function addVisit_(r) {
  var patient = cleanText_(r.patient).slice(0, 120);
  var date = parseDateISO(r.date);
  if (!patient) throw apiError_('bad_input', 'Укажите пациента.');
  if (!date) throw apiError_('bad_input', 'Укажите дату визита.');
  var doctor = cleanText_(r.doctor);
  if (doctor && DOCTORS.indexOf(doctor) === -1) throw apiError_('bad_input', 'Неизвестный врач.');
  var price = parseMoney_(r.price);

  var sh = getSheet_(SHEETS.visits);
  writeRow_(sh, sh.getLastRow() + 1, [
    safeCell_(patient),
    isoToDate_(date),
    safeCell_(cleanText_(r.type).slice(0, 60)),
    safeCell_(cleanText_(r.note).slice(0, 500)),
    doctor,
    price === null ? '' : price,
    safeCell_(cleanText_(r.tooth).slice(0, 40)),
  ], ['@', 'dd.MM.yyyy', '@', '@', '@', '#,##0', '@']);
  return { added: true };
}

/**
 * Доход или расход → лист «Расходы»:
 * Дата | Категория | Статья | Сумма | Комментарий
 */
function addExpense_(r) {
  var date = parseDateISO(r.date);
  var category = cleanText_(r.category).toLowerCase();
  var amount = parseMoney_(r.amount);
  var item = cleanText_(r.item).slice(0, 120);
  if (!date) throw apiError_('bad_input', 'Укажите дату.');
  if (category !== 'доход' && category !== 'расход') throw apiError_('bad_input', 'Категория: доход или расход.');
  if (!item) throw apiError_('bad_input', 'Укажите статью.');
  if (amount === null || amount < 0) throw apiError_('bad_input', 'Укажите сумму.');

  var sh = getSheet_(SHEETS.expenses);
  writeRow_(sh, sh.getLastRow() + 1, [
    isoToDate_(date),
    category,
    safeCell_(item),
    amount,
    safeCell_(cleanText_(r.comment).slice(0, 300)),
  ], ['dd.MM.yyyy', '@', '@', '#,##0', '@']);
  return { added: true };
}

/**
 * Пациент → лист «Пациенты»:
 * ID | ФИО | TG | Дата рождения | Телефон | Последний визит | … | Врач | Фото
 * В листе заранее заготовлены строки с одним ID. Новый пациент занимает
 * первую такую строку (ID есть, ФИО пусто). Если заготовок нет —
 * дописываем строку в конец с ID = максимальный + 1.
 */
function addPatient_(r) {
  var name = cleanText_(r.name).slice(0, 120);
  if (!name) throw apiError_('bad_input', 'Укажите ФИО.');
  var doctor = cleanText_(r.doctor);
  if (doctor && DOCTORS.indexOf(doctor) === -1) throw apiError_('bad_input', 'Неизвестный врач.');
  var birthday = r.birthday ? parseDateISO(r.birthday) : null;
  if (r.birthday && !birthday) throw apiError_('bad_input', 'Проверьте дату рождения.');

  var sh = getSheet_(SHEETS.patients);
  var last = sh.getLastRow();
  var targetRow = 0;
  var id;

  if (last >= 2) {
    var ab = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < ab.length; i++) {
      if (String(ab[i][0]).trim() !== '' && String(ab[i][1]).trim() === '') {
        targetRow = i + 2;
        id = ab[i][0];
        break;
      }
    }
  }
  if (!targetRow) {
    id = nextId_(sh, 2);
    targetRow = last + 1;
    sh.getRange(targetRow, 1).setValue(id);
  }

  // Колонки B–E: ФИО, TG, Дата рождения, Телефон
  var bToE = sh.getRange(targetRow, 2, 1, 4);
  bToE.setNumberFormats([['@', '@', 'dd.MM.yyyy', '@']]);
  bToE.setValues([[
    safeCell_(name),
    safeCell_(cleanText_(r.telegram).slice(0, 64)),
    birthday ? isoToDate_(birthday) : '',
    safeCell_(cleanText_(r.phone).slice(0, 40)),
  ]]);
  // Колонка I: Врач
  if (doctor) sh.getRange(targetRow, 9).setValue(doctor);

  return { added: true, id: id };
}

/**
 * Окно приёма → лист «Окна»:
 * Дата | Время | Врач | Длительность (мин) | Комментарий
 * Врач необязателен: пустой — общее окно команды (основной вариант).
 * Если точно такое же окно уже есть — второй раз не добавляем.
 */
function addSlot_(r) {
  var date = parseDateISO(r.date);
  var time = parseTime(r.time);
  var doctor = cleanText_(r.doctor);
  if (!date) throw apiError_('bad_input', 'Укажите дату.');
  if (!time) throw apiError_('bad_input', 'Укажите время в формате ЧЧ:ММ.');
  if (doctor && DOCTORS.indexOf(doctor) === -1) throw apiError_('bad_input', 'Неизвестный врач.');
  var minutes = parseInt(r.minutes, 10);
  if (!(minutes > 0)) minutes = '';

  var key = slotKey_(date, time, doctor);
  var dup = readSlotRows_().some(function (s) { return slotKey_(s.date, s.time, s.doctor) === key; });
  if (dup) return { added: true, duplicate: true };

  var sh = getSheet_(SHEETS.slots);
  writeRow_(sh, sh.getLastRow() + 1, [
    isoToDate_(date),
    time,
    doctor, // пусто — общее окно
    minutes,
    safeCell_(cleanText_(r.comment).slice(0, 200)),
  ], ['dd.MM.yyyy', '@', '@', '0', '@']);
  return { added: true };
}

// ------------------------------------------------------------
// Админка: смена статуса онлайн-записи
// ------------------------------------------------------------

/**
 * Находит в «Онлайн-запись» строку с ID = rowId и меняет «Статус».
 */
function adminUpdateStatus_(rowId, status) {
  status = cleanText_(status);
  if (STATUSES.indexOf(status) === -1) throw apiError_('bad_input', 'Неизвестный статус.');
  var id = String(rowId === undefined || rowId === null ? '' : rowId).trim();
  if (!id) throw apiError_('bad_input', 'Не указана запись.');

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw apiError_('busy', 'Сервер занят, попробуйте ещё раз.');
  try {
    var sh = getSheet_(SHEETS.appointments);
    var last = sh.getLastRow();
    if (last < 2) throw apiError_('not_found', 'Запись не найдена.');
    var ids = sh.getRange(2, 1, last - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0]).trim() === id) {
        sh.getRange(i + 2, 11).setValue(status);
        SpreadsheetApp.flush();
        return { updated: true };
      }
    }
    throw apiError_('not_found', 'Запись не найдена.');
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------
// Разбор дат, времени и денег
// ------------------------------------------------------------

/**
 * Превращает дату из ячейки или запроса в строку «yyyy-MM-dd» (по Москве).
 * Понимает:
 *   - объект Date (настоящая дата Google Sheets);
 *   - «2026-11-02» (так присылает сайт);
 *   - «16.05.2026», «16.05.26», «13.2.2026» (дд.мм.гггг / дд.мм.гг);
 *   - «29.05» (без года — берётся текущий год).
 * Если разобрать не удалось или дата не существует (31.02) — вернёт null.
 */
function parseDateISO(v) {
  if (v === null || v === undefined || v === '') return null;

  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return null;
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }

  var s = String(v).trim();
  var y, m, d, mt;

  if ((mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    y = +mt[1]; m = +mt[2]; d = +mt[3];
  } else if ((mt = s.match(/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2}|\d{4}))?$/))) {
    d = +mt[1]; m = +mt[2];
    if (mt[3]) {
      y = +mt[3];
      if (mt[3].length === 2) y += 2000;
    } else {
      y = +Utilities.formatDate(new Date(), TZ, 'yyyy');
    }
  } else {
    return null;
  }

  // Проверяем, что такая дата существует (не 31.02)
  var test = new Date(Date.UTC(y, m - 1, d));
  if (test.getUTCFullYear() !== y || test.getUTCMonth() !== m - 1 || test.getUTCDate() !== d) return null;
  return y + '-' + pad2_(m) + '-' + pad2_(d);
}

/**
 * Время → строка «HH:mm».
 * raw — значение (строка «15:00», «9:00», «15:00:00», «15.00» или Date из ячейки времени);
 * display — то, что видно в ячейке (getDisplayValues). Видимый текст надёжнее:
 * у ячеек времени Google хранит дату 30.12.1899, и при пересчёте часового
 * пояса возможен сдвиг на минуты.
 */
function parseTime(raw, display) {
  var fromText = function (s) {
    var mt = String(s || '').trim().match(/^(\d{1,2})[:.;](\d{2})(?::\d{2})?$/);
    if (!mt) return null;
    var h = +mt[1], mi = +mt[2];
    if (h > 23 || mi > 59) return null;
    return pad2_(h) + ':' + pad2_(mi);
  };

  var t = fromText(display);
  if (t) return t;
  if (Object.prototype.toString.call(raw) === '[object Date]') {
    if (isNaN(raw.getTime())) return null;
    return Utilities.formatDate(raw, TZ, 'HH:mm');
  }
  if (typeof raw === 'number' && raw >= 0 && raw < 1) {
    // Время как доля суток
    var total = Math.round(raw * 1440);
    return pad2_(Math.floor(total / 60)) + ':' + pad2_(total % 60);
  }
  return fromText(raw);
}

/**
 * Деньги → число. Понимает число и строки вида «р. 4 500,00», «4500», «4 500 ₽».
 * «р. -» (пусто в денежном формате) и мусор → null.
 */
function parseMoney_(v) {
  if (typeof v === 'number') return isNaN(v) ? null : v;
  if (v === null || v === undefined) return null;
  var s = String(v)
    .replace(/[\s  ]/g, '')   // пробелы, в т.ч. неразрывные
    .replace(/[^\d,.\-]/g, '')           // убираем «р.», «₽» и т.п.
    .replace(/^[.,]+/, '')               // точка от «р.» в начале
    .replace(',', '.');
  if (!/\d/.test(s)) return null;
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// ------------------------------------------------------------
// Мелкие помощники
// ------------------------------------------------------------

/** Лист по имени; если его нет — понятная ошибка. */
function getSheet_(name) {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) {
    throw apiError_('no_sheet', 'В таблице нет листа «' + name + '». Запустите setup() в редакторе скрипта.');
  }
  return sh;
}

/**
 * Пишет строку values в строку листа rowIndex, предварительно
 * задав форматы ячеек (например '@' — текст, 'dd.MM.yyyy' — дата).
 */
function writeRow_(sh, rowIndex, values, formats) {
  var range = sh.getRange(rowIndex, 1, 1, values.length);
  if (formats) range.setNumberFormats([formats]);
  range.setValues([values]);
}

/** Следующий ID: максимум числового значения в колонке A (с строки firstRow) + 1. */
function nextId_(sh, firstRow) {
  var last = sh.getLastRow();
  var max = 0;
  if (last >= firstRow) {
    sh.getRange(firstRow, 1, last - firstRow + 1, 1).getValues().forEach(function (r) {
      var n = parseInt(r[0], 10);
      if (n > max) max = n;
    });
  }
  return max + 1;
}

/**
 * Защита от формул: если текст начинается с = + - @, Google Таблица
 * может принять его за формулу. Добавляем апостроф — он не виден в ячейке,
 * но заставляет считать значение обычным текстом.
 */
function safeCell_(s) {
  s = String(s === null || s === undefined ? '' : s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** Убирает пробелы по краям и сжимает повторные пробелы/переносы. */
function cleanText_(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[\s ]+/g, ' ').trim();
}

/** «2026-11-02» → «02.11.2026». */
function isoToRu_(iso) {
  var p = iso.split('-');
  return p[2] + '.' + p[1] + '.' + p[0];
}

/** «2026-11-02» → объект Date (полночь по Москве) для записи в ячейку-дату. */
function isoToDate_(iso) {
  return Utilities.parseDate(iso, TZ, 'yyyy-MM-dd');
}

/** Сегодня по Москве: «yyyy-MM-dd». */
function todayISO_() {
  return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
}

/** «yyyy-MM-dd» + n дней → «yyyy-MM-dd» (считаем в UTC, чтобы не мешали переходы времени). */
function addDaysISO_(iso, n) {
  var p = iso.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

/** «Сейчас + 1 час» по Москве в виде «yyyy-MM-dd HH:mm» — для сравнения строк. */
function nowPlusHourKey_() {
  return Utilities.formatDate(new Date(Date.now() + 60 * 60 * 1000), TZ, 'yyyy-MM-dd HH:mm');
}

/** 5 → «05». */
function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** Создаёт ошибку API с кодом для ответа { ok:false, error:code }. */
function apiError_(code, message) {
  var e = new Error(message);
  e.apiCode = code;
  return e;
}

/** Успешный JSON-ответ. */
function jsonOk(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, data: data }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * JSON-ответ с ошибкой. Ошибки API (apiError_) отдаются как есть,
 * неожиданные — с кодом "server" (подробности пишутся в журнал выполнения).
 */
function jsonError(err) {
  var code = (err && err.apiCode) || 'server';
  var message = (err && err.apiCode && err.message) || 'Ошибка сервера. Попробуйте позже.';
  if (!err || !err.apiCode) Logger.log(err && err.stack ? err.stack : String(err));
  return ContentService
    .createTextOutput(JSON.stringify({ ok: false, error: code, message: message }))
    .setMimeType(ContentService.MimeType.JSON);
}
