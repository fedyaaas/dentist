// ============================================================
// Логика главной страницы (index.html).
// Подключается после js/config.js и js/api.js, поэтому здесь
// уже доступны CONFIG, DOCTORS, FALLBACK_SERVICES и api.
// Всё, что приходит из таблицы, вставляем через textContent —
// так в страницу не попадёт чужой HTML-код.
// ============================================================


// ---------- Маленькие помощники ----------

// Создать элемент: el('p', 'класс', 'текст')
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// Создать SVG-иконку из готовой разметки (разметка наша, не от пользователя)
function icon(svgMarkup) {
  const wrap = document.createElement('span');
  wrap.innerHTML = svgMarkup;
  return wrap.firstElementChild;
}

// Иконка часов для строки «Ближайшая запись»
const CLOCK_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>' +
  '<path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// Иконка фотоаппарата для заглушки фото
const CAMERA_SVG =
  '<svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true" focusable="false">' +
  '<rect x="6" y="12" width="36" height="26" rx="5" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
  '<circle cx="24" cy="25" r="7" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
  '<path d="M17 12l3-5h8l3 5" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>';


// ---------- Форматирование цен и дат ----------

// Форматтер цены: 6000 -> «6 000 ₽»
const priceFormat = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
});

// Превратить число в строку цены
function formatPrice(value) {
  const n = Number(value);
  if (!isFinite(n)) return String(value);
  return priceFormat.format(n);
}

// Длительность в минутах -> «60 мин» или «1 ч 30 мин»
function formatMinutes(minutes) {
  const m = Number(minutes);
  if (!m || m <= 0) return '';
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

// Строка "2026-11-05" -> объект Date (полночь по местному времени)
function parseISODate(iso) {
  const [y, mo, d] = String(iso).split('-').map(Number);
  return new Date(y, mo - 1, d);
}

// Слот { date, time } -> «сегодня в 15:00» / «завтра в 11:00» / «5 ноября в 15:00»
function formatSlot(slot) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = parseISODate(slot.date);
  const diffDays = Math.round((day - today) / 86400000);

  let dayText;
  if (diffDays === 0) dayText = 'сегодня';
  else if (diffDays === 1) dayText = 'завтра';
  else dayText = day.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

  return `${dayText} в ${slot.time}`;
}

// Найти первый слот, который ещё не прошёл (сегодняшние прошедшие часы пропускаем)
function firstUpcomingSlot(slots) {
  const now = new Date();
  const upcoming = (slots || [])
    .map((s) => {
      const [hh, mm] = String(s.time).split(':').map(Number);
      const at = parseISODate(s.date);
      at.setHours(hh || 0, mm || 0, 0, 0);
      return { slot: s, at };
    })
    .filter((x) => x.at > now)
    .sort((a, b) => a.at - b.at);
  return upcoming.length ? upcoming[0].slot : null;
}


// ---------- 1. Мобильное меню (бургер) ----------

// Открывает и закрывает меню по кнопке; закрывает по Esc и по клику на пункт
function initMobileNav() {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.getElementById('site-nav');
  if (!toggle || !nav) return;

  // Поставить меню в нужное состояние (open = true/false)
  function setOpen(open) {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    nav.classList.toggle('is-open', open);
  }

  toggle.addEventListener('click', () => {
    setOpen(toggle.getAttribute('aria-expanded') !== 'true');
  });

  // Клик по ссылке в меню — закрываем (страница прокрутится к разделу)
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) setOpen(false);
  });

  // Esc — закрыть и вернуть фокус на кнопку
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });

  // Если окно расширили до десктопа — сбрасываем состояние
  window.matchMedia('(min-width: 861px)').addEventListener('change', (e) => {
    if (e.matches) setOpen(false);
  });
}


// ---------- 2. Карточки врачей ----------

// Фото врача: <img>, а если файла нет — серая заглушка «Фото скоро»
function createDoctorPhoto(doctor) {
  // Заглушка (её же подставляем при ошибке загрузки)
  function makePlaceholder() {
    const stub = el('div', 'doctor__photo photo--empty');
    stub.setAttribute('role', 'img');
    stub.setAttribute('aria-label', `Фото: ${doctor.name} — скоро`);
    stub.appendChild(icon(CAMERA_SVG));
    stub.appendChild(el('span', '', 'Фото скоро'));
    return stub;
  }

  if (!doctor.photo) return makePlaceholder();

  const img = el('img', 'doctor__photo');
  img.src = doctor.photo;
  img.alt = `Врач ${doctor.name}`;
  img.loading = 'lazy';
  img.width = 320;
  img.height = 426;
  img.onerror = () => img.replaceWith(makePlaceholder());
  return img;
}

// Одна карточка врача (как у сети клиник: фото, имя, стаж, теги, ближайшая запись, кнопка)
function createDoctorCard(doctor) {
  const card = el('article', 'doctor card');
  card.appendChild(createDoctorPhoto(doctor));

  const body = el('div', 'doctor__body');
  body.appendChild(el('h3', 'doctor__name', doctor.name));
  if (doctor.role) body.appendChild(el('p', 'doctor__role', doctor.role));


  // Теги процедур
  if (doctor.tags && doctor.tags.length) {
    const tags = el('ul', 'doctor__tags');
    tags.setAttribute('aria-label', 'Направления');
    doctor.tags.forEach((t) => {
      const li = el('li');
      li.appendChild(el('span', 'chip', t));
      tags.appendChild(li);
    });
    body.appendChild(tags);
  }

  // Ссылки «Написать в Telegram» и «Записаться» внизу карточки
  const actions = el('div', 'doctor__actions');
  const book = el('a', 'btn', 'Записаться');
  book.href = 'booking.html';
  actions.appendChild(book);
  if (doctor.telegram) {
    const tg = el('a', 'btn btn--ghost', 'Написать');
    tg.href = doctor.telegram;
    tg.target = '_blank';
    tg.rel = 'noopener';
    tg.setAttribute('aria-label', `Написать в Telegram: ${doctor.name}`);
    actions.appendChild(tg);
  }
  body.appendChild(actions);

  card.appendChild(body);
  return card;
}

