/**
 * ============================================================
 * Telegram-бот для врачей и пациентов.
 * Второй файл того же проекта Apps Script, что и Code.gs:
 * все функции общие (глобальные), поэтому бот пользуется
 * функциями Code.gs — чтение «Окна», занятость, createBooking_ и т.д.
 *
 * Как это работает:
 *  - Telegram присылает каждое сообщение/нажатие кнопки POST-запросом
 *    на адрес веб-приложения <exec>?tg=<секрет> (вебхук).
 *  - doPost в Code.gs узнаёт такой запрос по полю update_id, сверяет
 *    секрет и вызывает handleTelegramUpdate_ отсюда.
 *  - Бот отвечает, вызывая Telegram Bot API через UrlFetchApp.
 *
 * Свойства скрипта (Настройки проекта → Свойства скрипта):
 *   TELEGRAM_BOT_TOKEN — токен от @BotFather (обязательно);
 *   TG_WEBHOOK_SECRET  — секрет вебхука (создаётся сам в setWebhook);
 *   STAFF_PASSWORD     — пароль персонала (тот же, что для админки);
 *   STAFF_CHAT_IDS     — список чатов персонала (заполняется сам через /login);
 *   SITE_URL           — адрес сайта, например https://user.github.io/dentist;
 *   WEBAPP_URL         — адрес /exec, если setWebhook не смог его узнать сам;
 *   TELEGRAM_CHAT_ID   — запасной чат для уведомлений, пока никто не вошёл.
 *
 * Ручные функции (запускать из редактора): setWebhook, deleteWebhook,
 * setBotCommands, installTriggers. По расписанию: dailyReminders.
 * ============================================================
 */

// ------------------------------------------------------------
// Настройки бота — их легко поменять
// ------------------------------------------------------------

/** Половинки рабочего дня (часы начала и конца). Окна — по 1 часу. */
var MORNING = { start: 9, end: 14, label: 'Утро' };
var EVENING = { start: 15, end: 21, label: 'Вечер' };
var SLOT_MINUTES = 60;

/** На сколько дней вперёд бот предлагает запись и показывает «Записи». */
var BOT_DAYS = 14;

/** Сколько недель показывает календарь «Рабочие дни» за раз. */
var CAL_WEEKS = 4;

/** Лист с планами лечения. */
var PLAN_SHEET = 'Планы';
var PLAN_HEADERS = ['ID', 'Создано', 'Пациент', 'Телефон', 'Услуга', 'Комментарий врача',
  'Желательно до', 'Код', 'chat_id пациента', 'Статус', 'Напомнено'];
var PLAN_STATUSES = ['активен', 'записан', 'выполнен'];

/** Контакты клиники для пациентов. */
var CLINIC_TEXT =
  '<b>Где мы принимаем</b>\n' +
  'Клиника «Баланс Дент»\n' +
  'Москва, ул. Сивашская, 7, корп. 1\n' +
  '5 минут пешком от м. Нахимовский проспект';

/** Кнопки главного меню (reply-клавиатура). */
var STAFF_MENU = ['Рабочие дни', 'Записи', 'План лечения', 'Пациент: найти'];
var PATIENT_MENU = ['Записаться', 'Мой план лечения', 'Мои записи', 'Контакты'];

/** Время жизни состояния диалога (секунды) и памяти об обработанных обновлениях. */
var STATE_TTL_SEC = 60 * 60;
var UPDATE_TTL_SEC = 10 * 60;

/** Названия месяцев и дней недели для красивых дат. */
var MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
  'августа', 'сентября', 'октября', 'ноября', 'декабря'];
var WD_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

// ------------------------------------------------------------
// Ручные функции настройки
// ------------------------------------------------------------

/**
 * Подключает бота к веб-приложению: говорит Telegram, куда слать сообщения.
 * Запускать после КАЖДОГО нового развёртывания, если менялся адрес /exec
 * (при «Управление развёртываниями → Новая версия» адрес не меняется).
 * Секрет TG_WEBHOOK_SECRET создаётся автоматически, если его нет.
 */
function setWebhook() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('WEBAPP_URL') || ScriptApp.getService().getUrl() || '';
  if (!/\/exec$/.test(url)) {
    throw new Error('Не удалось узнать адрес /exec. Вставьте его в свойство скрипта WEBAPP_URL ' +
      '(Развернуть → Управление развёртываниями → URL веб-приложения) и запустите снова. Сейчас: ' + url);
  }
  var secret = props.getProperty('TG_WEBHOOK_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '');
    props.setProperty('TG_WEBHOOK_SECRET', secret);
  }
  var res = tgApi_('setWebhook', {
    url: url + '?tg=' + secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
    max_connections: 10,
  });
  Logger.log('setWebhook: ' + JSON.stringify(res));
  // Заодно запоминаем username бота (нужен для ссылок-приглашений)
  props.deleteProperty('BOT_USERNAME');
  Logger.log('Бот: @' + getBotUsername_());
}

/** Отключает вебхук (бот перестаёт отвечать). */
function deleteWebhook() {
  Logger.log('deleteWebhook: ' + JSON.stringify(tgApi_('deleteWebhook', { drop_pending_updates: true })));
}

/** Показывает в журнале состояние вебхука — удобно для проверки. */
function webhookInfo() {
  Logger.log(JSON.stringify(tgApi_('getWebhookInfo', {}), null, 2));
}

/** Список команд в меню Telegram (кнопка «Меню» слева от поля ввода). */
function setBotCommands() {
  var res = tgApi_('setMyCommands', {
    commands: [
      { command: 'start', description: 'Главное меню' },
      { command: 'cancel', description: 'Отменить текущее действие' },
      { command: 'login', description: 'Вход для врачей: /login пароль' },
      { command: 'logout', description: 'Выход для врачей' },
    ],
  });
  Logger.log('setMyCommands: ' + JSON.stringify(res));
}

/**
 * Создаёт ежедневный триггер для dailyReminders на 12:00 по Москве.
 * Старые триггеры этой функции удаляет, чтобы не было дублей.
 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyReminders').timeBased().everyDays(1).atHour(12).inTimezone(TZ).create();
  Logger.log('Триггер dailyReminders создан: каждый день около 12:00 (Москва).');
}

// ------------------------------------------------------------
// Связь с Telegram Bot API
// ------------------------------------------------------------

/**
 * Вызов метода Telegram Bot API. Возвращает разобранный JSON-ответ.
 * Ошибки Telegram (например, пациент заблокировал бота) не бросаются,
 * а пишутся в журнал — бот не должен падать из-за одного сообщения.
 */
function tgApi_(method, payload) {
  var token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if (!token) throw new Error('Не задано свойство скрипта TELEGRAM_BOT_TOKEN.');
  var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
  });
  var json = {};
  try { json = JSON.parse(resp.getContentText()); } catch (e) { json = { ok: false }; }
  if (!json.ok) Logger.log('Telegram ' + method + ': ' + resp.getContentText());
  return json;
}

/**
 * Отправить сообщение. text — HTML (весь пользовательский текст
 * пропускать через escapeHtml_). keyboard — inline- или reply-клавиатура.
 */
function sendMessage_(chatId, text, keyboard) {
  var p = { chat_id: chatId, text: text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (keyboard) p.reply_markup = keyboard;
  return tgApi_('sendMessage', p);
}

/** Изменить текст уже отправленного сообщения (например, листание календаря). */
function editMessage_(chatId, messageId, text, keyboard) {
  var p = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML',
    disable_web_page_preview: true };
  if (keyboard) p.reply_markup = keyboard;
  return tgApi_('editMessageText', p);
}

/** Ответ на нажатие inline-кнопки (обязателен, иначе кнопка «крутится»). */
function answerCallback_(callbackId, text) {
  var p = { callback_query_id: callbackId };
  if (text) p.text = text;
  return tgApi_('answerCallbackQuery', p);
}

/** Удалить сообщение (используется для сообщения с паролем). */
function deleteMessage_(chatId, messageId) {
  return tgApi_('deleteMessage', { chat_id: chatId, message_id: messageId });
}

/**
 * Экранирование для parse_mode HTML: & < > " — обязательно для любого
 * текста, пришедшего от пользователя или из таблицы.
 */
function escapeHtml_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Inline-клавиатура из рядов кнопок [[{text, callback_data}|{text, url}]]. */
function inlineKb_(rows) {
  return { inline_keyboard: rows.filter(function (r) { return r && r.length; }) };
}

/** Кнопка с callback_data (≤ 64 байт — поэтому данные короткие и латиницей). */
function btn_(text, data) {
  return { text: text, callback_data: data };
}

