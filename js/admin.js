// ============================================================
// Кабинет персонала (admin/index.html).
// Вход по паролю → разделы: Онлайн-запись, Окна приёма, Визиты,
// Финансы, Пациенты. Все запросы к таблице — через объект `api`
// из js/api.js. Данные из таблицы выводятся ТОЛЬКО через textContent.
// ============================================================

// Ссылка на Google Таблицу для кнопки «Открыть таблицу».
// Пусто — кнопка не показывается. Пример: 'https://docs.google.com/spreadsheets/d/.../edit'
const SHEET_URL = '';

(() => {
  // ---------- Константы ----------

  const TOKEN_KEY = 'dent_admin_token'; // ключ в sessionStorage
  const TAB_KEY = 'dent_admin_tab';     // последний открытый раздел
  const LIST_LIMIT = 50;                // сколько строк загружать
  const STATUSES = ['новая', 'подтверждена', 'отменена', 'пришёл'];

  // ---------- Короткие помощники ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Безопасная работа с sessionStorage (в приватном режиме может падать)
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* не страшно */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch (e) { /* не страшно */ } },
  };

  // Текущий токен входа (null — не вошли)
  let token = store.get(TOKEN_KEY);

  // Загруженные строки — чтобы фильтровать и считать без повторных запросов
  const cache = { patients: null };

  // Создать элемент с классом и текстом (текст — только через textContent)
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  // Число → «12 500» (русская разбивка разрядов)
  function formatMoney(n) {
    return Math.round(n).toLocaleString('ru-RU');
  }

  // «р. 4 500,00», «4500», 4500 → 4500; непонятное → 0
  function parseMoney(v) {
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const s = String(v || '')
      .replace(/[\s  ]/g, '')
      .replace(/[^\d,.\-]/g, '')
      .replace(/^[.,]+/, '')
      .replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  }

  // Сегодняшняя дата для полей <input type="date">
  const todayISO = () => api.toISODate(new Date());

  // ---------- Сообщения ----------

  let msgTimer = null;

  // Показать сообщение над разделом. type: 'ok' | 'error' | ''
  function showMsg(text, type = '') {
    const box = $('#globalMsg');
    box.textContent = text;
    box.className = 'admin-msg' + (type ? ' admin-msg--' + type : '');
    box.hidden = false;
    clearTimeout(msgTimer);
    if (type === 'ok') msgTimer = setTimeout(() => { box.hidden = true; }, 4000);
  }

  function hideMsg() { $('#globalMsg').hidden = true; }

  // Общая обработка ошибки запроса: auth → на экран входа, иначе — текст ошибки
  function handleError(err) {
    if (err && err.code === 'auth') {
      logout('Сессия закончилась. Войдите снова.');
      return;
    }
    const text = (err && err.message) || 'Не удалось связаться с таблицей.';
    showMsg(text === 'Failed to fetch' ? 'Нет связи с сервером. Проверьте интернет.' : text, 'error');
  }

  // Заблокировать кнопку на время запроса
  async function withBusy(button, fn) {
    if (button) button.disabled = true;
    try { return await fn(); } finally { if (button) button.disabled = false; }
  }

  // ---------- Вход и выход ----------

  // Показать экран входа (с необязательным сообщением)
  function showLogin(message) {
    $('#appScreen').hidden = true;
    $('#loginScreen').hidden = false;
    const err = $('#loginError');
    err.hidden = !message;
    err.textContent = message || '';
    $('#loginPassword').value = '';
    $('#loginPassword').focus();
  }

  // Показать рабочую область и открыть раздел
  function showApp() {
    $('#loginScreen').hidden = true;
    $('#appScreen').hidden = false;
    openTab(store.get(TAB_KEY) || 'appointments');
  }

  // Выход: забыть токен и вернуться ко входу
  function logout(message) {
    token = null;
    store.del(TOKEN_KEY);
    cache.patients = null;
    hideMsg();
    showLogin(message);
  }

  // Отправка формы входа
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $('#loginPassword').value;
    const err = $('#loginError');
    err.hidden = true;
    if (!password) {
      err.textContent = 'Введите пароль.';
      err.hidden = false;
      return;
    }
    await withBusy($('#loginBtn'), async () => {
      try {
        const res = await api.login(password);
        token = res.token;
        store.set(TOKEN_KEY, token);
        showApp();
      } catch (ex) {
        err.textContent = (ex && ex.message) || 'Не удалось войти.';
        err.hidden = false;
      }
    });
  });

  $('#logoutBtn').addEventListener('click', () => logout());

  // ---------- Переключение разделов ----------

  // Что загружать при открытии раздела
  const loaders = {
    appointments: loadAppointments,
    slots: () => {},
    visits: () => { loadVisits(); loadPatientNames(); },
    finance: loadFinance,
    patients: loadPatients,
  };

  function openTab(name) {
    if (!loaders[name]) name = 'appointments';
    store.set(TAB_KEY, name);
    hideMsg();
    $$('.admin-nav__item').forEach((b) => {
      const active = b.dataset.tab === name;
      b.classList.toggle('is-active', active);
      if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    $$('.admin-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    loaders[name]();
  }

  $$('.admin-nav__item').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));

  // Кнопки «Обновить»
  $$('[data-reload]').forEach((b) => b.addEventListener('click', () => {
    hideMsg();
    loaders[b.dataset.reload]();
  }));

  // ---------- Построение таблиц ----------

  /**
   * Рисует таблицу в контейнере.
   * headers — заголовки; rows — массив строк;
   * opts.cell(td, value, colIndex, row) — своя отрисовка ячейки (вернуть true, если отрисовал);
   * opts.rowClass(row) — класс строки; opts.longCols — колонки с длинным текстом.
   */
  function renderTable(container, headers, rows, opts = {}) {
    container.textContent = '';
    if (!rows.length) {
      container.appendChild(el('p', 'admin-empty', opts.empty || 'Пока пусто.'));
      return;
    }
    const table = el('table', 'admin-table');
    const thead = el('thead');
    const htr = el('tr');
    headers.forEach((h) => {
      const th = el('th', '', h);
      th.scope = 'col';
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = el('tbody');
    rows.forEach((row) => {
      const tr = el('tr', opts.rowClass ? opts.rowClass(row) : '');
      headers.forEach((_, i) => {
        const td = el('td');
        const v = row[i];
        if (opts.cell && opts.cell(td, v, i, row)) { tr.appendChild(td); return; }
        if (typeof v === 'number' && (opts.moneyCols || []).includes(i)) {
          td.textContent = formatMoney(v);
          td.classList.add('is-num');
        } else {
          td.textContent = v === null || v === undefined ? '' : String(v);
        }
        if ((opts.longCols || []).includes(i)) td.classList.add('is-long');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.appendChild(table);
  }

  // Индикатор загрузки в контейнере таблицы
  function setLoading(container) {
    container.textContent = '';
    container.appendChild(el('p', 'admin-empty', 'Загрузка…'));
  }

  // Номер колонки по названию заголовка (без учёта регистра); fallback — если не нашли
  function colIndex(headers, name, fallback) {
    const i = headers.findIndex((h) => String(h).trim().toLowerCase() === name.toLowerCase());
    return i === -1 ? fallback : i;
  }

  // ---------- Онлайн-запись ----------

  async function loadAppointments() {
    const box = $('#appointmentsTable');
    setLoading(box);
    try {
      const { headers, rows } = await api.adminList(token, 'appointments', LIST_LIMIT);
      const idCol = colIndex(headers, 'ID', 0);
      const stCol = colIndex(headers, 'Статус', 10);

      renderTable(box, headers, rows, {
        empty: 'Онлайн-записей пока нет.',
        longCols: [colIndex(headers, 'Комментарий', 9), colIndex(headers, 'Услуга', 8)],
        rowClass: (r) => {
          const s = String(r[stCol] || '').trim();
          if (s === 'новая' || s === '') return 'is-new';
          if (s === 'отменена') return 'is-cancelled';
          return '';
        },
        // В колонке «Статус» — выпадающий список
        cell: (td, value, i, row) => {
          if (i !== stCol) return false;
          td.classList.add('cell-status');
          const current = String(value || '').trim() || 'новая';
          const select = el('select');
          select.setAttribute('aria-label', 'Статус записи ' + row[idCol]);
          const list = STATUSES.includes(current) ? STATUSES : STATUSES.concat(current);
          list.forEach((s) => {
            const opt = el('option', '', s);
            opt.value = s;
            if (s === current) opt.selected = true;
            select.appendChild(opt);
          });
          select.dataset.prev = current; // прежнее значение — чтобы откатить при ошибке
          select.addEventListener('change', () => changeStatus(select, row[idCol]));
          td.appendChild(select);
          return true;
        },
      });
    } catch (err) {
      box.textContent = '';
      handleError(err);
    }
  }

  // Сменить статус записи; при ошибке вернуть прежнее значение
  async function changeStatus(select, rowId) {
    const status = select.value;
    select.disabled = true;
    try {
      await api.adminUpdateStatus(token, rowId, status);
      const tr = select.closest('tr');
      tr.classList.toggle('is-new', status === 'новая');
      tr.classList.toggle('is-cancelled', status === 'отменена');
      showMsg('Статус записи ' + rowId + ': ' + status + '.', 'ok');
      select.dataset.prev = status; // запоминаем для следующей смены
    } catch (err) {
      select.value = select.dataset.prev;
      handleError(err);
    } finally {
      select.disabled = false;
    }
  }

  // ---------- Окна приёма ----------

  // «15:30» → 930 (минуты от полуночи)
  const toMinutes = (t) => {
    const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  // 930 → «15:30»
  const fromMinutes = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

  // Список времён от начала до конца с шагом (последнее окно + шаг ≤ конец)
  function buildTimes(start, end, step) {
    const a = toMinutes(start);
    const b = toMinutes(end);
    const out = [];
    if (isNaN(a) || isNaN(b) || !(step > 0)) return out;
    for (let t = a; t + step <= b; t += step) out.push(fromMinutes(t));
    return out;
  }

  // Предпросмотр: какие окна будут созданы
  function updateSlotPreview() {
    const f = $('#slotsForm');
    const times = buildTimes(f.start.value, f.end.value, Number(f.step.value));
    $('#slotPreview').textContent = times.length
      ? 'Будет создано окон: ' + times.length + ' (' + times.join(', ') + ').'
      : 'Проверьте время: конец должен быть позже начала хотя бы на один шаг.';
  }
  ['start', 'end', 'step'].forEach((n) => $('#slotsForm')[n].addEventListener('input', updateSlotPreview));

  $('#slotsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    // Врачи принимают вместе — окно общее для команды, врача не указываем
    const doctor = '';
    const date = f.date.value;
    const step = Number(f.step.value);
    const comment = f.comment.value.trim();
    const times = buildTimes(f.start.value, f.end.value, step);

    if (!date) { showMsg('Выберите дату.', 'error'); return; }
    if (!times.length) { showMsg('Нет ни одного окна: проверьте начало, конец и шаг.', 'error'); return; }
    hideMsg();

    const progress = $('#slotsProgress');
    await withBusy($('#slotsSubmit'), async () => {
      let done = 0;
      // Отправляем по одному, чтобы видеть прогресс и не потерять всё при сбое
      for (const time of times) {
        progress.textContent = 'Добавляю ' + (done + 1) + ' из ' + times.length + '…';
        try {
          await api.adminAdd(token, 'slots', { date, time, doctor, minutes: step, comment });
          done++;
        } catch (err) {
          progress.textContent = '';
          handleError(err);
          if (err && err.code !== 'auth') {
            showMsg('Добавлено ' + done + ' из ' + times.length + '. Ошибка: ' + (err.message || 'неизвестно'), 'error');
          }
          return;
        }
      }
      progress.textContent = '';
      showMsg('Готово: добавлено окон — ' + done + ' (' + date.split('-').reverse().join('.') + ').', 'ok');
    });
  });

  // ---------- Визиты ----------

  async function loadVisits() {
    const box = $('#visitsTable');
    setLoading(box);
    try {
      const { headers, rows } = await api.adminList(token, 'visits', LIST_LIMIT);
      renderTable(box, headers, rows, {
        empty: 'Визитов пока нет.',
        moneyCols: [colIndex(headers, 'Цена', 5)],
        longCols: [colIndex(headers, 'Диагноз/ состояние', 3)],
      });
    } catch (err) {
      box.textContent = '';
      handleError(err);
    }
  }

  // Подсказки ФИО в поле «Пациент» (из листа «Пациенты»)
  async function loadPatientNames() {
    try {
      if (!cache.patients) cache.patients = await api.adminList(token, 'patients', 500);
      const { headers, rows } = cache.patients;
      const nameCol = colIndex(headers, 'ФИО', 1);
      const list = $('#patientNames');
      list.textContent = '';
      rows.forEach((r) => {
        const opt = el('option');
        opt.value = String(r[nameCol] || '').trim();
        if (opt.value) list.appendChild(opt);
      });
    } catch (err) {
      // Подсказки необязательны — ошибку auth всё же обрабатываем
      if (err && err.code === 'auth') handleError(err);
    }
  }

  $('#visitsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const row = {
      patient: f.patient.value.trim(),
      date: f.date.value,
      type: f.type.value,
      note: f.note.value.trim(),
      doctor: f.doctor.value,
      price: f.price.value === '' ? '' : Number(f.price.value),
      tooth: f.tooth.value.trim(),
    };
    if (!row.patient) { showMsg('Укажите пациента.', 'error'); f.patient.focus(); return; }
    if (!row.date) { showMsg('Укажите дату визита.', 'error'); return; }

    await withBusy(f.querySelector('button[type="submit"]'), async () => {
      try {
        await api.adminAdd(token, 'visits', row);
        showMsg('Визит добавлен.', 'ok');
        f.reset();
        f.date.value = todayISO();
        fillDoctorSelects();
        loadVisits();
      } catch (err) { handleError(err); }
    });
  });

  // ---------- Финансы ----------

  async function loadFinance() {
    const box = $('#financeTable');
    setLoading(box);
    try {
      const { headers, rows } = await api.adminList(token, 'expenses', LIST_LIMIT);
      const catCol = colIndex(headers, 'Категория', 1);
      const sumCol = colIndex(headers, 'Сумма', 3);

      // Итоги по загруженным строкам
      let income = 0;
      let expense = 0;
      rows.forEach((r) => {
        const cat = String(r[catCol] || '').trim().toLowerCase();
        const sum = parseMoney(r[sumCol]);
        if (cat === 'доход') income += sum;
        else if (cat === 'расход') expense += sum;
      });
      $('#statIncome').textContent = formatMoney(income) + ' ₽';
      $('#statExpense').textContent = formatMoney(expense) + ' ₽';
      $('#statCaption').textContent = 'За последние ' + rows.length + ' записей';

      renderTable(box, headers, rows, {
        empty: 'Операций пока нет.',
        moneyCols: [sumCol],
        longCols: [colIndex(headers, 'Комментарий', 4)],
      });
    } catch (err) {
      box.textContent = '';
      handleError(err);
    }
  }

  $('#financeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const row = {
      date: f.date.value,
      category: f.category.value,
      item: f.item.value.trim(),
      amount: f.amount.value === '' ? NaN : Number(f.amount.value),
      comment: f.comment.value.trim(),
    };
    if (!row.date) { showMsg('Укажите дату.', 'error'); return; }
    if (!row.item) { showMsg('Укажите статью.', 'error'); f.item.focus(); return; }
    if (!(row.amount >= 0)) { showMsg('Укажите сумму.', 'error'); f.amount.focus(); return; }

    await withBusy(f.querySelector('button[type="submit"]'), async () => {
      try {
        await api.adminAdd(token, 'expenses', row);
        showMsg('Запись добавлена.', 'ok');
        const keepDate = f.date.value; // часто вносят несколько строк за один день
        f.reset();
        f.date.value = keepDate;
        loadFinance();
      } catch (err) { handleError(err); }
    });
  });

  // ---------- Пациенты ----------

  async function loadPatients() {
    const box = $('#patientsTable');
    setLoading(box);
    try {
      cache.patients = await api.adminList(token, 'patients', 500);
      renderPatients();
    } catch (err) {
      box.textContent = '';
      handleError(err);
    }
  }

  // Перерисовать таблицу пациентов с учётом строки поиска (фильтр в браузере)
  function renderPatients() {
    if (!cache.patients) return;
    const { headers, rows } = cache.patients;
    const nameCol = colIndex(headers, 'ФИО', 1);
    const q = $('#patSearch').value.trim().toLowerCase().replace(/ё/g, 'е');
    const filtered = q
      ? rows.filter((r) => String(r[nameCol] || '').toLowerCase().replace(/ё/g, 'е').includes(q))
      : rows;
    renderTable($('#patientsTable'), headers, filtered, {
      empty: q ? 'Никого не нашлось.' : 'Пациентов пока нет.',
    });
  }

  $('#patSearch').addEventListener('input', renderPatients);

  $('#patientsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const row = {
      name: f.name.value.trim(),
      telegram: f.telegram.value.trim(),
      birthday: f.birthday.value,
      phone: f.phone.value.trim(),
      doctor: f.doctor.value,
    };
    if (!row.name) { showMsg('Укажите ФИО.', 'error'); f.name.focus(); return; }

    await withBusy(f.querySelector('button[type="submit"]'), async () => {
      try {
        await api.adminAdd(token, 'patients', row);
        showMsg('Пациент добавлен.', 'ok');
        f.reset();
        fillDoctorSelects();
        cache.patients = null;
        loadPatients();
      } catch (err) { handleError(err); }
    });
  });

  // ---------- Начальная настройка страницы ----------

  // Заполнить все списки врачей из DOCTORS (config.js)
  function fillDoctorSelects() {
    $$('select[data-doctors]').forEach((sel) => {
      const prev = sel.value;
      sel.textContent = '';
      DOCTORS.forEach((d) => {
        const opt = el('option', '', d.name + ' (' + d.key + ')');
        opt.value = d.key;
        sel.appendChild(opt);
      });
      if (prev) sel.value = prev;
    });
  }

  function init() {
    // Плашка демо-режима
    $('#demoBar').hidden = !api.isDemo();

    // Ссылка на таблицу — только если задана
    if (SHEET_URL) {
      const link = $('#sheetLink');
      link.href = SHEET_URL;
      link.hidden = false;
    }

    fillDoctorSelects();
    $('#visitDate').value = todayISO();
    $('#finDate').value = todayISO();
    $('#slotDate').value = todayISO();
    $('#slotDate').min = todayISO();
    updateSlotPreview();

    // Если в этой вкладке уже входили — сразу показываем кабинет.
    // Просроченный токен отсеется первым же запросом (ошибка auth).
    if (token) showApp(); else showLogin();
  }

  init();
})();
