// ============================================================
// Связь сайта с Google Таблицей (через Google Apps Script).
// Все страницы общаются с таблицей только через объект `api`.
// Если CONFIG.API_URL пустой — работает демо-режим.
// ============================================================

const api = (() => {
  const isDemo = () => !CONFIG.API_URL;

  // ---------- Вспомогательные функции ----------

  // Дата -> строка "2026-11-02"
  function toISODate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // GET-запрос: параметры уходят в адресную строку
  async function get(params) {
    const url = new URL(CONFIG.API_URL);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    return unwrap(await res.json());
  }

  // POST-запрос: text/plain, чтобы браузер не делал предварительный CORS-запрос
  async function post(body) {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
    });
    return unwrap(await res.json());
  }

  // Достаём data из ответа или бросаем ошибку с кодом
  function unwrap(json) {
    if (json && json.ok) return json.data;
    const err = new Error((json && json.message) || 'Ошибка сервера');
    err.code = (json && json.error) || 'unknown';
    throw err;
  }

  // ---------- Демо-данные (никаких реальных пациентов) ----------

  const demo = {
    booked: [], // записи, сделанные в демо-режиме в этой вкладке

    slots(doctor, fromISO, days) {
      const times = ['10:00', '11:00', '12:00', '13:00', '15:00', '16:00', '17:00', '18:00', '19:00', '20:00'];
      const out = [];
      const start = new Date(fromISO + 'T00:00:00');
      for (let i = 0; i < days; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const wd = d.getDay();
        if (wd === 0 || wd === 3) continue; // в демо: вс и ср выходные
        const date = toISODate(d);
        times.forEach((time, j) => {
          // doctor = '' — общее расписание команды (Юлия и Тихон принимают вместе)
          const busy = (i * 7 + j * 3 + (doctor || '').length) % 4 === 0;
          const taken = demo.booked.some((b) => b.date === date && b.time === time);
          if (!busy && !taken) out.push({ date, time, doctor });
        });
      }
      return out;
    },

    table(sheet) {
      const tables = {
        appointments: {
          headers: ['ID', 'Создано', 'Дата', 'Время', 'Врач', 'Пациент', 'Телефон', 'Telegram', 'Услуга', 'Комментарий', 'Статус'],
          rows: [
            [3, '01.11.2026', '02.11.2026', '15:00', 'Юля', 'Пример: Анна К.', '+7 900 000-00-01', '@example1', 'Гигиена', '', 'новая'],
            [2, '31.10.2026', '02.11.2026', '17:00', 'Тиша', 'Пример: Михаил Р.', '+7 900 000-00-02', '', 'Кариес', '', 'подтверждена'],
            [1, '30.10.2026', '05.11.2026', '19:00', 'Юля', 'Пример: Ольга С.', '+7 900 000-00-03', '@example3', 'Коррекция брекетов', '', 'подтверждена'],
          ],
        },
        visits: {
          headers: ['Пациент', 'Дата визита', 'Тип работы', 'Диагноз/ состояние', 'Врач', 'Цена', 'Зуб'],
          rows: [['Пример: Денис В.', '17.10.2026', 'гигиена', '', 'Тиша', 5000, '']],
        },
        expenses: {
          headers: ['Дата', 'Категория', 'Статья', 'Сумма', 'Комментарий'],
          rows: [['17.10.2026', 'расход', 'Аренда', 5500, ''], ['17.10.2026', 'доход', 'Оплата за день', 24000, '']],
        },
        patients: {
          headers: ['ID', 'ФИО', 'TG', 'Дата рождения', 'Телефон', 'Последний визит', 'Плановая дата сл. визита', 'Статус напоминания', 'Врач', 'Фото'],
          rows: [[1, 'Пример: Вера Л.', '@example', '', '', '17.10.2026', '', '', 'Юля', '']],
        },
      };
      return tables[sheet] || { headers: [], rows: [] };
    },
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- Публичные функции ----------

  return {
    isDemo,
    toISODate,

    // Список услуг из листа «Прайс»
    async getServices() {
      if (isDemo()) return FALLBACK_SERVICES;
      try {
        return await get({ action: 'services' });
      } catch (e) {
        console.warn('Прайс из таблицы недоступен, показываю запасной', e);
        return FALLBACK_SERVICES;
      }
    },

    // Свободные слоты: [{ date, time, doctor }]. doctor = '' — общее расписание команды
    async getSlots(doctor, fromISO = toISODate(new Date()), days = CONFIG.BOOKING_DAYS) {
      if (isDemo()) { await wait(300); return demo.slots(doctor, fromISO, days); }
      return get({ action: 'slots', doctor, from: fromISO, days });
    },

    // Записаться. booking = { doctor, date, time, service, name, phone, telegram, comment, website }
    async book(booking) {
      if (isDemo()) {
        await wait(500);
        demo.booked.push(booking);
        return { date: booking.date, time: booking.time, doctor: booking.doctor };
      }
      return post({ action: 'book', ...booking });
    },

    // Вход персонала: возвращает { token, name }
    async login(password) {
      if (isDemo()) {
        await wait(300);
        if (password !== 'demo') { const e = new Error('Неверный пароль (в демо-режиме пароль: demo)'); e.code = 'auth'; throw e; }
        return { token: 'demo-token', name: 'Демо' };
      }
      return post({ action: 'login', password });
    },

    // Последние строки листа: { headers, rows }
    async adminList(token, sheet, limit = 50) {
      if (isDemo()) { await wait(200); return demo.table(sheet); }
      return post({ action: 'admin_list', token, sheet, limit });
    },

    // Добавить строку (visits | expenses | patients | slots)
    async adminAdd(token, sheet, row) {
      if (isDemo()) { await wait(300); return { added: true }; }
      return post({ action: 'admin_add', token, sheet, row });
    },

    // Сменить статус онлайн-записи
    async adminUpdateStatus(token, rowId, status) {
      if (isDemo()) { await wait(200); return { updated: true }; }
      return post({ action: 'admin_update_status', token, rowId, status });
    },
  };
})();