/** Reply-клавиатура главного меню (2 кнопки в ряд). */
function menuKb_(items) {
  var rows = [];
  for (var i = 0; i < items.length; i += 2) {
    rows.push(items.slice(i, i + 2).map(function (t) { return { text: t }; }));
  }
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

/** Username бота (через getMe), запоминается в свойствах скрипта. */
function getBotUsername_() {
  var props = PropertiesService.getScriptProperties();
  var u = props.getProperty('BOT_USERNAME');
  if (u) return u;
  var me = tgApi_('getMe', {});
  u = (me.ok && me.result && me.result.username) || '';
  if (u) props.setProperty('BOT_USERNAME', u);
  return u;
}

/** Адрес сайта без «/» на конце (или пусто, если SITE_URL не задан). */
function siteUrl_() {
  return String(PropertiesService.getScriptProperties().getProperty('SITE_URL') || '').trim().replace(/\/+$/, '');
}

// ------------------------------------------------------------
// Состояние диалога и защита от повторов
// ------------------------------------------------------------

/** Что бот сейчас ждёт от пользователя (объект или null). Живёт 1 час. */
function getState_(chatId) {
  var raw = CacheService.getScriptCache().get('st_' + chatId);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function setState_(chatId, state) {
  CacheService.getScriptCache().put('st_' + chatId, JSON.stringify(state), STATE_TTL_SEC);
}

function clearState_(chatId) {
  CacheService.getScriptCache().remove('st_' + chatId);
}

/**
 * true, если это обновление уже обрабатывали (Telegram иногда присылает
 * одно и то же повторно). Помним update_id 10 минут.
 */
function alreadyHandled_(updateId) {
  var cache = CacheService.getScriptCache();
  var key = 'upd_' + updateId;
  if (cache.get(key)) return true;
  cache.put(key, '1', UPDATE_TTL_SEC);
  return false;
}

// ------------------------------------------------------------
// Персонал: список чатов
// ------------------------------------------------------------

/** Список chat_id персонала из свойства STAFF_CHAT_IDS (JSON-массив строк). */
function getStaffIds_() {
  var raw = PropertiesService.getScriptProperties().getProperty('STAFF_CHAT_IDS') || '[]';
  try {
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch (e) {
    return [];
  }
}

function isStaff_(chatId) {
  return getStaffIds_().indexOf(String(chatId)) !== -1;
}

/** Добавить или убрать chat_id из персонала (под блокировкой). */
function setStaff_(chatId, on) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ids = getStaffIds_().filter(function (x) { return x !== String(chatId); });
    if (on) ids.push(String(chatId));
    PropertiesService.getScriptProperties().setProperty('STAFF_CHAT_IDS', JSON.stringify(ids));
  } finally {
    lock.releaseLock();
  }
}

/** Отправить сообщение всем врачам. Если никто не вошёл — в запасной TELEGRAM_CHAT_ID. */
function sendToStaff_(text, keyboard) {
  var ids = getStaffIds_();
  if (!ids.length) {
    var fallback = PropertiesService.getScriptProperties().getProperty('TELEGRAM_CHAT_ID');
    if (fallback) ids = [fallback];
  }
  ids.forEach(function (id) {
    try { sendMessage_(id, text, keyboard); } catch (e) { Logger.log('sendToStaff_: ' + e); }
  });
  return ids.length;
}

/**
 * Уведомление персоналу о новой записи (с сайта или из бота).
 * Вызывается из createBooking_ в Code.gs. Ничего не делает, если бот не настроен.
 */
function notifyStaffNewBooking_(rec) {
  if (!PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN')) return;
  var text = '<b>Новая запись #' + rec.id + '</b>\n' + apptText_(rec, true) +
    (rec.chatId ? '\n<i>через Telegram-бота</i>' : '\n<i>с сайта</i>');
  sendToStaff_(text, inlineKb_([[btn_('Подтвердить', 'ap:' + rec.id + ':c'), btn_('Отменить', 'ap:' + rec.id + ':x')]]));
}

// ------------------------------------------------------------
// Главный обработчик
// ------------------------------------------------------------

/**
 * Точка входа бота: одно обновление от Telegram.
 * Разбирает обычные сообщения и нажатия inline-кнопок.
 */
function handleTelegramUpdate_(u) {
  if (alreadyHandled_(u.update_id)) return;

  if (u.callback_query) {
    handleCallback_(u.callback_query);
    return;
  }
  var m = u.message;
  if (!m || !m.chat || m.chat.type !== 'private') return; // работаем только в личных чатах
  try {
    handleMessage_(m);
  } catch (err) {
    Logger.log('handleMessage_: ' + (err && err.stack ? err.stack : err));
    sendMessage_(m.chat.id, escapeHtml_(err && err.apiCode ? err.message : 'Что-то пошло не так. Попробуйте ещё раз или нажмите /start.'));
  }
}

/** Обычное сообщение: команды, кнопки меню, ответы на вопросы бота. */
function handleMessage_(m) {
  var chatId = String(m.chat.id);
  var text = String(m.text || '').trim();
  var staff = isStaff_(chatId);

  // --- Команды, доступные всем ---
  if (/^\/login(@\w+)?(\s|$)/.test(text)) {
    deleteMessage_(chatId, m.message_id); // пароль не должен оставаться в чате
    staffLogin_(chatId, text.replace(/^\/login(@\w+)?\s*/, ''));
    return;
  }
  if (/^\/logout/.test(text)) {
    setStaff_(chatId, false);
    clearState_(chatId);
    sendMessage_(chatId, 'Вы вышли из режима персонала.', menuKb_(PATIENT_MENU));
    return;
  }
  if (/^\/cancel/.test(text) || text === 'Отмена') {
    clearState_(chatId);
    sendMessage_(chatId, 'Хорошо, отменили.', menuKb_(staff ? STAFF_MENU : PATIENT_MENU));
    return;
  }
  if (/^\/start/.test(text)) {
    clearState_(chatId);
    var payload = text.split(/\s+/)[1] || '';
    if (staff) {
      sendMessage_(chatId, 'Вы в режиме персонала. Выберите раздел в меню.' +
        (payload ? '\n\nЧтобы проверить ссылку как пациент, сначала нажмите /logout.' : ''), menuKb_(STAFF_MENU));
    } else {
      patientStart_(chatId, m.from, payload);
    }
    return;
  }

  // --- Кнопки главного меню сбрасывают начатый диалог ---
  if (staff && STAFF_MENU.indexOf(text) !== -1) {
    clearState_(chatId);
    if (text === 'Рабочие дни') sendCalendar_(chatId, 0, null);
    else if (text === 'Записи') sendStaffAppointments_(chatId);
    else if (text === 'План лечения') {
      setState_(chatId, { flow: 'plan', step: 'patient' });
      sendMessage_(chatId, 'Кому назначаем план? Напишите ФИО или его часть.',
        inlineKb_([[btn_('Новый пациент', 'pn')]]));
    } else if (text === 'Пациент: найти') {
      setState_(chatId, { flow: 'find' });
      sendMessage_(chatId, 'Напишите ФИО или его часть.');
    }
    return;
  }
  if (!staff && PATIENT_MENU.indexOf(text) !== -1) {
    clearState_(chatId);
    if (text === 'Записаться') startBooking_(chatId, null, m.from);
    else if (text === 'Мой план лечения') sendPatientPlans_(chatId);
    else if (text === 'Мои записи') sendPatientAppointments_(chatId);
    else if (text === 'Контакты') sendContacts_(chatId);
    return;
  }

  // --- Ответ на вопрос бота (состояние диалога) ---
  var st = getState_(chatId);
  if (st) {
    if (staff && st.flow === 'plan') return planText_(chatId, st, text);
    if (staff && st.flow === 'find') return findText_(chatId, text);
    if (!staff && st.flow === 'book') return bookingText_(chatId, st, m);
  }

  // --- Непонятно — показываем меню ---
  sendMessage_(chatId, staff ? 'Выберите раздел в меню.' : 'Выберите, что вас интересует, в меню ниже.',
    menuKb_(staff ? STAFF_MENU : PATIENT_MENU));
}

/**
 * Нажатие inline-кнопки. callback_data — короткая строка «префикс:данные».
 * answerCallbackQuery вызывается ВСЕГДА (в finally), при необходимости
 * с коротким всплывающим текстом, который вернул обработчик.
 */
function handleCallback_(q) {
  var toast = '';
  try {
    var chatId = String(q.message && q.message.chat ? q.message.chat.id : q.from.id);
    var msgId = q.message ? q.message.message_id : null;
    var data = String(q.data || '');
    var parts = data.split(':');
    var cmd = parts[0];
    var staff = isStaff_(chatId);

    // Команды персонала
    var staffCmds = ['cal', 'wd', 'wo', 'mydays', 'cd', 'ap', 'pn', 'pp', 'pg', 'ps', 'po', 'pG', 'pc', 'pd', 'pf', 'pl'];
    if (staffCmds.indexOf(cmd) !== -1 && !staff) return (toast = 'Доступно только персоналу. Войдите: /login пароль');

    switch (cmd) {
      case 'noop': return;
      // --- Рабочие дни ---
      case 'cal': sendCalendar_(chatId, parseInt(parts[1], 10) || 0, msgId); return;
      case 'wd': chooseHalf_(chatId, msgId, compactToIso_(parts[1])); return;
      case 'wo': toast = openDay_(chatId, msgId, compactToIso_(parts[1]), parts[2]); return;
      case 'mydays': sendMyDays_(chatId); return;
      case 'cd': toast = closeDay_(chatId, compactToIso_(parts[1])); return;
      // --- Записи (персонал) ---
      case 'ap': toast = staffApptAction_(chatId, parts[1], parts[2]); return;
      // --- План лечения ---
      case 'pn':
        setState_(chatId, { flow: 'plan', step: 'newname' });
        sendMessage_(chatId, 'Новый пациент. Напишите ФИО.');
        return;
      case 'pp': planPickPatient_(chatId, parseInt(parts[1], 10)); return;
      case 'pg': case 'ps': case 'po': case 'pG': planService_(chatId, cmd, parts[1]); return;
      case 'pc': planComment_(chatId, ''); return;
      case 'pd': planSave_(chatId, parseInt(parts[1], 10) || 0); return;
      case 'pf': sendPatientCard_(chatId, parseInt(parts[1], 10)); return;
      case 'pl': toast = setPlanStatusById_(parts[1], parts[2] === 'd' ? 'выполнен' : 'активен'); return;
      // --- Пациент: запись ---
      case 'bk': startBooking_(chatId, parts[1] === 'p' ? parts[2] : null, q.from); return;
      case 'bg': case 'bs': case 'bo': case 'bG': bookingService_(chatId, cmd, parts[1]); return;
      case 'bd': bookingDate_(chatId, compactToIso_(parts[1])); return;
      case 'bt': bookingTime_(chatId, parts[1]); return;
      case 'bn': bookingNameYes_(chatId); return;
      case 'bc': toast = bookingConfirm_(chatId, parts[1] === 'y', q.from); return;
      // --- Пациент: свои записи и напоминания ---
      case 'mx': patientCancelAsk_(chatId, parts[1]); return;
      case 'mX': toast = patientCancel_(chatId, parts[1]); return;
      case 'rm': toast = patientWillCome_(chatId, parts[1]); return;
      default: return;
    }
  } catch (err) {
    Logger.log('handleCallback_: ' + (err && err.stack ? err.stack : err));
    toast = err && err.apiCode ? err.message : 'Что-то пошло не так. Попробуйте ещё раз.';
  } finally {
    answerCallback_(q.id, toast ? String(toast).slice(0, 190) : '');
  }
}

// ------------------------------------------------------------
// Вход персонала
// ------------------------------------------------------------

/**
 * /login <пароль>. Та же проверка и тот же лимит попыток, что у админки сайта
 * (checkStaffPassword_ в Code.gs). Успех — chat_id попадает в STAFF_CHAT_IDS.
 */
function staffLogin_(chatId, password) {
  if (!password) {
    sendMessage_(chatId, 'Напишите пароль в одном сообщении с командой: <code>/login пароль</code>');
    return;
  }
  try {
    checkStaffPassword_(password);
  } catch (e) {
    sendMessage_(chatId, escapeHtml_(e.apiCode ? e.message : 'Не удалось проверить пароль.'));
    return;
  }
  setStaff_(chatId, true);
  clearState_(chatId);
  sendMessage_(chatId, 'Готово, вы вошли как персонал. Сюда будут приходить уведомления о новых записях.',
    menuKb_(STAFF_MENU));
}

// ------------------------------------------------------------
// Персонал: рабочие дни (календарь)
// ------------------------------------------------------------

/**
 * Календарь на CAL_WEEKS недель, начиная с понедельника текущей недели
 * + offset недель. Кнопка даты — число (у 1-го числа — «1.12»);
 * «•» — день уже открыт; прошедшие дни — «·» без действия.
 * messageId — если задан, редактируем это сообщение (листание).
 */
function sendCalendar_(chatId, offset, messageId) {
  if (offset < 0) offset = 0;
  var today = todayISO_();
  var monday = addDaysISO_(today, -((weekday_(today) + 6) % 7));
  var start = addDaysISO_(monday, offset * 7);
  var end = addDaysISO_(start, CAL_WEEKS * 7 - 1);

  var open = {};
  readSlotRows_().forEach(function (s) { open[s.date] = true; });

  var rows = [['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(function (d) { return btn_(d, 'noop'); })];
  for (var w = 0; w < CAL_WEEKS; w++) {
    var row = [];
    for (var d = 0; d < 7; d++) {
      var iso = addDaysISO_(start, w * 7 + d);
      var day = +iso.slice(8, 10);
      var label = day === 1 ? '1.' + iso.slice(5, 7) : String(day);
      if (iso < today) row.push(btn_('·', 'noop'));
      else row.push(btn_((open[iso] ? '•' : '') + label, 'wd:' + isoToCompact_(iso)));
    }
    rows.push(row);
  }
  var nav = [];
  if (offset > 0) nav.push(btn_('←', 'cal:' + (offset - CAL_WEEKS)));
  nav.push(btn_('Мои ближайшие дни', 'mydays'));
  nav.push(btn_('→', 'cal:' + (offset + CAL_WEEKS)));
  rows.push(nav);

  var text = '<b>Рабочие дни</b>: ' + dayMonth_(start) + ' – ' + dayMonth_(end) + '\n' +
    'Нажмите дату, чтобы открыть запись. «•» — окна уже есть.';
  if (messageId) editMessage_(chatId, messageId, text, inlineKb_(rows));
  else sendMessage_(chatId, text, inlineKb_(rows));
}

/** После выбора даты — какую половину дня открыть. */
function chooseHalf_(chatId, messageId, iso) {
  if (!iso || iso < todayISO_()) {
    editMessage_(chatId, messageId, 'Эта дата уже прошла.', inlineKb_([[btn_('← К календарю', 'cal:0')]]));
    return;
  }
  var c = isoToCompact_(iso);
  editMessage_(chatId, messageId, '<b>' + fmtDayRu_(iso) + '</b>\nКакую половину дня открыть для записи?', inlineKb_([
    [btn_(MORNING.label + ' ' + MORNING.start + '–' + MORNING.end, 'wo:' + c + ':m'),
      btn_(EVENING.label + ' ' + EVENING.start + '–' + EVENING.end, 'wo:' + c + ':e')],
    [btn_('Весь день', 'wo:' + c + ':a'), btn_('Отмена', 'cal:0')],
  ]));
}

/** Часы начала окон для половины (m — утро, e — вечер, a — весь день). */
function halfHours_(which) {
  var blocks = which === 'm' ? [MORNING] : which === 'e' ? [EVENING] : [MORNING, EVENING];
  var times = [];
  blocks.forEach(function (b) {
    for (var t = b.start * 60; t + SLOT_MINUTES <= b.end * 60; t += SLOT_MINUTES) {
      times.push(pad2_(Math.floor(t / 60)) + ':' + pad2_(t % 60));
    }
  });
  return { times: times, label: blocks.map(function (b) { return b.start + ':00–' + b.end + ':00'; }).join(' и ') };
}

/**
 * Открывает день: дописывает почасовые окна в «Окна» (Врач пусто).
 * Окна, которые уже есть на это время (с любым врачом), не дублирует.
 */
function openDay_(chatId, messageId, iso, which) {
  if (!iso || iso < todayISO_()) return 'Эта дата уже прошла.';
  var h = halfHours_(which);
  var added = 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var have = {};
    readSlotRows_().forEach(function (s) { if (s.date === iso) have[s.time] = true; });
    var rows = h.times.filter(function (t) { return !have[t]; }).map(function (t) {
      return [isoToDate_(iso), t, '', SLOT_MINUTES, ''];
    });
    if (rows.length) {
      var sh = getSheet_(SHEETS.slots);
      var range = sh.getRange(sh.getLastRow() + 1, 1, rows.length, 5);
      range.setNumberFormats(rows.map(function () { return ['dd.MM.yyyy', '@', '@', '0', '@']; }));
      range.setValues(rows);
      SpreadsheetApp.flush();
    }
    added = rows.length;
  } finally {
    lock.releaseLock();
  }
  var skipped = h.times.length - added;
  editMessage_(chatId, messageId,
    'Открыто ' + added + ' ' + plural_(added, 'окно', 'окна', 'окон') + ' на ' + fmtDayRu_(iso) + ', ' + h.label + '.' +
    (skipped ? '\nЕщё ' + skipped + ' уже были открыты раньше.' : ''),
    inlineKb_([[btn_('← К календарю', 'cal:0'), btn_('Мои ближайшие дни', 'mydays')]]));
  return 'Готово';
}

/**
 * «Мои ближайшие дни»: открытые даты от сегодня, сколько окон свободно
 * и занято, и кнопка «Закрыть» у каждой даты.
 */
function sendMyDays_(chatId) {
  var today = todayISO_();
  var busy = getBusyKeys_();
  var days = {};
  readSlotRows_().forEach(function (s) {
    if (s.date < today) return;
    var d = days[s.date] || (days[s.date] = { times: {} });
    d.times[s.time] = true;
  });
  var dates = Object.keys(days).sort().slice(0, 12);
  if (!dates.length) {
    sendMessage_(chatId, 'Открытых дней пока нет. Откройте день в календаре.',
      inlineKb_([[btn_('Открыть календарь', 'cal:0')]]));
    return;
  }
  var lines = ['<b>Ближайшие рабочие дни</b>'];
  var rows = [];
  dates.forEach(function (iso) {
    var times = Object.keys(days[iso].times).sort();
    var taken = times.filter(function (t) { return busy[iso + '|' + t]; }).length;
    lines.push(fmtDayRu_(iso) + ', ' + times[0] + '–' + addMinutes_(times[times.length - 1], SLOT_MINUTES) +
      ': свободно ' + (times.length - taken) + ', занято ' + taken);
    rows.push([btn_('Закрыть ' + fmtDayRu_(iso), 'cd:' + isoToCompact_(iso))]);
  });
  rows.push([btn_('← К календарю', 'cal:0')]);
  sendMessage_(chatId, lines.join('\n'), inlineKb_(rows));
}

/**
 * «Закрыть день»: удаляет из «Окна» только СВОБОДНЫЕ строки этой даты.
 * Окна, на которые уже есть запись, остаются — и врач получает предупреждение.
 */
function closeDay_(chatId, iso) {
  if (!iso) return 'Неверная дата.';
  var removed = 0, kept = 0;
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var busy = getBusyKeys_();
    var sh = getSheet_(SHEETS.slots);
    var last = sh.getLastRow();
    if (last >= 2) {
      var range = sh.getRange(2, 1, last - 1, 2);
      var values = range.getValues();
      var display = range.getDisplayValues();
      // Идём снизу вверх, чтобы удаление строк не сдвигало ещё не проверенные
      for (var i = values.length - 1; i >= 0; i--) {
        if (parseDateISO(values[i][0]) !== iso) continue;
        var t = parseTime(values[i][1], display[i][1]);
        if (t && busy[iso + '|' + t]) { kept++; continue; }
        sh.deleteRow(i + 2);
        removed++;
      }
      SpreadsheetApp.flush();
    }
  } finally {
    lock.releaseLock();
  }
  sendMessage_(chatId, fmtDayRu_(iso) + ': закрыто ' + removed + ' ' + plural_(removed, 'окно', 'окна', 'окон') + '.' +
    (kept ? '\n<b>Внимание:</b> ' + kept + ' ' + plural_(kept, 'окно', 'окна', 'окон') +
      ' с записями ' + plural_(kept, 'оставлено', 'оставлены', 'оставлены') +
      ' — если нужно, отмените эти записи в разделе «Записи».' : ''));
  return 'Готово';
}

// ------------------------------------------------------------
// Персонал: записи
// ------------------------------------------------------------

/**
 * Все строки «Онлайн-запись» как объекты:
 * { row, id, date, time, doctor, name, phone, telegram, service, comment, status, chatId }.
 */
function readAppointments_() {
  var sh = getSheet_(SHEETS.appointments);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var range = sh.getRange(2, 1, last - 1, APPT_HEADERS.length);
  var v = range.getValues();
  var d = range.getDisplayValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    var id = String(d[i][0]).trim();
    var date = parseDateISO(v[i][2]);
    if (!id || !date) continue;
    out.push({
      row: i + 2, id: id, date: date, time: parseTime(v[i][3], d[i][3]) || String(d[i][3]),
      doctor: d[i][4], name: d[i][5], phone: d[i][6], telegram: d[i][7], service: d[i][8],
      comment: d[i][9], status: cleanText_(d[i][10]) || 'новая', chatId: String(d[i][11] || '').trim(),
    });
  }
  return out;
}

/** Одна запись по ID (или null). */
function findAppointment_(id) {
  id = String(id);
  var all = readAppointments_();
  for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}

/** Текст записи для сообщений. full — с телефоном и контактами (для персонала). */
function apptText_(a, full) {
  var lines = [fmtDayRu_(a.date) + ', ' + a.time];
  if (full) {
    lines.push('Пациент: ' + escapeHtml_(a.name));
    lines.push('Телефон: ' + escapeHtml_(a.phone));
    if (a.telegram) lines.push('Telegram: ' + escapeHtml_(a.telegram));
  }
  if (a.service) lines.push('Услуга: ' + escapeHtml_(a.service));
  if (full && a.comment) lines.push('Комментарий: ' + escapeHtml_(a.comment));
  return lines.join('\n');
}

/**
 * «Записи»: ближайшие BOT_DAYS дней, статус ≠ «отменена», по дням.
 * Одно сообщение на день, у каждой записи кнопки «Подтвердить» / «Отменить».
 */
function sendStaffAppointments_(chatId) {
  var from = todayISO_();
  var to = addDaysISO_(from, BOT_DAYS);
  var list = readAppointments_().filter(function (a) {
    return a.date >= from && a.date < to && a.status !== 'отменена';
  }).sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; });

  if (!list.length) {
    sendMessage_(chatId, 'На ближайшие ' + BOT_DAYS + ' дней записей нет.');
    return;
  }
  var byDay = {};
  list.forEach(function (a) { (byDay[a.date] = byDay[a.date] || []).push(a); });
  Object.keys(byDay).sort().forEach(function (iso) {
    var lines = ['<b>' + fmtDayRu_(iso) + '</b>'];
    var rows = [];
    byDay[iso].forEach(function (a) {
      lines.push(a.time + ' — ' + escapeHtml_(a.name) + ', ' + escapeHtml_(a.phone) +
        (a.service ? ', ' + escapeHtml_(a.service) : '') + ' [' + escapeHtml_(a.status) + ']');
      var r = [];
      if (a.status === 'новая') r.push(btn_('Подтвердить ' + a.time, 'ap:' + a.id + ':c'));
      r.push(btn_('Отменить ' + a.time, 'ap:' + a.id + ':x'));
      rows.push(r);
    });
    sendMessage_(chatId, lines.join('\n'), inlineKb_(rows));
  });
}

