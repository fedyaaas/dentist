// ============================================================
// Страница онлайн-записи (booking.html).
//
// Как это работает, коротко:
//   Юлия и Тихон всегда принимают вместе, поэтому врача выбирать не нужно.
//   1. Пациент выбирает услугу из списка (список берётся из листа «Прайс»).
//   2–3. Мы загружаем СВОБОДНЫЕ слоты общего расписания команды через
//      api.getSlots('') и рисуем ленту дней и сетку времени.
//   4. Пациент заполняет контакты и жмёт «Записаться».
//   Отправляем всё через api.book() и показываем экран «Вы записаны!».
//
// Важное правило безопасности: всё, что видно на странице, вставляем
// через textContent (а не innerHTML), чтобы никакой текст не мог
// превратиться в HTML-код.
//
// Файл подключается с defer после js/config.js и js/api.js,
// поэтому CONFIG, DOCTORS и api здесь уже доступны.
// ============================================================

(function () {
  'use strict';

  // ---------- Постоянные значения ----------

  // Кто принимает — показываем в сводке и на экране успеха
  const TEAM_TEXT = 'Принимают: Юлия и Тихон';

  // Ключ врача для API: пустая строка = общее расписание команды
  const TEAM_DOCTOR = '';

  // Особое значение услуги «Не знаю, нужна консультация»
  const CONSULT = 'Не знаю, нужна консультация';

  // Адрес клиники — нужен для файла календаря
  const CLINIC_ADDRESS = 'Клиника «Баланс Дент», Москва, ул. Сивашская, 7, корп. 1 (м. Нахимовский проспект)';

  // Длительность приёма для календаря, минут
  const VISIT_MINUTES = 60;

  // Личные Telegram врачей (из config.js) — показываем при ошибках
  const TELEGRAM_LINKS = DOCTORS.map((d) => ({ name: d.name, url: d.telegram }));

  // ---------- Параметры из ссылки врача ----------
  // Врач может прислать пациенту ссылку booking.html?service=<услуга>&plan=<код>.
  // Берём их из адресной строки, обрезаем пробелы и ограничиваем длину.
  const urlParams = new URLSearchParams(window.location.search);
  const URL_SERVICE = (urlParams.get('service') || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const URL_PLAN = (urlParams.get('plan') || '').trim().slice(0, 64);

  // Сравнение названий без учёта регистра и лишних пробелов
  function sameName(a, b) {
    const norm = (x) => String(x).replace(/\s+/g, ' ').trim().toLowerCase();
    return norm(a) === norm(b);
  }

  // ---------- Состояние страницы ----------
  // Всё, что выбрал пациент, храним в одном объекте.
  const state = {
    service: '',    // название услуги
    date: null,     // выбранная дата, строка '2026-11-02'
    slot: null,     // выбранный слот { date, time }
    slots: [],      // свободные слоты общего расписания
    loading: false, // идёт ли загрузка слотов
    sending: false, // идёт ли отправка записи
  };

  // Кэш слотов: обещание (Promise) со списком слотов. Расписание грузим
  // один раз; заново — только после ошибки или если время «заняли».
  let slotsCache = null;

  // Номер последней загрузки. Если началась новая загрузка (например,
  // после «Повторить»), результат старой мы просто проигнорируем.
  let loadToken = 0;

  // ---------- Ссылки на элементы страницы ----------
  const el = {
    serviceSelect: document.getElementById('service-select'),
    dateList: document.getElementById('date-list'),
    timeList: document.getElementById('time-list'),
    timeNotice: document.getElementById('time-notice'),
    stepTime: document.getElementById('step-time'),
    form: document.getElementById('contact-form'),
    name: document.getElementById('f-name'),
    phone: document.getElementById('f-phone'),
    telegram: document.getElementById('f-telegram'),
    comment: document.getElementById('f-comment'),
    website: document.getElementById('f-website'),
    consent: document.getElementById('f-consent'),
    demoBadge: document.getElementById('demo-badge'),
    sumService: document.getElementById('sum-service'),
    sumDatetime: document.getElementById('sum-datetime'),
    sumShort: document.getElementById('sum-short'),
    submitBtn: document.getElementById('submit-btn'),
    submitHint: document.getElementById('submit-hint'),
    submitError: document.getElementById('submit-error'),
    bookingScreen: document.getElementById('booking-screen'),
    successScreen: document.getElementById('success-screen'),
    successTitle: document.getElementById('success-title'),
    successWhen: document.getElementById('success-when'),
    successService: document.getElementById('success-service'),
    successDemo: document.getElementById('success-demo'),
    icsBtn: document.getElementById('ics-btn'),
  };

  // ============================================================
  // Вспомогательные функции
  // ============================================================

  // Создать элемент с классом и (необязательно) текстом.
  // Текст кладём через textContent — это безопасно.
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // Строка '2026-11-02' → объект Date (в местном времени, полночь)
  function parseISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  // Форматтеры дат на русском (Intl встроен в браузер)
  const fmtWeekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
  const fmtDay = new Intl.DateTimeFormat('ru-RU', { day: 'numeric' });
  const fmtMonth = new Intl.DateTimeFormat('ru-RU', { month: 'short' });
  const fmtLong = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });

  // '2026-11-02' → 'понедельник, 2 ноября'
  function longDate(iso) {
    return fmtLong.format(parseISO(iso));
  }

  // Список дат на CONFIG.BOOKING_DAYS дней вперёд, начиная с сегодня
  function bookingDates() {
    const out = [];
    const today = new Date();
    for (let i = 0; i < CONFIG.BOOKING_DAYS; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      out.push(api.toISODate(d));
    }
    return out;
  }

  // Убираем слоты, время которых сегодня уже прошло
  function dropPastSlots(slots) {
    const now = new Date();
    const todayISO = api.toISODate(now);
    const pad = (n) => String(n).padStart(2, '0');
    const nowTime = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    return slots.filter((s) => s.date > todayISO || (s.date === todayISO && s.time > nowTime));
  }

  // Уникальный ключ слота — чтобы сравнивать «тот же ли это слот»
  function slotKey(s) {
    return `${s.date}|${s.time}`;
  }

  // Блок со ссылками на Telegram врачей (для сообщений об ошибках)
  function telegramLinks() {
    const p = make('p', 'notice__links');
    p.append('Или напишите врачу в Telegram: ');
    TELEGRAM_LINKS.forEach((t, i) => {
      if (i > 0) p.append(', ');
      const a = make('a', '', t.name);
      a.href = t.url;
      a.target = '_blank';
      a.rel = 'noopener';
      p.append(a);
    });
    p.append('.');
    return p;
  }

  // Очистить элемент (удалить всё содержимое)
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ============================================================
  // Шаг 1. Услуги
  // ============================================================

  // Загрузить услуги и собрать <select> с группами <optgroup>
  async function renderServices() {
    let services = [];
    try {
      services = await api.getServices(); // при ошибке api.js сам вернёт запасной прайс
    } catch (e) {
      services = FALLBACK_SERVICES;
    }
    if (!Array.isArray(services) || !services.length) services = FALLBACK_SERVICES;

    // Группируем: { 'Лечение кариеса': [услуги...], ... } (порядок групп сохраняем)
    const groups = new Map();
    services.forEach((s) => {
      const g = s.group || 'Другое';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    });

    // Группа с профессиональной гигиеной должна идти первой
    const isHygiene = (s) => /гигиен/i.test(s.name);
    const hygieneGroup = [...groups.keys()].find((g) => groups.get(g).some(isHygiene));

    clear(el.serviceSelect);

    // Добавить одну группу в список
    function addGroup(name, items) {
      const og = document.createElement('optgroup');
      og.label = name;
      // Внутри группы гигиены сама «Профессиональная гигиена» — первой
      items.slice().sort((a, b) => Number(isHygiene(b)) - Number(isHygiene(a))).forEach((s) => {
        const opt = make('option', '', s.name) // только название, без цены;
        opt.value = s.name;
        og.append(opt);
      });
      el.serviceSelect.append(og);
    }

    if (hygieneGroup) addGroup(hygieneGroup, groups.get(hygieneGroup));

    // Вариант для тех, кто не знает, что им нужно
    const consult = make('option', '', CONSULT);
    consult.value = CONSULT;
    el.serviceSelect.append(consult);

    groups.forEach((items, name) => {
      if (name !== hygieneGroup) addGroup(name, items);
    });

    // По умолчанию выбран первый пункт — профессиональная гигиена
    el.serviceSelect.selectedIndex = 0;

    // Если в ссылке есть ?service= — выбираем эту услугу
    if (URL_SERVICE) {
      const match = [...el.serviceSelect.options].find((o) => sameName(o.value, URL_SERVICE));
      if (match) {
        match.selected = true;
      } else {
        // Такой услуги в прайсе нет — добавляем её первым пунктом (текст через textContent)
        const custom = make('option', '', URL_SERVICE);
        custom.value = URL_SERVICE;
        el.serviceSelect.insertBefore(custom, el.serviceSelect.firstChild);
        custom.selected = true;
      }
    }
    el.serviceSelect.disabled = false;
    state.service = el.serviceSelect.value;
    showPlanBadge();
    updateSummary();
  }

  // Плашка «Врач рекомендовал: …» — только если в ссылке есть ?plan=
  function showPlanBadge() {
    if (!URL_PLAN) return;
    const badge = document.getElementById('plan-badge');
    const recommended = URL_SERVICE ? el.serviceSelect.value : '';
    badge.textContent = recommended ? `Врач рекомендовал: ${recommended}` : 'Врач подготовил для вас план лечения';
    badge.hidden = false;
  }

  // ============================================================
  // Шаги 2 и 3. Загрузка слотов, лента дней, сетка времени
  // ============================================================

  // Слоты общего расписания — из кэша или из таблицы
  function getTeamSlots() {
    if (!slotsCache) {
      slotsCache = api.getSlots(TEAM_DOCTOR).catch((err) => {
        slotsCache = null; // ошибку не кэшируем — «Повторить» загрузит заново
        throw err;
      });
    }
    return slotsCache;
  }

  // Загрузить слоты и нарисовать ленту дней и сетку времени
  async function loadSlots() {
    const token = ++loadToken;
    state.loading = true;
    renderSkeleton();

    try {
      const list = await getTeamSlots();
      if (token !== loadToken) return; // уже началась более новая загрузка

      // Убираем прошедшее время и сортируем по дате, потом по времени
      state.slots = dropPastSlots(Array.isArray(list) ? list : [])
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      state.loading = false;

      // Если выбранная раньше дата всё ещё доступна — оставляем её,
      // иначе берём первый день, где есть свободное время
      const daysWithSlots = new Set(state.slots.map((s) => s.date));
      if (!state.date || !daysWithSlots.has(state.date)) {
        state.date = state.slots.length ? state.slots[0].date : null;
      }
      renderDates();
      renderTimes();
    } catch (err) {
      if (token !== loadToken) return;
      state.loading = false;
      console.warn('Не удалось загрузить слоты', err);
      renderSlotsError();
    }
    updateSummary();
  }

  // Пока грузится — серые «скелетоны» вместо дней и времени
  function renderSkeleton() {
    clear(el.dateList);
    clear(el.timeList);
    el.dateList.setAttribute('aria-busy', 'true');
    el.timeList.setAttribute('aria-busy', 'true');
    for (let i = 0; i < 7; i++) el.dateList.append(make('span', 'skeleton skeleton--day'));
    for (let i = 0; i < 8; i++) el.timeList.append(make('span', 'skeleton skeleton--time'));
    el.timeList.append(make('span', 'booking-sr-only', 'Загружаем свободное время…'));
  }

  // Ошибка загрузки — сообщение, кнопка «Повторить» и ссылки на Telegram
  function renderSlotsError() {
    clear(el.dateList);
    clear(el.timeList);
    el.dateList.removeAttribute('aria-busy');
    el.timeList.removeAttribute('aria-busy');
    el.dateList.append(make('p', 'step__placeholder', 'Расписание не загрузилось.'));

    const box = make('div', 'notice notice--error');
    box.setAttribute('role', 'alert');
    box.append(make('p', '', 'Не получилось загрузить свободное время. Проверьте интернет и попробуйте ещё раз.'));
    const retry = make('button', 'btn btn--ghost notice__btn', 'Повторить');
    retry.type = 'button';
    retry.addEventListener('click', loadSlots);
    box.append(retry, telegramLinks());
    el.timeList.append(box);
  }

  // Лента дней: кнопка на каждый день, дни без слотов — неактивные
  function renderDates() {
    clear(el.dateList);
    el.dateList.removeAttribute('aria-busy');
    const daysWithSlots = new Set(state.slots.map((s) => s.date));

    bookingDates().forEach((iso) => {
      const d = parseISO(iso);
      const has = daysWithSlots.has(iso);
      const btn = make('button', 'date-pick');
      btn.type = 'button';
      btn.dataset.date = iso;
      btn.disabled = !has;
      btn.setAttribute('aria-pressed', String(iso === state.date));
      // Полная подпись для читалки: «понедельник, 2 ноября» (+ «нет свободного времени»)
      btn.setAttribute('aria-label', longDate(iso) + (has ? '' : ', нет свободного времени'));

      btn.append(
        make('span', 'date-pick__wd', fmtWeekday.format(d)),
        make('span', 'date-pick__day', fmtDay.format(d)),
        make('span', 'date-pick__month', fmtMonth.format(d).replace('.', ''))
      );
      btn.addEventListener('click', () => selectDate(iso));
      el.dateList.append(btn);
    });

    // Прокручиваем ленту так, чтобы выбранный день был виден
    const active = el.dateList.querySelector('[aria-pressed="true"]');
    if (active && active.scrollIntoView) {
      el.dateList.scrollLeft = Math.max(0, active.offsetLeft - el.dateList.offsetLeft - 8);
    }
  }

  // Пациент выбрал день
  function selectDate(iso) {
    state.date = iso;
    // Если выбранное время было в другом дне — сбрасываем его
    if (state.slot && state.slot.date !== iso) state.slot = null;
    el.dateList.querySelectorAll('.date-pick').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.date === iso));
    });
    renderTimes();
    updateSummary();
  }

  // Сетка кнопок времени для выбранного дня
  function renderTimes() {
    clear(el.timeList);
    el.timeList.removeAttribute('aria-busy');

    if (!state.slots.length) {
      // Свободного времени нет совсем
      const box = make('div', 'notice');
      box.append(make('p', '', `В ближайшие ${CONFIG.BOOKING_DAYS} дней свободного времени нет.`));
      box.append(telegramLinks());
      el.timeList.append(box);
      return;
    }

    const daySlots = state.slots.filter((s) => s.date === state.date);

    daySlots.forEach((s) => {
      const btn = make('button', 'time-pick');
      btn.type = 'button';
      btn.dataset.key = slotKey(s);
      btn.setAttribute('aria-pressed', String(!!state.slot && slotKey(state.slot) === slotKey(s)));
      btn.append(make('span', 'time-pick__time', s.time));
      btn.addEventListener('click', () => selectSlot(s));
      el.timeList.append(btn);
    });
  }

  // Пациент выбрал время
  function selectSlot(slot) {
    state.slot = slot;
    hideTimeNotice();
    el.timeList.querySelectorAll('.time-pick').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.key === slotKey(slot)));
    });
    updateSummary();
  }

  // Сообщение над сеткой времени (например, «время заняли»)
  function showTimeNotice(text) {
    el.timeNotice.textContent = text;
    el.timeNotice.hidden = false;
  }
  function hideTimeNotice() {
    el.timeNotice.hidden = true;
    el.timeNotice.textContent = '';
  }

  // ============================================================
  // Сводка справа и кнопка «Записаться»
  // ============================================================

  function updateSummary() {
    el.sumService.textContent = state.service || 'не выбрана';

    el.sumDatetime.textContent = state.slot
      ? `${longDate(state.slot.date)}, ${state.slot.time}`
      : 'не выбраны';

    // Короткая строка для мобильной панели
    el.sumShort.textContent = state.slot
      ? `${fmtDay.format(parseISO(state.slot.date))} ${fmtMonth.format(parseISO(state.slot.date)).replace('.', '')}, ${state.slot.time}`
      : 'Выберите услугу, дату и время';

    // Чего ещё не хватает — подсказка под кнопкой
    const missing = [];
    if (!state.service) missing.push('услугу');
    if (!state.slot) missing.push(state.date ? 'время' : 'дату и время');

    const ready = missing.length === 0;
    el.submitBtn.disabled = !ready || state.sending;
    el.submitHint.textContent = ready
      ? 'Осталось заполнить контакты'
      : 'Выберите ' + missing.join(', ');
  }

  // ============================================================
  // Шаг 5. Проверка формы
  // ============================================================

  // Оставляем только цифры телефона и приводим к виду 7XXXXXXXXXX.
  // Принимаем: +7XXXXXXXXXX, 8XXXXXXXXXX и просто 10 цифр (9XXXXXXXXX).
  // Возвращает null, если номер не похож на российский.
  function normalizePhone(raw) {
    const digits = String(raw).replace(/\D/g, '');
    if (digits.length === 11 && (digits[0] === '7' || digits[0] === '8')) return '7' + digits.slice(1);
    if (digits.length === 10) return '7' + digits;
    return null;
  }

  // 79001234567 → '+7 900 123-45-67'
  function formatPhone(norm) {
    return `+7 ${norm.slice(1, 4)} ${norm.slice(4, 7)}-${norm.slice(7, 9)}-${norm.slice(9, 11)}`;
  }

  // Telegram: '@username', 'username' или ссылка 't.me/username' → '@username'
  function normalizeTelegram(raw) {
    let v = String(raw).trim();
    if (!v) return '';
    v = v.replace(/^https?:\/\//i, '').replace(/^(t\.me|telegram\.me)\//i, '').replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(v)) return null;
    return '@' + v;
  }

  // Показать/убрать ошибку у поля. Текст ошибки лежит в <p id="...-error">,
  // который уже связан с полем через aria-describedby.
  function setError(input, message) {
    const box = document.getElementById(input.id + '-error');
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      box.textContent = message;
    } else {
      input.removeAttribute('aria-invalid');
      box.textContent = '';
    }
  }

  // Проверка одного поля. Возвращает true, если всё хорошо.
  function validateField(input) {
    if (input === el.name) {
      const v = el.name.value.trim();
      if (!v) { setError(el.name, 'Введите имя'); return false; }
      if (v.length < 2) { setError(el.name, 'Имя слишком короткое'); return false; }
      setError(el.name, ''); return true;
    }
    if (input === el.phone) {
      const v = el.phone.value.trim();
      if (!v) { setError(el.phone, 'Введите телефон'); return false; }
      if (!normalizePhone(v)) { setError(el.phone, 'Проверьте номер: нужен российский, +7 или 8 и 10 цифр'); return false; }
      setError(el.phone, ''); return true;
    }
    if (input === el.telegram) {
      if (normalizeTelegram(el.telegram.value) === null) {
        setError(el.telegram, 'Ник в Telegram — латиница, цифры и _, от 5 символов, например @ivan_petrov');
        return false;
      }
      setError(el.telegram, ''); return true;
    }
    if (input === el.consent) {
      if (!el.consent.checked) { setError(el.consent, 'Без согласия мы не сможем записать вас на приём'); return false; }
      setError(el.consent, ''); return true;
    }
    return true;
  }

  // Проверить всю форму; при ошибке — перевести фокус на первое неверное поле
  function validateForm() {
    const fields = [el.name, el.phone, el.telegram, el.consent];
    let firstBad = null;
    fields.forEach((f) => {
      if (!validateField(f) && !firstBad) firstBad = f;
    });
    if (firstBad) firstBad.focus();
    return !firstBad;
  }

  // Маска телефона: пока человек печатает, оставляем только цифры, +, пробелы,
  // скобки и дефисы; когда уходит с поля — красиво форматируем номер.
  function setupPhoneMask() {
    el.phone.addEventListener('input', () => {
      const cleaned = el.phone.value.replace(/[^\d+\-() ]/g, '');
      if (cleaned !== el.phone.value) el.phone.value = cleaned;
      // Если ошибка уже показана — убираем её, как только номер стал верным
      if (el.phone.getAttribute('aria-invalid') === 'true') validateField(el.phone);
    });
    el.phone.addEventListener('blur', () => {
      const norm = normalizePhone(el.phone.value);
      if (norm) el.phone.value = formatPhone(norm);
      if (el.phone.value.trim()) validateField(el.phone);
    });
  }

  // Проверяем поля, когда пользователь из них уходит (а не на каждое нажатие)
  function setupLiveValidation() {
    [el.name, el.telegram].forEach((f) => {
      f.addEventListener('blur', () => { if (f.value.trim()) validateField(f); });
      f.addEventListener('input', () => { if (f.getAttribute('aria-invalid') === 'true') validateField(f); });
    });
    el.consent.addEventListener('change', () => validateField(el.consent));
  }

  // ============================================================
  // Отправка записи
  // ============================================================

  async function onSubmit(event) {
    event.preventDefault(); // не перезагружаем страницу
    if (state.sending) return;
    hideSubmitError();

    // Сначала убедимся, что услуга и время выбраны
    if (!state.service || !state.slot) {
      updateSummary();
      return;
    }
    if (!validateForm()) return;

    const slot = state.slot;
    const booking = {
      doctor: TEAM_DOCTOR, // врачи принимают вместе — врача не указываем
      date: slot.date,
      time: slot.time,
      service: state.service,
      name: el.name.value.trim(),
      phone: '+' + normalizePhone(el.phone.value),
      telegram: normalizeTelegram(el.telegram.value) || '',
      comment: el.comment.value.trim(),
      website: el.website.value, // ловушка для ботов, у людей всегда пусто
    };
    // Код плана лечения из ссылки врача — бэкенд пометит план «записан»
    if (URL_PLAN) booking.plan = URL_PLAN;

    // Кнопка в режиме «Отправляем…»
    state.sending = true;
    el.submitBtn.disabled = true;
    el.submitBtn.textContent = 'Отправляем…';
    el.submitBtn.setAttribute('aria-busy', 'true');

    try {
      const result = await api.book(booking);
      // Сервер возвращает { date, time, doctor }; берём дату и время, если чего-то нет — своё
      showSuccess({
        date: (result && result.date) || booking.date,
        time: (result && result.time) || booking.time,
        service: booking.service,
      });
    } catch (err) {
      if (err && err.code === 'slot_taken') {
        handleSlotTaken(slot);
      } else {
        showSubmitError(err);
      }
    } finally {
      state.sending = false;
      el.submitBtn.textContent = 'Записаться';
      el.submitBtn.removeAttribute('aria-busy');
      updateSummary();
    }
  }

  // Время только что занял кто-то другой: перезагружаем слоты и просим выбрать снова
  function handleSlotTaken(slot) {
    slotsCache = null;                          // кэш расписания устарел
    state.slot = null;
    state.date = slot.date;                     // постараемся остаться в том же дне
    loadSlots();
    showTimeNotice('Это время только что заняли, выберите другое');
    // Возвращаем пациента к выбору времени
    el.stepTime.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el.stepTime.focus({ preventScroll: true });
  }

  // Прочие ошибки: общее сообщение + ссылки на Telegram
  function showSubmitError(err) {
    console.warn('Ошибка записи', err);
    clear(el.submitError);
    const text = err && err.code === 'bad_input'
      ? 'Проверьте, пожалуйста, данные в форме и попробуйте ещё раз.'
      : 'Не удалось отправить запись. Попробуйте ещё раз через минуту.';
    el.submitError.append(make('p', '', text));
    el.submitError.append(telegramLinks());
    el.submitError.hidden = false;
  }
  function hideSubmitError() {
    el.submitError.hidden = true;
    clear(el.submitError);
  }

  // ============================================================
  // Экран «Вы записаны!»
  // ============================================================

  let lastBooking = null; // запомним запись для файла календаря

  function showSuccess(b) {
    lastBooking = b;
    el.successWhen.textContent = `${longDate(b.date)}, ${b.time}`;
    el.successService.textContent = `Услуга: ${b.service}`;
    el.successDemo.hidden = !api.isDemo();
    el.bookingScreen.hidden = true;
    document.querySelector('.booking-intro').hidden = true;
    el.successScreen.hidden = false;
    // Переводим фокус на заголовок — читалка сразу озвучит «Вы записаны!»
    window.scrollTo({ top: 0, behavior: 'smooth' });
    el.successTitle.focus({ preventScroll: true });
  }

  // ============================================================
  // Файл календаря (.ics)
  // ============================================================

  // В тексте .ics запятые, точки с запятой и переносы строк надо экранировать
  function icsEscape(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  }

  // Дата+время по Москве → строка UTC вида 20261102T120000Z.
  // В Москве круглый год UTC+3 (без перехода на летнее время),
  // поэтому просто вычитаем 3 часа.
  function moscowToUTC(dateISO, time, plusMinutes) {
    const [y, m, d] = dateISO.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const ms = Date.UTC(y, m - 1, d, hh - 3, mm + (plusMinutes || 0));
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  // Собрать текст файла календаря
  function buildICS(b) {
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const uid = `${b.date}-${b.time.replace(':', '')}-${Date.now()}@julia-tikhon-dent`;
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Yulia and Tikhon//Booking//RU',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + uid,
      'DTSTAMP:' + now,
      'DTSTART:' + moscowToUTC(b.date, b.time, 0),
      'DTEND:' + moscowToUTC(b.date, b.time, VISIT_MINUTES),
      'SUMMARY:' + icsEscape('Стоматолог — ' + TEAM_TEXT),
      'DESCRIPTION:' + icsEscape('Услуга: ' + b.service + '. Запись подтвердим в Telegram или по телефону.'),
      'LOCATION:' + icsEscape(CLINIC_ADDRESS),
      // Напоминание за 2 часа
      'BEGIN:VALARM',
      'TRIGGER:-PT2H',
      'ACTION:DISPLAY',
      'DESCRIPTION:' + icsEscape('Приём у стоматолога'),
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ];
    // По стандарту строки разделяются CRLF (\r\n)
    return lines.join('\r\n') + '\r\n';
  }

  // Скачать файл: делаем Blob, временную ссылку и «нажимаем» на неё
  function downloadICS() {
    if (!lastBooking) return;
    const blob = new Blob([buildICS(lastBooking)], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `zapis-${lastBooking.date}.ics`;
    document.body.append(a);
    a.click();
    a.remove();
    // Освобождаем память чуть позже, чтобы скачивание успело начаться
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ============================================================
  // Запуск страницы
  // ============================================================

  function init() {
    // Плашка демо-режима
    if (api.isDemo()) el.demoBadge.hidden = false;

    renderServices();
    loadSlots(); // расписание общее — грузим сразу

    el.serviceSelect.addEventListener('change', () => {
      state.service = el.serviceSelect.value;
      updateSummary();
    });

    setupPhoneMask();
    setupLiveValidation();
    el.form.addEventListener('submit', onSubmit);
    el.icsBtn.addEventListener('click', downloadICS);

    updateSummary();
  }

  init();
})();