// Узнать у таблицы первое свободное время команды и показать его под карточками.
// Юлия и Тихон принимают вместе, поэтому расписание общее (getSlots('')).
async function loadNearestSlot() {
  const target = document.getElementById('team-next');
  if (!target) return;

  // Если слотов нет или ошибка — предлагаем написать в Telegram
  function showFallback() {
    target.textContent = '';
    const tg = DOCTORS[0] && DOCTORS[0].telegram;
    if (tg) {
      const link = el('a', '', 'уточняйте в Telegram');
      link.href = tg;
      link.target = '_blank';
      link.rel = 'noopener';
      target.appendChild(link);
    } else {
      target.textContent = 'уточняйте в Telegram';
    }
  }

  try {
    const slots = await api.getSlots('');
    const first = firstUpcomingSlot(slots);
    if (first) target.textContent = formatSlot(first);
    else showFallback();
  } catch (e) {
    console.warn('Не удалось загрузить свободное время', e);
    showFallback();
  }
}

// Нарисовать все карточки из массива DOCTORS и строку ближайшей записи
function renderDoctors() {
  const list = document.getElementById('doctors-list');
  if (!list) return;
  list.textContent = '';
  DOCTORS.forEach((doctor) => list.appendChild(createDoctorCard(doctor)));
  loadNearestSlot();
}


// ---------- 3. Услуги и цены ----------

// Сгруппировать услуги по направлению: [{ group, items: [...] }] в исходном порядке
function groupServices(services) {
  const groups = [];
  const byName = new Map();
  services.forEach((s) => {
    const name = s.group || 'Другое';
    if (!byName.has(name)) {
      const g = { group: name, items: [] };
      byName.set(name, g);
      groups.push(g);
    }
    byName.get(name).items.push(s);
  });
  return groups;
}

// Одна строка прайса: название — длительность — цена
function createPriceRow(service) {
  const li = el('li', 'price__row');
  li.appendChild(el('span', 'price__name', service.name));
  li.appendChild(el('span', 'price__time', formatMinutes(service.minutes)));
  // Цена всегда «от …»: итог зависит от сложности случая
  li.appendChild(el('span', 'price__cost', 'от ' + formatPrice(service.price)));
  return li;
}

// Показать список услуг; activeGroup = null значит «Все»
function renderPriceList(container, groups, activeGroup) {
  container.textContent = '';
  groups
    .filter((g) => activeGroup === null || g.group === activeGroup)
    .forEach((g) => {
      const block = el('section', 'price__group');
      block.appendChild(el('h3', 'price__group-title', g.group));
      const ul = el('ul', 'price__list');
      g.items.forEach((s) => ul.appendChild(createPriceRow(s)));
      block.appendChild(ul);
      container.appendChild(block);
    });
}

// Нарисовать вкладки-фильтры: «Все» + по одной на каждое направление
function renderTabs(tabsBox, groups, onSelect) {
  tabsBox.textContent = '';
  const options = [{ label: 'Все', value: null }].concat(
    groups.map((g) => ({ label: g.group, value: g.group }))
  );

  options.forEach((opt, i) => {
    const btn = el('button', 'tab', opt.label);
    btn.type = 'button';
    btn.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
    btn.addEventListener('click', () => {
      tabsBox.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      onSelect(opt.value);
    });
    tabsBox.appendChild(btn);
  });
}

// Загрузить прайс из таблицы и показать его с фильтрами
async function initServices() {
  const listBox = document.getElementById('services-list');
  const tabsBox = document.getElementById('services-tabs');
  if (!listBox || !tabsBox) return;

  let services;
  try {
    services = await api.getServices();
  } catch (e) {
    console.warn('Прайс не загрузился, беру запасной', e);
    services = FALLBACK_SERVICES;
  }

  // Строки без цены не показываем
  services = (services || []).filter((s) => s && s.name && s.price !== '' && s.price !== null && s.price !== undefined);

  if (!services.length) {
    listBox.textContent = '';
    listBox.appendChild(el('p', 'price__status', 'Прайс временно недоступен — напишите нам в Telegram, подскажем цену.'));
    return;
  }

  const groups = groupServices(services);
  renderTabs(tabsBox, groups, (value) => renderPriceList(listBox, groups, value));
  renderPriceList(listBox, groups, null);
}


// ---------- 4. Плашка демо-режима ----------

// Если адрес таблицы не настроен — показать маленькую плашку внизу экрана
function showDemoBadge() {
  if (!api.isDemo()) return;
  const badge = el('div', 'demo-badge', 'Демо-режим: данные выдуманы');
  badge.setAttribute('role', 'note');
  document.body.appendChild(badge);
}


// ---------- Запуск ----------

// Всё стартует, когда страница готова (скрипты подключены с defer)
function initHomePage() {
  initMobileNav();
  // Остальное — только на главной (на других страницах этих блоков нет)
  if (document.body.dataset.page !== 'home') return;
  renderDoctors();
  initServices();
  showDemoBadge();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initHomePage);
} else {
  initHomePage();
}