/**
 * Кнопки персонала у записи:
 *   c — подтвердить; x — спросить «точно отменить?»; X — отменить.
 * Пациенту из бота сообщаем о подтверждении/отмене.
 */
function staffApptAction_(chatId, id, act) {
  var a = findAppointment_(id);
  if (!a) return 'Запись не найдена.';
  if (act === 'x') {
    sendMessage_(chatId, 'Отменить запись #' + a.id + '?\n' + apptText_(a, true),
      inlineKb_([[btn_('Да, отменить', 'ap:' + a.id + ':X'), btn_('Нет', 'noop')]]));
    return '';
  }
  if (act === 'c') {
    if (a.status === 'отменена') return 'Запись уже отменена.';
    adminUpdateStatus_(a.id, 'подтверждена');
    sendMessage_(chatId, 'Запись #' + a.id + ' (' + fmtDayRu_(a.date) + ', ' + a.time + ') подтверждена.');
    if (a.chatId) {
      sendMessage_(a.chatId, 'Ваша запись подтверждена:\n' + apptText_(a, false) + '\n\nЖдём вас!');
    }
    return 'Подтверждено';
  }
  if (act === 'X') {
    if (a.status === 'отменена') return 'Уже отменена.';
    adminUpdateStatus_(a.id, 'отменена');
    sendMessage_(chatId, 'Запись #' + a.id + ' (' + fmtDayRu_(a.date) + ', ' + a.time + ') отменена. Время снова свободно.');
    if (a.chatId) {
      var site = siteUrl_();
      sendMessage_(a.chatId, 'К сожалению, ваша запись на ' + fmtDayRu_(a.date) + ', ' + a.time +
        ' отменена. Пожалуйста, выберите другое время.' +
        (site ? '\n<a href="' + escapeHtml_(site + '/booking.html') + '">Записаться на сайте</a>' : ''),
        inlineKb_([[btn_('Записаться снова', 'bk:n')]]));
    }
    return 'Отменено';
  }
  return '';
}

// ------------------------------------------------------------
// Персонал: пациенты
// ------------------------------------------------------------

/**
 * Пациенты из листа «Пациенты» (без пустых заготовок):
 * { row, id, name, tg, birthday, phone, lastVisit, nextVisit, doctor }.
 */
function readPatients_() {
  var sh = getSheet_(SHEETS.patients);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var d = sh.getRange(2, 1, last - 1, 10).getDisplayValues();
  var out = [];
  for (var i = 0; i < d.length; i++) {
    var name = cleanText_(d[i][1]);
    if (!name) continue;
    out.push({ row: i + 2, id: d[i][0], name: name, tg: d[i][2], birthday: d[i][3], phone: d[i][4],
      lastVisit: d[i][5], nextVisit: d[i][6], doctor: d[i][8] });
  }
  return out;
}

/** Нормализация для поиска: нижний регистр, ё → е, лишние пробелы. */
function norm_(s) {
  return cleanText_(s).toLowerCase().replace(/ё/g, 'е');
}

/** Поиск пациентов по части ФИО (каждое слово запроса должно встречаться). */
function searchPatients_(query) {
  var words = norm_(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  return readPatients_().filter(function (p) {
    var n = norm_(p.name);
    return words.every(function (w) { return n.indexOf(w) !== -1; });
  });
}

/** Поиск в разделе «Пациент: найти». */
function findText_(chatId, text) {
  var found = searchPatients_(text);
  if (!found.length) {
    sendMessage_(chatId, 'Никого не нашлось. Попробуйте фамилию или имя отдельно.');
    return;
  }
  if (found.length === 1) {
    clearState_(chatId);
    sendPatientCard_(chatId, found[0].row);
    return;
  }
  sendMessage_(chatId, 'Нашлось: ' + found.length + '. Выберите:', inlineKb_(found.slice(0, 10).map(function (p) {
    return [btn_(p.name, 'pf:' + p.row)];
  })));
}

/** Карточка пациента: контакты, последний визит, активные планы. */
function sendPatientCard_(chatId, row) {
  var p = readPatients_().filter(function (x) { return x.row === row; })[0];
  if (!p) { sendMessage_(chatId, 'Пациент не найден.'); return; }

  // Последний визит: из листа «Визиты» по совпадению ФИО, иначе — колонка «Последний визит»
  var last = '';
  try {
    var sh = getSheet_(SHEETS.visits);
    var n = sh.getLastRow();
    if (n >= 3) {
      var v = sh.getRange(3, 1, n - 2, 3).getValues();
      var key = norm_(p.name);
      v.forEach(function (r) {
        if (norm_(r[0]) !== key) return;
        var iso = parseDateISO(r[1]);
        if (iso && iso > last) last = iso + '|' + cleanText_(r[2]);
      });
    }
  } catch (e) { /* лист может отсутствовать */ }

  var lines = ['<b>' + escapeHtml_(p.name) + '</b>'];
  if (p.phone) lines.push('Телефон: ' + escapeHtml_(p.phone));
  if (p.tg) lines.push('Telegram: ' + escapeHtml_(p.tg));
  if (p.birthday) lines.push('Дата рождения: ' + escapeHtml_(p.birthday));
  if (p.doctor) lines.push('Врач: ' + escapeHtml_(p.doctor));
  if (last) {
    var lp = last.split('|');
    lines.push('Последний визит: ' + isoToRu_(lp[0]) + (lp[1] ? ' (' + escapeHtml_(lp[1]) + ')' : ''));
  } else if (p.lastVisit) {
    lines.push('Последний визит: ' + escapeHtml_(p.lastVisit));
  }
  if (p.nextVisit) lines.push('Плановая дата сл. визита: ' + escapeHtml_(p.nextVisit));

  var plans = readPlans_().filter(function (pl) {
    return pl.status !== 'выполнен' && samePatient_(pl.patient, pl.phone, p.name, p.phone);
  });
  var rows = [];
  if (plans.length) {
    lines.push('\n<b>Планы лечения</b>');
    plans.forEach(function (pl) {
      lines.push('• ' + escapeHtml_(pl.service) + (pl.comment ? ' — ' + escapeHtml_(pl.comment) : '') +
        (pl.until ? ', до ' + isoToRu_(pl.until) : '') + ' [' + pl.status + ']');
      rows.push([btn_('Выполнен: ' + pl.service.slice(0, 40), 'pl:' + pl.id + ':d')]);
    });
  } else {
    lines.push('\nАктивных планов нет.');
  }
  sendMessage_(chatId, lines.join('\n'), rows.length ? inlineKb_(rows) : null);
}

/** Один и тот же пациент? Совпадение ФИО или последних 10 цифр телефона. */
function samePatient_(name1, phone1, name2, phone2) {
  var d1 = String(phone1 || '').replace(/\D/g, '').slice(-10);
  var d2 = String(phone2 || '').replace(/\D/g, '').slice(-10);
  if (d1.length === 10 && d1 === d2) return true;
  return !!name1 && norm_(name1) === norm_(name2);
}

// ------------------------------------------------------------
// Персонал: план лечения
// ------------------------------------------------------------

/**
 * Все строки листа «Планы» как объекты:
 * { row, id, created, patient, phone, service, comment, until, code, chatId, status, reminded }.
 */
function readPlans_() {
  var sh = getSheet_(PLAN_SHEET);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var range = sh.getRange(2, 1, last - 1, PLAN_HEADERS.length);
  var v = range.getValues();
  var d = range.getDisplayValues();
  var out = [];
  for (var i = 0; i < v.length; i++) {
    if (!String(d[i][7]).trim()) continue; // без кода — не наш план
    out.push({
      row: i + 2, id: String(d[i][0]), created: d[i][1], patient: d[i][2], phone: d[i][3],
      service: d[i][4], comment: d[i][5], until: parseDateISO(v[i][6]) || '',
      code: String(d[i][7]).trim(), chatId: String(d[i][8] || '').trim(),
      status: cleanText_(d[i][9]) || 'активен', reminded: d[i][10],
    });
  }
  return out;
}

function findPlanByCode_(code) {
  code = String(code || '').toUpperCase();
  return readPlans_().filter(function (p) { return p.code.toUpperCase() === code; })[0] || null;
}

/** Записать значение в колонку плана (col — номер колонки 1..11). */
function setPlanCell_(row, col, value) {
  var cell = getSheet_(PLAN_SHEET).getRange(row, col);
  cell.setNumberFormat('@');
  cell.setValue(value);
}

/** Кнопка «Выполнен» в карточке пациента. */
function setPlanStatusById_(id, status) {
  var p = readPlans_().filter(function (x) { return x.id === String(id); })[0];
  if (!p) return 'План не найден.';
  setPlanCell_(p.row, 10, status);
  return 'План: ' + status;
}

/** Текстовые ответы в диалоге «План лечения». */
function planText_(chatId, st, text) {
  if (st.step === 'patient') {
    var found = searchPatients_(text);
    var rows = found.slice(0, 8).map(function (p) { return [btn_(p.name, 'pp:' + p.row)]; });
    rows.push([btn_('Новый пациент', 'pn')]);
    sendMessage_(chatId, found.length ? 'Выберите пациента:' : 'Никого не нашлось. Попробуйте ещё раз или создайте нового.',
      inlineKb_(rows));
    return;
  }
  if (st.step === 'newname') {
    var name = text.slice(0, 120);
    if (name.length < 2) { sendMessage_(chatId, 'Напишите ФИО.'); return; }
    st.patient = name;
    st.step = 'newphone';
    setState_(chatId, st);
    sendMessage_(chatId, 'Телефон пациента? (или «-», если не знаете)');
    return;
  }
  if (st.step === 'newphone') {
    var phone = text === '-' ? '' : text.slice(0, 40);
    if (phone && phone.replace(/\D/g, '').length < 10) {
      sendMessage_(chatId, 'В номере должно быть 10–11 цифр. Или «-», чтобы пропустить.');
      return;
    }
    // Новый пациент сразу попадает в лист «Пациенты»
    adminAdd_('patients', { name: st.patient, phone: phone });
    st.phone = phone;
    st.step = 'service';
    setState_(chatId, st);
    sendServiceGroups_(chatId, 'p', 'Пациент добавлен: <b>' + escapeHtml_(st.patient) + '</b>.\nЧто нужно сделать?');
    return;
  }
  if (st.step === 'service_text') {
    st.service = text.slice(0, 150);
    setState_(chatId, st);
    planAskComment_(chatId, st);
    return;
  }
  if (st.step === 'comment') {
    planComment_(chatId, text.slice(0, 500));
    return;
  }
  sendMessage_(chatId, 'Нажмите одну из кнопок выше или /cancel, чтобы начать заново.');
}

/** Выбран существующий пациент из результатов поиска. */
function planPickPatient_(chatId, row) {
  var st = getState_(chatId);
  if (!st || st.flow !== 'plan') { sendMessage_(chatId, 'Начните заново: «План лечения».'); return; }
  var p = readPatients_().filter(function (x) { return x.row === row; })[0];
  if (!p) { sendMessage_(chatId, 'Пациент не найден.'); return; }
  st.patient = p.name;
  st.phone = p.phone;
  st.step = 'service';
  setState_(chatId, st);
  sendServiceGroups_(chatId, 'p', 'Пациент: <b>' + escapeHtml_(p.name) + '</b>\nЧто нужно сделать?');
}

/**
 * Выбор услуги из «Прайс» (общий для плана — префикс p, и записи — префикс b):
 *   <p>g:<i> — показать услуги направления i;
 *   <p>s:<j> — выбрана услуга j (индекс в getServices_());
 *   <p>o     — «Другое»; <p>G — назад к направлениям.
 */
function sendServiceGroups_(chatId, prefix, title) {
  var groups = serviceGroups_();
  var rows = groups.map(function (g, i) { return [btn_(g, prefix + 'g:' + i)]; });
  rows.push([btn_(prefix === 'p' ? 'Другое (написать)' : 'Не знаю / консультация', prefix + 'o')]);
  sendMessage_(chatId, title, inlineKb_(rows));
}

/** Список направлений прайса по порядку. */
function serviceGroups_() {
  var seen = {}, out = [];
  getServices_().forEach(function (s) { if (!seen[s.group]) { seen[s.group] = true; out.push(s.group); } });
  return out;
}

/** Услуги одного направления — кнопками. */
function sendServicesOfGroup_(chatId, prefix, groupIdx) {
  var groups = serviceGroups_();
  var g = groups[groupIdx];
  var rows = [];
  getServices_().forEach(function (s, j) {
    if (s.group === g) rows.push([btn_(s.name + ' — ' + formatRub_(s.price), prefix + 's:' + j)]);
  });
  rows.push([btn_('← Направления', prefix + 'G')]);
  sendMessage_(chatId, '<b>' + escapeHtml_(g || '') + '</b>', inlineKb_(rows));
}

/** Обработка кнопок выбора услуги в плане. */
function planService_(chatId, cmd, arg) {
  var st = getState_(chatId);
  if (!st || st.flow !== 'plan') { sendMessage_(chatId, 'Начните заново: «План лечения».'); return; }
  if (cmd === 'pG') return sendServiceGroups_(chatId, 'p', 'Что нужно сделать?');
  if (cmd === 'pg') return sendServicesOfGroup_(chatId, 'p', parseInt(arg, 10));
  if (cmd === 'po') {
    st.step = 'service_text';
    setState_(chatId, st);
    sendMessage_(chatId, 'Напишите название услуги.');
    return;
  }
  var s = getServices_()[parseInt(arg, 10)];
  if (!s) { sendMessage_(chatId, 'Услуга не найдена, выберите ещё раз.'); return; }
  st.service = s.name;
  setState_(chatId, st);
  planAskComment_(chatId, st);
}

function planAskComment_(chatId, st) {
  st.step = 'comment';
  setState_(chatId, st);
  sendMessage_(chatId, 'Услуга: <b>' + escapeHtml_(st.service) + '</b>\n' +
    'Комментарий врача (например «кариес 2.6, контактный»):', inlineKb_([[btn_('Без комментария', 'pc')]]));
}

/** Комментарий получен — спрашиваем срок. */
function planComment_(chatId, comment) {
  var st = getState_(chatId);
  if (!st || st.flow !== 'plan') { sendMessage_(chatId, 'Начните заново: «План лечения».'); return; }
  st.comment = comment;
  st.step = 'deadline';
  setState_(chatId, st);
  sendMessage_(chatId, 'Когда желательно сделать?', inlineKb_([
    [btn_('Через 2 недели', 'pd:14'), btn_('Через месяц', 'pd:30')],
    [btn_('Через 3 месяца', 'pd:90'), btn_('Через 6 месяцев', 'pd:180')],
    [btn_('Без срока', 'pd:0')],
  ]));
}

/**
 * Сохраняет план в «Планы» и отдаёт врачу ссылки для пациента.
 * Если chat_id пациента уже известен (по прошлым планам или записям) —
 * бот сразу отправляет план пациенту.
 */
function planSave_(chatId, days) {
  var st = getState_(chatId);
  if (!st || st.flow !== 'plan' || !st.patient || !st.service) {
    sendMessage_(chatId, 'Данные плана потерялись (прошло больше часа?). Начните заново: «План лечения».');
    return;
  }
  var until = days > 0 ? addDaysISO_(todayISO_(), days) : '';
  var patientChat = findPatientChatId_(st.patient, st.phone);
  var plan;

  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var sh = getSheet_(PLAN_SHEET);
    var used = {};
    readPlans_().forEach(function (p) { used[p.code.toUpperCase()] = true; });
    var code;
    do { code = Utilities.getUuid().replace(/-/g, '').slice(0, 6).toUpperCase(); } while (used[code]);
    var id = nextId_(sh, 2);
    var row = [id, Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy HH:mm'), safeCell_(st.patient), safeCell_(st.phone || ''),
      safeCell_(st.service), safeCell_(st.comment || ''), until ? isoToDate_(until) : '', code, patientChat, 'активен', ''];
    writeRow_(sh, sh.getLastRow() + 1, row, ['0', '@', '@', '@', '@', '@', 'dd.MM.yyyy', '@', '@', '@', '@']);
    SpreadsheetApp.flush();
    plan = { id: String(id), patient: st.patient, service: st.service, comment: st.comment || '', until: until, code: code };
  } finally {
    lock.releaseLock();
  }
  clearState_(chatId);

  var bot = getBotUsername_();
  var site = siteUrl_();
  var botLink = bot ? 'https://t.me/' + bot + '?start=plan_' + plan.code : '';
  var siteLink = site ? site + '/booking.html?service=' + encodeURIComponent(plan.service) + '&plan=' + plan.code : '';

  var lines = ['<b>План сохранён</b> (код ' + plan.code + ')', planText2_(plan), ''];
  if (patientChat) {
    sendPlanToPatient_(patientChat, plan);
    lines.push('Пациент уже пользуется ботом — план отправлен ему автоматически.');
  } else {
    lines.push('Перешлите пациенту одну из ссылок:');
  }
  if (botLink) lines.push('Через Telegram: ' + escapeHtml_(botLink));
  if (siteLink) lines.push('Через сайт: ' + escapeHtml_(siteLink));
  if (!site) lines.push('<i>Ссылка на сайт появится, когда задано свойство SITE_URL.</i>');
  sendMessage_(chatId, lines.join('\n'), menuKb_(STAFF_MENU));
}

/** Текст плана: услуга, комментарий, срок. */
function planText2_(p) {
  return 'Врач рекомендует: <b>' + escapeHtml_(p.service) + '</b>' +
    (p.comment ? '.\n' + escapeHtml_(p.comment) : '') +
    (p.until ? '.\nЖелательно до ' + isoToRu_(p.until) : '') + '.';
}

/** Отправить план пациенту с кнопкой «Записаться». */
function sendPlanToPatient_(patientChat, plan) {
  sendMessage_(patientChat, planText2_(plan), inlineKb_([[btn_('Записаться: ' + plan.service.slice(0, 40), 'bk:p:' + plan.code)]]));
}

/** chat_id пациента по прошлым планам или записям (по ФИО или телефону). */
function findPatientChatId_(name, phone) {
  var hit = '';
  readPlans_().forEach(function (p) {
    if (!hit && p.chatId && samePatient_(p.patient, p.phone, name, phone)) hit = p.chatId;
  });
  if (hit) return hit;
  readAppointments_().forEach(function (a) {
    if (!hit && a.chatId && samePatient_(a.name, a.phone, name, phone)) hit = a.chatId;
  });
  return hit;
}

// ------------------------------------------------------------
// Пациент: старт, план, записи, контакты
// ------------------------------------------------------------

/** /start и /start plan_<код>. */
function patientStart_(chatId, from, payload) {
  var first = from && from.first_name ? escapeHtml_(from.first_name) : '';
  sendMessage_(chatId, 'Здравствуйте' + (first ? ', ' + first : '') + '!\n' +
    'Это бот стоматологов Юлии и Тихона. Здесь можно записаться на приём, посмотреть свой план лечения и записи.',
    menuKb_(PATIENT_MENU));

  var m = /^plan_([A-Za-z0-9]+)$/.exec(payload);
  if (!m) return;
  var plan = findPlanByCode_(m[1]);
  if (!plan) { sendMessage_(chatId, 'План по этой ссылке не найден. Напишите врачу, пожалуйста.'); return; }
  if (plan.chatId !== chatId) setPlanCell_(plan.row, 9, chatId); // привязываем пациента к плану
  sendPlanToPatient_(chatId, plan);
}

/** «Мой план лечения». */
function sendPatientPlans_(chatId) {
  var plans = readPlans_().filter(function (p) { return p.chatId === chatId && p.status !== 'выполнен'; });
  if (!plans.length) {
    sendMessage_(chatId, 'Плана лечения пока нет. Если врач прислал вам ссылку — откройте её, и план появится здесь.');
    return;
  }
  plans.forEach(function (p) {
    var kb = p.status === 'активен' ? inlineKb_([[btn_('Записаться', 'bk:p:' + p.code)]]) : null;
    sendMessage_(chatId, planText2_(p) + (p.status === 'записан' ? '\n<i>Вы уже записаны.</i>' : ''), kb);
  });
}

/** «Мои записи»: будущие записи этого chat_id с кнопкой «Отменить». */
function sendPatientAppointments_(chatId) {
  var today = todayISO_();
  var list = readAppointments_().filter(function (a) {
    return a.chatId === chatId && a.date >= today && a.status !== 'отменена';
  }).sort(function (a, b) { return (a.date + a.time) < (b.date + b.time) ? -1 : 1; });
  if (!list.length) {
    sendMessage_(chatId, 'Предстоящих записей нет.', inlineKb_([[btn_('Записаться', 'bk:n')]]));
    return;
  }
  list.forEach(function (a) {
    sendMessage_(chatId, apptText_(a, false) + '\nСтатус: ' + escapeHtml_(a.status),
      inlineKb_([[btn_('Отменить', 'mx:' + a.id)]]));
  });
}

/** Подтверждение отмены пациентом. */
function patientCancelAsk_(chatId, id) {
  var a = findAppointment_(id);
  if (!a || a.chatId !== chatId) { sendMessage_(chatId, 'Запись не найдена.'); return; }
  sendMessage_(chatId, 'Отменить запись?\n' + apptText_(a, false),
    inlineKb_([[btn_('Да, отменить', 'mX:' + a.id), btn_('Нет', 'noop')]]));
}

/** Отмена записи пациентом: статус «отменена» + уведомление персоналу. */
function patientCancel_(chatId, id) {
  var a = findAppointment_(id);
  if (!a || a.chatId !== chatId) return 'Запись не найдена.';
  if (a.status === 'отменена') return 'Запись уже отменена.';
  adminUpdateStatus_(a.id, 'отменена');
  sendMessage_(chatId, 'Запись на ' + fmtDayRu_(a.date) + ', ' + a.time + ' отменена. Будем рады видеть вас в другой день.',
    menuKb_(PATIENT_MENU));
  sendToStaff_('<b>Пациент отменил запись #' + a.id + '</b>\n' + apptText_(a, true));
  return 'Отменено';
}

/** «Буду» в напоминании: статус «подтверждена». */
function patientWillCome_(chatId, id) {
  var a = findAppointment_(id);
  if (!a || a.chatId !== chatId) return 'Запись не найдена.';
  if (a.status === 'отменена') return 'Эта запись отменена.';
  if (a.status === 'новая') adminUpdateStatus_(a.id, 'подтверждена');
  sendMessage_(chatId, 'Спасибо! Ждём вас ' + fmtDayRu_(a.date) + ' в ' + a.time + '.');
  sendToStaff_('Пациент подтвердил, что придёт: #' + a.id + ', ' + fmtDayRu_(a.date) + ' ' + a.time + ', ' + escapeHtml_(a.name));
  return 'Спасибо!';
}

/** «Контакты». */
function sendContacts_(chatId) {
  var site = siteUrl_();
  var links = [];
  if (site) {
    links.push('<a href="' + escapeHtml_(site + '/') + '">Наш сайт</a>');
    links.push('<a href="' + escapeHtml_(site + '/booking.html') + '">Онлайн-запись на сайте</a>');
  }
  links.push('Telegram Юлии: @julia10mdl');
  links.push('Telegram Тихона: @tikhonfedorovsky');
  sendMessage_(chatId, CLINIC_TEXT + '\n\n' + links.join('\n'));
}

// ------------------------------------------------------------
// Пациент: запись через бота
// ------------------------------------------------------------

/**
 * Начало записи. planCode — если пришли из плана (услуга уже выбрана).
 * Шаги: услуга → дата → время → имя → телефон → подтверждение.
 */
function startBooking_(chatId, planCode, from) {
  if (isStaff_(chatId)) {
    sendMessage_(chatId, 'Вы в режиме персонала. Чтобы записаться как пациент, нажмите /logout.');
    return;
  }
  var st = { flow: 'book', step: 'service' };
  // Имя из профиля Telegram — для кнопки «Да, это я»
  if (from) st.tgName = cleanText_([from.first_name, from.last_name].filter(Boolean).join(' ')).slice(0, 80);
  if (planCode) {
    var plan = findPlanByCode_(planCode);
    if (plan) {
      st.service = plan.service;
      st.plan = plan.code;
      if (plan.chatId !== chatId) setPlanCell_(plan.row, 9, chatId);
    }
  }
  setState_(chatId, st);
  if (st.service) {
    sendMessage_(chatId, 'Услуга: <b>' + escapeHtml_(st.service) + '</b>');
    sendFreeDates_(chatId);
  } else {
    sendServiceGroups_(chatId, 'b', 'На какую услугу записать?');
  }
}

/** Кнопки выбора услуги при записи. */
function bookingService_(chatId, cmd, arg) {
  var st = getState_(chatId);
  if (!st || st.flow !== 'book') return bookingExpired_(chatId);
  if (cmd === 'bG') return sendServiceGroups_(chatId, 'b', 'На какую услугу записать?');
  if (cmd === 'bg') return sendServicesOfGroup_(chatId, 'b', parseInt(arg, 10));
  if (cmd === 'bo') {
    st.service = 'Консультация';
  } else {
    var s = getServices_()[parseInt(arg, 10)];
    if (!s) { sendMessage_(chatId, 'Услуга не найдена, выберите ещё раз.'); return; }
    st.service = s.name;
  }
  st.step = 'date';
  setState_(chatId, st);
  sendMessage_(chatId, 'Услуга: <b>' + escapeHtml_(st.service) + '</b>');
  sendFreeDates_(chatId);
}

/** Даты, где есть свободные окна (та же логика, что slots на сайте). */
function sendFreeDates_(chatId) {
  var slots = getFreeSlots_('', todayISO_(), BOT_DAYS);
  var dates = [];
  slots.forEach(function (s) { if (dates.indexOf(s.date) === -1) dates.push(s.date); });
  if (!dates.length) {
    clearState_(chatId);
    sendMessage_(chatId, 'Свободного времени на ближайшие ' + BOT_DAYS + ' дней пока нет. ' +
      'Загляните позже или напишите врачу напрямую.', menuKb_(PATIENT_MENU));
    sendContacts_(chatId);
    return;
  }
  var rows = [];
  for (var i = 0; i < dates.length; i += 3) {
    rows.push(dates.slice(i, i + 3).map(function (d) { return btn_(fmtDayShort_(d), 'bd:' + isoToCompact_(d)); }));
  }
  sendMessage_(chatId, 'Выберите день:', inlineKb_(rows));
}

/** Выбрана дата — показываем свободное время. */
function bookingDate_(chatId, iso) {
  var st = getState_(chatId);
  if (!st || st.flow !== 'book') return bookingExpired_(chatId);
  var times = getFreeSlots_('', iso, 1).map(function (s) { return s.time; });
  if (!times.length) {
    sendMessage_(chatId, 'На этот день свободное время закончилось.');
    sendFreeDates_(chatId);
    return;
  }
  st.date = iso;
  st.step = 'time';
  setState_(chatId, st);
  var rows = [];
  for (var i = 0; i < times.length; i += 4) {
    rows.push(times.slice(i, i + 4).map(function (t) { return btn_(t, 'bt:' + t.replace(':', '')); }));
  }
  sendMessage_(chatId, '<b>' + fmtDayRu_(iso) + '</b>. Выберите время:', inlineKb_(rows));
}

/** Выбрано время — спрашиваем имя (предлагаем имя из Telegram). */
function bookingTime_(chatId, hhmm) {
  var st = getState_(chatId);
  if (!st || st.flow !== 'book' || !st.date) return bookingExpired_(chatId);
  st.time = String(hhmm).slice(0, 2) + ':' + String(hhmm).slice(2, 4);
  st.step = 'name';
  setState_(chatId, st);
  var tgName = st.tgName || '';
  sendMessage_(chatId, 'Как вас записать? Напишите имя и фамилию' +
    (tgName ? ' или подтвердите: <b>' + escapeHtml_(tgName) + '</b>' : '') + '.',
    tgName ? inlineKb_([[btn_('Да, это я', 'bn')]]) : null);
}

/** «Да, это я» — берём имя из Telegram. */
function bookingNameYes_(chatId) {
  var st = getState_(chatId);
  if (!st || st.flow !== 'book' || !st.tgName) return bookingExpired_(chatId);
  st.name = st.tgName;
  bookingAskPhone_(chatId, st);
}

function bookingAskPhone_(chatId, st) {
  st.step = 'phone';
  setState_(chatId, st);
  sendMessage_(chatId, 'Ваш телефон? Нажмите кнопку ниже или напишите номер.', {
    keyboard: [[{ text: 'Отправить мой номер', request_contact: true }], [{ text: 'Отмена' }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  });
}

/**
 * Текст/контакт в диалоге записи (имя, телефон).
 * Имя из Telegram запоминаем в состоянии при первом сообщении.
 */
function bookingText_(chatId, st, m) {
  if (st.step === 'name') {
    var name = cleanText_(m.text).slice(0, 80);
    if (name.length < 2) { sendMessage_(chatId, 'Напишите, пожалуйста, имя.'); return; }
    st.name = name;
    bookingAskPhone_(chatId, st);
    return;
  }
  if (st.step === 'phone') {
    var phone = m.contact ? String(m.contact.phone_number || '') : cleanText_(m.text);
    var digits = phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 11) {
      sendMessage_(chatId, 'Похоже, в номере ошибка: нужно 10–11 цифр. Попробуйте ещё раз.');
      return;
    }
    if (m.contact && phone.charAt(0) !== '+' && digits.length === 11) phone = '+' + digits;
    st.phone = phone;
    st.step = 'confirm';
    if (m.from && m.from.username) st.username = '@' + m.from.username;
    setState_(chatId, st);
    sendMessage_(chatId, 'Почти готово.', menuKb_(PATIENT_MENU)); // убираем кнопку «Отправить номер»
    sendMessage_(chatId, '<b>Проверьте запись</b>\n' +
      fmtDayRu_(st.date) + ', ' + st.time + '\n' +
      'Услуга: ' + escapeHtml_(st.service) + '\n' +
      'Имя: ' + escapeHtml_(st.name) + '\n' +
      'Телефон: ' + escapeHtml_(st.phone) + '\n\n' + CLINIC_TEXT,
      inlineKb_([[btn_('Записаться', 'bc:y'), btn_('Отмена', 'bc:n')]]));
    return;
  }
  sendMessage_(chatId, 'Нажмите одну из кнопок выше или /cancel, чтобы начать заново.');
}

/** Финальная кнопка «Записаться» — запись через общую createBooking_. */
function bookingConfirm_(chatId, yes, from) {
  var st = getState_(chatId);
  if (!yes) {
    clearState_(chatId);
    sendMessage_(chatId, 'Запись отменена. Можно начать заново в любой момент.', menuKb_(PATIENT_MENU));
    return '';
  }
  if (!st || st.flow !== 'book' || st.step !== 'confirm') { bookingExpired_(chatId); return ''; }
  var rec;
  try {
    rec = createBooking_({
      doctor: '', date: st.date, time: st.time, service: st.service, name: st.name, phone: st.phone,
      telegram: st.username || (from && from.username ? '@' + from.username : ''),
      comment: 'через Telegram-бота' + (st.plan ? ', план ' + st.plan : ''),
      chatId: chatId,
    });
  } catch (e) {
    if (e.apiCode === 'slot_taken') {
      st.step = 'date';
      setState_(chatId, st);
      sendMessage_(chatId, escapeHtml_(e.message));
      sendFreeDates_(chatId);
      return 'Время занято';
    }
    throw e;
  }
  clearState_(chatId);
  if (st.plan) {
    var plan = findPlanByCode_(st.plan);
    if (plan) setPlanCell_(plan.row, 10, 'записан');
  }
  sendMessage_(chatId, '<b>Вы записаны!</b>\n' + fmtDayRu_(rec.date) + ', ' + rec.time + '\n' +
    'Услуга: ' + escapeHtml_(rec.service) + '\n\n' + CLINIC_TEXT +
    '\n\nНакануне пришлём напоминание. Отменить запись можно в разделе «Мои записи».', menuKb_(PATIENT_MENU));
  return 'Готово';
}

/** Состояние записи потерялось (прошёл час) — начинаем заново. */
function bookingExpired_(chatId) {
  clearState_(chatId);
  sendMessage_(chatId, 'Время на запись истекло. Нажмите «Записаться», чтобы начать заново.', menuKb_(PATIENT_MENU));
}

// ------------------------------------------------------------
// Напоминания (раз в день по триггеру)
// ------------------------------------------------------------

/**
 * Запускается каждый день около 12:00 (installTriggers).
 * 1) Пациентам из бота — напоминание о записи на завтра («Буду» / «Отменить»).
 * 2) По «Планам» (статус «активен», срок через ≤ 7 дней, ещё не напоминали) —
 *    «Не забудьте: врач рекомендовал …» + «Записаться».
 * 3) Персоналу — сводка записей на завтра.
 */
function dailyReminders() {
  var today = todayISO_();
  var tomorrow = addDaysISO_(today, 1);

  // 1 и 3: записи на завтра
  var list = readAppointments_().filter(function (a) { return a.date === tomorrow && a.status !== 'отменена'; })
    .sort(function (a, b) { return a.time < b.time ? -1 : 1; });
  list.forEach(function (a) {
    if (!a.chatId) return;
    sendMessage_(a.chatId, 'Напоминаем: завтра у вас приём.\n' + apptText_(a, false) + '\n\n' + CLINIC_TEXT,
      inlineKb_([[btn_('Буду', 'rm:' + a.id), btn_('Отменить', 'mx:' + a.id)]]));
  });
  if (list.length) {
    sendToStaff_('<b>Завтра, ' + fmtDayRu_(tomorrow) + '</b> — ' + list.length + ' ' +
      plural_(list.length, 'запись', 'записи', 'записей') + ':\n' + list.map(function (a) {
        return a.time + ' — ' + escapeHtml_(a.name) + (a.service ? ', ' + escapeHtml_(a.service) : '') +
          ' [' + escapeHtml_(a.status) + ']';
      }).join('\n'));
  }

  // 2: планы лечения
  var limit = addDaysISO_(today, 7);
  readPlans_().forEach(function (p) {
    if (p.status !== 'активен' || !p.chatId || !p.until || p.reminded) return;
    if (p.until > limit) return;
    sendMessage_(p.chatId, 'Не забудьте: врач рекомендовал <b>' + escapeHtml_(p.service) + '</b>' +
      (p.comment ? ' (' + escapeHtml_(p.comment) + ')' : '') + ', желательно до ' + isoToRu_(p.until) + '.',
      inlineKb_([[btn_('Записаться', 'bk:p:' + p.code)]]));
    setPlanCell_(p.row, 11, Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy'));
  });
}

// ------------------------------------------------------------
// Даты и мелочи
// ------------------------------------------------------------

/** День недели 0–6 (0 — воскресенье) для «yyyy-MM-dd». */
function weekday_(iso) {
  var p = iso.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
}

/** «2026-11-08» → «сб, 8 ноября». */
function fmtDayRu_(iso) {
  return WD_SHORT[weekday_(iso)] + ', ' + dayMonth_(iso);
}

/** «2026-11-08» → «8 ноября». */
function dayMonth_(iso) {
  return +iso.slice(8, 10) + ' ' + MONTHS_GEN[+iso.slice(5, 7) - 1];
}

/** «2026-11-08» → «сб 8.11» (коротко, для кнопок). */
function fmtDayShort_(iso) {
  return WD_SHORT[weekday_(iso)] + ' ' + +iso.slice(8, 10) + '.' + iso.slice(5, 7);
}

/** «2026-11-08» ↔ «20261108» (короткие данные для кнопок). */
function isoToCompact_(iso) { return iso.replace(/-/g, ''); }
function compactToIso_(c) {
  c = String(c || '');
  return /^\d{8}$/.test(c) ? c.slice(0, 4) + '-' + c.slice(4, 6) + '-' + c.slice(6, 8) : null;
}

/** «15:00» + 60 → «16:00». */
function addMinutes_(hhmm, min) {
  var t = +hhmm.slice(0, 2) * 60 + +hhmm.slice(3, 5) + min;
  return pad2_(Math.floor(t / 60) % 24) + ':' + pad2_(t % 60);
}

/** 5000 → «5 000 ₽». */
function formatRub_(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽';
}

/** Склонение: 1 окно, 2 окна, 5 окон. */
function plural_(n, one, few, many) {
  var a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
