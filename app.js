(function () {
  'use strict';

  /* ============================================================
     DATA
     ============================================================ */
  const CATEGORIES = window.CATEGORIES || [];
  const THEORY = window.THEORY || [];
  const TESTS = window.TESTS || [];

  const CAT = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));
  const CAT_INDEX = Object.fromEntries(CATEGORIES.map((c, i) => [c.id, String(i + 1).padStart(2, '0')]));
  CAT_INDEX.search = '00';
  CAT.search = { id: 'search', name: 'Поиск', desc: 'Результаты поиска' };
  const THEORY_BY_ID = Object.fromEntries(THEORY.map(t => [t.id, t]));
  const THEORY_TAGS = window.THEORY_TAGS || {};
  const TESTS_BY_CONCEPT = {};
  TESTS.forEach(t => {
    if (!TESTS_BY_CONCEPT[t.concept]) TESTS_BY_CONCEPT[t.concept] = [];
    TESTS_BY_CONCEPT[t.concept].push(t);
  });

  const LS_KEY = 'agnia_trainer_v1';
  const saved = loadSaved();

  /* ============================================================
     STATE
     ============================================================ */
  const state = {
    mode: 'study',
    study: {
      cat: 'all',
      level: 'all',
      status: 'all',
      query: '',
      hide: false,
      revealed: new Set(),
      view: 'sections',
      page: saved.studyPage || 1,
      perPage: saved.perPage || 20,
      lastId: saved.lastTheory || null
    },
    test: {
      screen: 'setup',
      config: { cat: 'all', cats: [], level: 'all', count: 20, unique: false, shuffleOptions: true, query: '' },
      questions: [],
      index: 0,
      answers: [],
      startedAt: 0,
      elapsed: 0,
      timer: null,
      recorded: false
    },
    exam: {
      screen: 'setup',
      questions: [],
      index: 0,
      selected: [],
      flags: new Set(),
      remaining: 45 * 60,
      timer: null,
      startedAt: 0,
      recorded: false
    },
    mock: {
      screen: 'setup',
      cat: 'interview',
      duration: 120,
      count: 10,
      questions: [],
      index: 0,
      timeLeft: 120,
      timer: null,
      revealed: false,
      self: []
    },
    learned: new Set(saved.learned || []),
    bookmarked: new Set(saved.bookmarked || []),
    stats: saved.stats || { attempts: [], perCat: {}, perTest: {} },
    theme: saved.theme || 'light',
    toastTimer: null,
    studyObserver: null,
    studyScrolled: false,
    studySaveTimer: null
  };

  /* ============================================================
     UTILS
     ============================================================ */
  function loadSaved() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function saveSaved() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        learned: [...state.learned],
        bookmarked: [...state.bookmarked],
        stats: state.stats,
        lastTheory: state.study.lastId,
        studyPage: state.study.page,
        perPage: state.study.perPage,
        lastMode: state.mode,
        session: buildSessionSnapshot(),
        theme: state.theme,
        savedAt: Date.now()
      }));
    } catch (e) { /* storage may be unavailable */ }
  }

  function buildSessionSnapshot() {
    return {
      test: {
        screen: state.test.screen,
        config: state.test.config,
        questions: state.test.questions,
        index: state.test.index,
        answers: state.test.answers,
        multiSelection: state.test.multiSelection,
        startedAt: state.test.startedAt,
        elapsed: state.test.elapsed,
        recorded: state.test.recorded
      },
      exam: {
        screen: state.exam.screen,
        questions: state.exam.questions,
        index: state.exam.index,
        selected: state.exam.selected,
        flags: [...state.exam.flags],
        remaining: state.exam.remaining,
        startedAt: state.exam.startedAt,
        recorded: state.exam.recorded
      },
      mock: {
        screen: state.mock.screen,
        cat: state.mock.cat,
        duration: state.mock.duration,
        count: state.mock.count,
        questions: (state.mock.questions || []).map(q => q.id),
        index: state.mock.index,
        timeLeft: state.mock.timeLeft,
        revealed: state.mock.revealed,
        self: state.mock.self
      }
    };
  }

  function restoreSession(session, lastMode) {
    if (!session) return;
    if (session.test) {
      state.test = {
        ...state.test,
        ...session.test,
        timer: null,
        multiSelection: session.test.multiSelection || []
      };
      if (state.test.screen === 'running') startTestTimer();
    }
    if (session.exam) {
      state.exam = {
        ...state.exam,
        ...session.exam,
        flags: new Set(session.exam.flags || []),
        timer: null
      };
      if (state.exam.screen === 'running') {
        if (state.exam.remaining <= 0) state.exam.screen = 'result';
        else startExamTimer();
      }
    }
    if (session.mock) {
      const questions = (session.mock.questions || [])
        .map(id => THEORY_BY_ID[id])
        .filter(Boolean);
      state.mock = {
        ...state.mock,
        ...session.mock,
        questions,
        timer: null
      };
      if (state.mock.screen === 'running' && questions.length) startMockTimer();
      else if (state.mock.screen === 'running') state.mock.screen = 'setup';
    }
    if (lastMode && ['study', 'test', 'exam', 'mock', 'stats'].includes(lastMode)) {
      state.mode = lastMode;
    }
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function highlight(text, query) {
    let safe = esc(text);
    const terms = String(query || '').trim().split(/\s+/).filter(Boolean);
    terms.forEach(term => {
      const re = new RegExp('(' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
      safe = safe.replace(re, '<mark>$1</mark>');
    });
    return safe;
  }

  function theoryTags(t) {
    return (THEORY_TAGS[t.id] || []).join(' ');
  }

  function matchesQuery(hay, q) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    return terms.every(term => hay.includes(term));
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function fmtDate(ts) {
    try {
      return new Date(ts).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit'
      });
    } catch (e) { return '—'; }
  }

  function levelBadge(lvl) {
    if (lvl === 'J') return '<span class="badge badge-j">J</span>';
    if (lvl === 'J+') return '<span class="badge badge-jp">J+</span>';
    return '<span class="badge badge-m">M</span>';
  }

  function levelShort(lvl) {
    if (lvl === 'J') return 'J';
    if (lvl === 'J+') return 'J+';
    return 'M';
  }

  function catName(id) { return CAT[id] ? CAT[id].name : id; }
  function catIcon(id) { return CAT[id] ? CAT[id].icon : '•'; }

  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  function applyTheme(theme) {
    const t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = t === 'dark' ? 'День' : 'Ночь';
  }

  window.toggleTheme = function () {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    applyTheme(state.theme);
    saveSaved();
  };

  /* ============================================================
     RENDER ROOT
     ============================================================ */
  function render() {
    document.querySelectorAll('.mode-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === state.mode);
    });
    renderHeaderProgress();
    renderSidebar();
    renderMain();
    const full = (state.mode === 'test' && state.test.screen === 'running') ||
                 (state.mode === 'exam' && state.exam.screen === 'running') ||
                 (state.mode === 'mock' && state.mock.screen === 'running');
    document.getElementById('appLayout').classList.toggle('full', full);
  }

  function renderMain() {
    const el = document.getElementById('main');
    if (!el) return;
    if (state.mode === 'study') el.innerHTML = renderStudyMain();
    else if (state.mode === 'test') el.innerHTML = renderTestMain();
    else if (state.mode === 'exam') el.innerHTML = renderExamMain();
    else if (state.mode === 'mock') el.innerHTML = renderMockMain();
    else el.innerHTML = renderStatsMain();

    if (state.mode === 'study') requestAnimationFrame(observeStudyCards);
    else if (state.studyObserver) state.studyObserver.disconnect();
  }

  function observeStudyCards() {
    if (state.studyObserver) state.studyObserver.disconnect();
    if (!('IntersectionObserver' in window)) return;
    const cards = document.querySelectorAll('.q-card[data-id]');
    if (!cards.length) return;
    state.studyObserver = new IntersectionObserver(entries => {
      if (!state.studyScrolled) return;
      const visible = entries
        .filter(e => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (!visible.length) return;
      const id = visible[0].target.getAttribute('data-id');
      if (id && id !== state.study.lastId) {
        state.study.lastId = id;
        clearTimeout(state.studySaveTimer);
        state.studySaveTimer = setTimeout(saveSaved, 450);
      }
    }, { rootMargin: '-96px 0px -55% 0px', threshold: 0 });
    cards.forEach(c => state.studyObserver.observe(c));
  }

  function renderHeaderProgress() {
    const total = THEORY.length;
    const done = [...state.learned].filter(id => THEORY_BY_ID[id]).length;
    const p = pct(done, total);
    const el = document.getElementById('headerProgress');
    if (!el) return;
    el.innerHTML = `
      <span>Изучено: <strong>${done} / ${total}</strong></span>
      <span class="mini-bar"><i style="width:${p}%"></i></span>
      <span>${p}%</span>
    `;
  }

  /* ============================================================
     SIDEBAR
     ============================================================ */
  function renderSidebar() {
    const el = document.getElementById('sidebar');
    if (!el) return;

    if (state.mode === 'test' && state.test.screen === 'running') { el.innerHTML = ''; return; }
    if (state.mode === 'exam' && state.exam.screen === 'running') { el.innerHTML = ''; return; }
    if (state.mode === 'mock' && state.mock.screen === 'running') { el.innerHTML = ''; return; }

    if (state.mode === 'study') el.innerHTML = renderStudySidebar();
    else if (state.mode === 'test') el.innerHTML = renderTestSidebar();
    else if (state.mode === 'exam') el.innerHTML = renderExamSidebar();
    else if (state.mode === 'mock') el.innerHTML = renderMockSidebar();
    else el.innerHTML = renderStatsSidebar();
  }

  function renderStudySidebar() {
    const total = THEORY.length;
    const learned = [...state.learned].filter(id => THEORY_BY_ID[id]).length;
    const bookmarked = state.bookmarked.size;

    const cats = CATEGORIES.map(c => {
      const all = THEORY.filter(t => t.cat === c.id);
      const done = all.filter(t => state.learned.has(t.id)).length;
      const active = state.study.cat === c.id ? 'active' : '';
      return `
        <button class="cat-item ${active}" onclick="setStudyCat('${c.id}')">
          <span class="cat-index">${CAT_INDEX[c.id]}</span>
          <span class="cat-name">${esc(c.name)}</span>
          <span class="cat-count">${done}/${all.length}</span>
        </button>
      `;
    }).join('');

    return `
      <section class="panel">
        <div class="panel-body">
          <label class="panel-title" style="display:block;margin-bottom:8px">Поиск по вопросам</label>
          <div class="input-wrap">
            <span class="input-icon">⌕</span>
            <input id="studySearch" class="input" type="text" value="${esc(state.study.query)}"
              placeholder="Меши, атлас, Figma, Git..."
              oninput="setStudyQuery(this.value)" />
            ${state.study.query ? '<button class="input-clear" onclick="clearStudyQuery()">✕</button>' : ''}
          </div>
          <div class="filter-row" style="margin-top:12px">
            <button class="filter-btn ${state.study.status === 'all' ? 'active' : ''}" onclick="setStudyStatus('all')">Все ${total}</button>
            <button class="filter-btn ${state.study.status === 'bookmarked' ? 'active' : ''}" onclick="setStudyStatus('bookmarked')">В закладках ${bookmarked}</button>
            <button class="filter-btn ${state.study.status === 'unlearned' ? 'active' : ''}" onclick="setStudyStatus('unlearned')">Не изучено ${total - learned}</button>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">Направления</h2>
          <button class="btn btn-sm btn-ghost" onclick="resetStudyProgress()" title="Сбросить отметки">Сброс</button>
        </div>
        <div class="panel-body" style="padding-top:6px;padding-bottom:8px">
          <div class="cat-list">
            <button class="cat-item ${state.study.cat === 'all' ? 'active' : ''}" onclick="setStudyCat('all')">
              <span class="cat-index">00</span>
              <span class="cat-name">Все направления</span>
              <span class="cat-count">${learned}/${total}</span>
            </button>
            ${cats}
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">План подготовки</h2></div>
        <div class="panel-body">
          <div class="row" style="justify-content:space-between;margin-bottom:7px">
            <span class="small muted">Освоено теории</span>
            <span class="small" style="color:var(--ink);font-weight:700">${pct(learned, total)}%</span>
          </div>
          <div class="progress-line" style="margin-bottom:14px"><i style="width:${pct(learned, total)}%"></i></div>
          <div class="stack">
            <div class="row" style="justify-content:space-between">
              <span class="small muted">Вопросов в конспекте</span><b class="small">${total}</b>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="small muted">Тестов в банке</span><b class="small">${TESTS.length}</b>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="small muted">Направлений</span><b class="small">${CATEGORIES.length}</b>
            </div>
            <div class="row" style="justify-content:space-between">
              <span class="small muted">В закладках</span><b class="small">${bookmarked}</b>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function renderTestSidebar() {
    const totalTests = TESTS.length;
    const byCat = CATEGORIES.map(c => ({ c, n: TESTS.filter(t => t.cat === c.id).length }));
    const top = byCat.sort((a, b) => b.n - a.n).slice(0, 6);
    return `
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Банк тестов</h2></div>
        <div class="panel-body">
          <div class="stat-card violet" style="border:0;padding:0;background:transparent">
            <div class="sc-label">Всего тестов</div>
            <div class="sc-value">${totalTests}</div>
            <div class="sc-sub">${CATEGORIES.length} направлений • с вариациями</div>
          </div>
          <div class="divider"></div>
          <div class="stack">
            ${top.map(x => `
              <div class="row" style="justify-content:space-between">
                <span class="small muted">${CAT_INDEX[x.c.id]} · ${esc(x.c.name)}</span>
                <b class="small mono">${x.n}</b>
              </div>
            `).join('')}
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Как это работает</h2></div>
        <div class="panel-body">
          <ol class="small muted" style="margin:0;padding-left:16px;line-height:1.8">
            <li>Выбери направление и уровень.</li>
            <li>Отвечай на вопросы с мгновенной проверкой.</li>
            <li>Читай объяснение к каждому ответу.</li>
            <li>Повторяй только ошибки.</li>
            <li>Следи за прогрессом в статистике.</li>
          </ol>
        </div>
      </section>
    `;
  }

  function renderExamSidebar() {
    return `
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Формат экзамена</h2></div>
        <div class="panel-body stack">
          <div class="row" style="justify-content:space-between"><span class="small muted">Вопросов</span><b class="small">50</b></div>
          <div class="row" style="justify-content:space-between"><span class="small muted">Время</span><b class="small">45 минут</b></div>
          <div class="row" style="justify-content:space-between"><span class="small muted">Проходной балл</span><b class="small">70%</b></div>
          <div class="row" style="justify-content:space-between"><span class="small muted">Проверка</span><b class="small">после сдачи</b></div>
          <div class="divider" style="margin:4px 0"></div>
          <p class="small muted" style="margin:0;line-height:1.7">
            Вопросы берутся из всех ${CATEGORIES.length} направлений. Можно помечать вопросы флажком и возвращаться к ним.
            Ответы нельзя менять после сдачи — как на реальном собеседовании.
          </p>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Перед стартом</h2></div>
        <div class="panel-body">
          <ul class="small muted" style="margin:0;padding-left:16px;line-height:1.8">
            <li>Убери телефон и закрой лишние вкладки.</li>
            <li>Отвечай без подсказок и конспекта.</li>
            <li>Не застревай: флажок и дальше.</li>
            <li>В конце разбери каждую ошибку.</li>
          </ul>
        </div>
      </section>
    `;
  }

  function renderStatsSidebar() {
    const attempts = state.stats.attempts || [];
    const last = attempts[attempts.length - 1];
    return `
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Сводка</h2></div>
        <div class="panel-body stack">
          <div class="row" style="justify-content:space-between"><span class="small muted">Попыток</span><b class="small">${attempts.length}</b></div>
          <div class="row" style="justify-content:space-between"><span class="small muted">Последний результат</span><b class="small">${last ? pct(last.correct, last.total) + '%' : '—'}</b></div>
          <div class="row" style="justify-content:space-between"><span class="small muted">Лучший результат</span><b class="small">${attempts.length ? Math.max(...attempts.map(a => pct(a.correct, a.total))) + '%' : '—'}</b></div>
          <div class="divider" style="margin:4px 0"></div>
          <button class="btn btn-danger btn-sm" onclick="resetAllStats()">Сбросить статистику</button>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Слабые темы</h2></div>
        <div class="panel-body">
          ${renderWeakTopics(true)}
        </div>
      </section>
    `;
  }

  function renderWeakTopics(compact) {
    const weak = weakTopics();
    if (!weak.length) {
      return '<p class="small muted" style="margin:0;line-height:1.6">Пока недостаточно данных. Пройди 2–3 теста, чтобы увидеть слабые темы.</p>';
    }
    return `<div class="stack">${weak.slice(0, compact ? 5 : 20).map(w => `
      <div>
        <div class="row" style="justify-content:space-between;margin-bottom:4px">
          <span class="small" style="color:var(--ink-2)">${CAT_INDEX[w.cat.id]} · ${esc(w.cat.name)}</span>
          <span class="small mono" style="color:var(--red)">${w.accuracy}%</span>
        </div>
        <div class="progress-line" style="height:2px"><i style="width:${w.accuracy}%;background:var(--red)"></i></div>
      </div>
    `).join('')}</div>`;
  }

  function weakTopics() {
    return CATEGORIES.map(c => {
      const s = state.stats.perCat[c.id];
      if (!s || s.answered < 3) return null;
      return { cat: c, accuracy: pct(s.correct, s.answered), answered: s.answered };
    }).filter(Boolean).sort((a, b) => a.accuracy - b.accuracy);
  }

  /* ============================================================
     STUDY
     ============================================================ */
  function filteredTheory() {
    const q = state.study.query.trim().toLowerCase();
    return THEORY.filter(t => {
      if (state.study.cat !== 'all' && t.cat !== state.study.cat) return false;
      if (state.study.level !== 'all' && t.lvl !== state.study.level) return false;
      if (state.study.status === 'bookmarked' && !state.bookmarked.has(t.id)) return false;
      if (state.study.status === 'unlearned' && state.learned.has(t.id)) return false;
      if (state.study.status === 'learned' && !state.learned.has(t.id)) return false;
      if (q) {
        const hay = [t.q, t.a, t.d, t.tip, catName(t.cat), theoryTags(t)].join(' ').toLowerCase();
        if (!matchesQuery(hay, q)) return false;
      }
      return true;
    });
  }

  function testsForQuery(query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return [];
    return TESTS.filter(t => {
      const theory = THEORY_BY_ID[t.concept];
      const hay = [t.q, t.e, catName(t.cat), theory ? theoryTags(theory) : '', ...(t.o || [])].join(' ').toLowerCase();
      return matchesQuery(hay, q);
    });
  }

  function renderStudyMain() {
    const showSections = state.study.view === 'sections' &&
      state.study.cat === 'all' &&
      state.study.status === 'all' &&
      !state.study.query.trim();

    return showSections ? renderStudySections() : renderStudyList();
  }

  function renderStudySections() {
    const total = THEORY.length;
    const learned = [...state.learned].filter(id => THEORY_BY_ID[id]).length;
    const bookmarked = state.bookmarked.size;
    const last = state.study.lastId ? THEORY_BY_ID[state.study.lastId] : null;

    const renderCard = (c) => {
      const all = THEORY.filter(t => t.cat === c.id && (state.study.level === 'all' || t.lvl === state.study.level));
      const done = all.filter(t => state.learned.has(t.id)).length;
      const tests = TESTS.filter(t => t.cat === c.id).length;
      const p = pct(done, all.length);
      const isLast = last && last.cat === c.id;
      const isFirst = c.id === CATEGORIES[0].id;
      const isFinal = c.id === CATEGORIES[CATEGORIES.length - 1].id;
      return `
        <button class="section-card ${isLast ? 'has-resume' : ''}" onclick="openSection('${c.id}')">
          <div class="section-card-head">
            <span class="section-index">${CAT_INDEX[c.id]}</span>
            <span class="section-progress-label">${isFirst ? 'Старт' : isFinal ? 'Финиш' : done + '/' + all.length}</span>
          </div>
          <h3>${esc(c.name)}</h3>
          <p>${esc(c.desc || '')}</p>
          <div class="section-progress"><i style="width:${p}%"></i></div>
          <div class="section-card-foot">
            <span>${tests} тестов</span>
            <span>${isLast ? 'Вы остановились здесь' : (isFirst ? 'Начни здесь' : isFinal ? 'Финальная практика' : p + '%')}</span>
          </div>
        </button>
      `;
    };

    const stages = [...new Set(CATEGORIES.map(c => c.stage || 'Другое'))];
    const stageBlocks = stages.map(stage => {
      const cards = CATEGORIES
        .filter(c => (c.stage || 'Другое') === stage)
        .map(renderCard)
        .join('');
      if (!cards) return '';
      return `
        <div class="stage-block">
          <div class="stage-head">
            <span class="stage-label">${esc(stage)}</span>
            <span class="stage-line"></span>
          </div>
          <div class="section-grid">${cards}</div>
        </div>
      `;
    }).join('');

    return `
      <section class="section-hero">
        <span class="eyebrow">Конспект · порядок обучения</span>
        <h2>Выбери раздел</h2>
        <p>${total} вопросов по ${CATEGORIES.length} направлениям. Иди по порядку: База → Продакшн-арт → Движок и интерфейс → Контекст → Дополнительно → Оффер. В конце — интервью-практика.</p>
        <div class="hero-badges">
          <span class="hero-badge">Вопросов <b>${total}</b></span>
          <span class="hero-badge">Тестов <b>${TESTS.length}</b></span>
          <span class="hero-badge">Разделов <b>${CATEGORIES.length}</b></span>
          <span class="hero-badge">Изучено <b>${learned}</b></span>
          <span class="hero-badge">В закладках <b>${bookmarked}</b></span>
        </div>
      </section>

      ${last ? `
        <section class="resume-banner">
          <div class="resume-text">
            <span class="eyebrow">Вы остановились здесь</span>
            <h3>${last.id} · ${esc(catName(last.cat))}</h3>
            <p>${esc(last.q)}</p>
          </div>
          <button class="btn btn-primary" onclick="resumeStudy()">Продолжить</button>
        </section>
      ` : ''}

      <section class="panel">
        <div class="panel-body">
          <div class="row" style="justify-content:space-between">
            <div class="input-wrap" style="flex:1;min-width:200px;max-width:460px">
              <span class="input-icon">⌕</span>
              <input class="input" type="text" value="${esc(state.study.query)}"
                placeholder="Найти вопрос по всем разделам..."
                oninput="setStudyQuery(this.value)" />
            </div>
            <div class="row">
              <div class="segmented">
                <button class="${state.study.level === 'all' ? 'active' : ''}" onclick="setStudyLevel('all')">Все</button>
                <button class="${state.study.level === 'J' ? 'active' : ''}" onclick="setStudyLevel('J')">J</button>
                <button class="${state.study.level === 'J+' ? 'active' : ''}" onclick="setStudyLevel('J+')">J+</button>
                <button class="${state.study.level === 'M' ? 'active' : ''}" onclick="setStudyLevel('M')">M</button>
              </div>
              <button class="btn btn-sm mobile-only" onclick="toggleMobileSidebar()">Фильтры</button>
            </div>
          </div>
        </div>
      </section>

      ${stageBlocks}
    `;
  }

  function renderStudyList() {
    const list = filteredTheory();
    const testMatches = state.study.query.trim() ? testsForQuery(state.study.query) : [];
    const totalPages = Math.max(1, Math.ceil(list.length / state.study.perPage));
    if (state.study.page > totalPages) state.study.page = totalPages;
    const start = (state.study.page - 1) * state.study.perPage;
    const shown = list.slice(start, start + state.study.perPage);

    let title = 'Все вопросы';
    if (state.study.query.trim()) title = `Поиск: «${state.study.query.trim()}»`;
    else if (state.study.status === 'bookmarked') title = 'В закладках';
    else if (state.study.status === 'unlearned') title = 'Не изучено';
    else if (state.study.cat !== 'all') title = catName(state.study.cat);

    const cards = shown.length ? shown.map(renderTheoryCard).join('') : `
      <div class="empty-state">
        <div class="big">—</div>
        <h3>Ничего не найдено</h3>
        <p>Сбрось фильтры или измени поисковый запрос.</p>
        <button class="btn btn-primary" onclick="resetStudyFilters()">Показать все разделы</button>
      </div>
    `;

    return `
      <div class="row" style="justify-content:space-between">
        <button class="btn btn-sm btn-ghost" onclick="backToSections()">← Все разделы</button>
        <span class="small muted">${title}</span>
      </div>

      <section class="panel">
        <div class="panel-body">
          <div class="input-wrap">
            <span class="input-icon">⌕</span>
            <input id="studySearchMain" class="input" type="text" value="${esc(state.study.query)}"
              placeholder="Искать по вопросам, ответам и тестам..."
              oninput="setStudyQuery(this.value)" />
            ${state.study.query ? '<button class="input-clear" onclick="clearStudyQuery()">✕</button>' : ''}
          </div>
          <div class="row" style="justify-content:space-between;margin-top:10px">
            <span class="small muted">${list.length} вопросов · ${testMatches.length} тестов · стр. ${state.study.page} из ${totalPages}</span>
            <div class="row">
              <div class="segmented">
                <button class="${state.study.level === 'all' ? 'active' : ''}" onclick="setStudyLevel('all')">Все</button>
                <button class="${state.study.level === 'J' ? 'active' : ''}" onclick="setStudyLevel('J')">J</button>
                <button class="${state.study.level === 'J+' ? 'active' : ''}" onclick="setStudyLevel('J+')">J+</button>
                <button class="${state.study.level === 'M' ? 'active' : ''}" onclick="setStudyLevel('M')">M</button>
              </div>
              <label class="small muted" style="display:flex;align-items:center;gap:5px">
                На странице
                <select class="page-select" onchange="setStudyPerPage(this.value)">
                  ${[10, 20, 50, 100].map(n => `<option value="${n}" ${state.study.perPage === n ? 'selected' : ''}>${n}</option>`).join('')}
                </select>
              </label>
              <button class="btn btn-sm ${state.study.hide ? 'btn-amber' : ''}" onclick="toggleStudyHide()">
                ${state.study.hide ? 'Показать ответы' : 'Скрыть ответы'}
              </button>
            </div>
          </div>
        </div>
      </section>

      ${testMatches.length ? `
        <section class="panel">
          <div class="panel-head">
            <h2 class="panel-title">Тесты по запросу</h2>
            <span class="badge badge-muted">${testMatches.length}</span>
          </div>
          <div class="panel-body">
            <div class="row" style="justify-content:space-between;margin-bottom:10px">
              <span class="small muted">Можно сразу проверить тему в тестовом формате.</span>
              <button class="btn btn-sm btn-primary" onclick="startSearchTest()">Пройти тест · ${Math.min(20, testMatches.length)}</button>
            </div>
            <div class="search-test-list">
              ${testMatches.slice(0, 3).map(t => `
                <div class="search-test-item">
                  <span class="badge badge-cat">${CAT_INDEX[t.cat]} · ${esc(catName(t.cat))}</span>
                  <span class="small">${highlight(t.q, state.study.query)}</span>
                </div>
              `).join('')}
            </div>
          </div>
        </section>
      ` : ''}

      ${renderPager(totalPages)}

      <div class="stack" style="gap:14px">${cards}</div>

      ${renderPager(totalPages)}
    `;
  }

  function renderPager(totalPages) {
    if (totalPages <= 1) return '';
    const cur = state.study.page;
    const nums = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) nums.push(i);
    } else {
      nums.push(1);
      if (cur > 3) nums.push('...');
      for (let i = Math.max(2, cur - 1); i <= Math.min(totalPages - 1, cur + 1); i++) nums.push(i);
      if (cur < totalPages - 2) nums.push('...');
      nums.push(totalPages);
    }
    return `
      <div class="pagination">
        <button class="page-btn" onclick="setStudyPage(${cur - 1})" ${cur === 1 ? 'disabled' : ''}>←</button>
        ${nums.map(n => n === '...'
          ? '<span class="page-dots">…</span>'
          : `<button class="page-btn ${n === cur ? 'active' : ''}" onclick="setStudyPage(${n})">${n}</button>`).join('')}
        <button class="page-btn" onclick="setStudyPage(${cur + 1})" ${cur === totalPages ? 'disabled' : ''}>→</button>
      </div>
    `;
  }

  function renderTheoryCard(t) {
    const isLearned = state.learned.has(t.id);
    const isBookmarked = state.bookmarked.has(t.id);
    const hidden = state.study.hide && !state.study.revealed.has(t.id);
    const related = (TESTS_BY_CONCEPT[t.id] || []).length;

    let answers = '';
    if (!hidden) {
      if (t.d) {
        answers = `
          <div class="answer-grid">
            <div class="answer-block short">
              <div class="answer-label">Короткий ответ</div>
              <p class="answer-text">${esc(t.a)}</p>
            </div>
            <div class="answer-block deep">
              <div class="answer-label">Глубже для strong junior</div>
              <p class="answer-text">${esc(t.d)}</p>
            </div>
          </div>
        `;
      } else {
        answers = `
          <div class="answer-block short">
            <div class="answer-label">Ключевой ответ</div>
            <p class="answer-text">${esc(t.a)}</p>
          </div>
        `;
      }
    } else {
      answers = `
        <div class="hidden-answer">
          <p>Сначала ответь вслух, как на реальном собеседовании. Потом открой шпаргалку.</p>
          <button class="btn btn-primary" onclick="revealTheory('${t.id}')">Показать ответ</button>
        </div>
      `;
    }

    return `
      <article class="q-card ${isLearned ? 'learned' : ''} ${isBookmarked ? 'bookmarked' : ''}" data-id="${t.id}">
        <div class="q-top">
          <span class="badge badge-cat">${CAT_INDEX[t.cat]} · ${esc(catName(t.cat))}</span>
          ${levelBadge(t.lvl)}
          <span class="q-id">${t.id}</span>
          ${state.study.lastId === t.id ? '<span class="badge badge-muted">Вы здесь</span>' : ''}
        </div>
        <div class="q-body">
          <h3 class="q-title">${highlight(t.q, state.study.query)}</h3>
          ${answers}
          ${t.tip ? `
            <div class="tip-block">
              <p><b>Связь с опытом:</b> ${esc(t.tip)}</p>
            </div>
          ` : ''}
          <div class="q-actions">
            ${related ? `<button class="btn btn-sm" onclick="startConceptTest('${t.id}')">Тест по теме · ${related}</button>` : ''}
            ${!hidden && state.study.hide ? `<button class="btn btn-sm btn-ghost" onclick="revealTheory('${t.id}')">Скрыть ответ</button>` : ''}
            <span class="right"></span>
            <button class="meta-action ${isBookmarked ? 'active' : ''}" onclick="toggleBookmark('${t.id}')">${isBookmarked ? '★ В закладках' : '☆ В закладки'}</button>
            <button class="meta-action ${isLearned ? 'active' : ''}" onclick="toggleLearned('${t.id}')">${isLearned ? '✓ Изучено' : 'Отметить изученным'}</button>
          </div>
        </div>
      </article>
    `;
  }

  window.setMode = function (mode) {
    if (mode === state.mode) return;
    if (state.mode === 'test' && state.test.screen === 'running') stopTestTimer();
    if (state.mode === 'exam' && state.exam.screen === 'running') stopExamTimer();
    if (state.mode === 'mock' && state.mock.screen === 'running') stopMockTimer();
    state.mode = mode;
    if (mode === 'test' && state.test.screen === 'running') startTestTimer();
    if (mode === 'exam' && state.exam.screen === 'running') startExamTimer();
    if (mode === 'mock' && state.mock.screen === 'running') startMockTimer();
    saveSaved();
    closeMobileSidebar();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function closeMobileSidebar() {
    if (window.innerWidth <= 900) {
      const sb = document.getElementById('sidebar');
      if (sb) sb.classList.remove('open');
    }
  }

  window.toggleMobileSidebar = function () {
    const sb = document.getElementById('sidebar');
    if (sb) sb.classList.toggle('open');
  };

  window.setStudyCat = function (id) {
    state.study.cat = id;
    state.study.view = (id === 'all' && state.study.status === 'all' && !state.study.query.trim()) ? 'sections' : 'list';
    state.study.page = 1;
    state.study.revealed.clear();
    saveSaved();
    closeMobileSidebar();
    render();
  };

  window.setStudyLevel = function (lvl) {
    state.study.level = lvl;
    state.study.page = 1;
    state.study.revealed.clear();
    saveSaved();
    closeMobileSidebar();
    render();
  };

  window.setStudyStatus = function (s) {
    state.study.status = s;
    state.study.view = (s === 'all' && state.study.cat === 'all' && !state.study.query.trim()) ? 'sections' : 'list';
    state.study.page = 1;
    saveSaved();
    closeMobileSidebar();
    render();
  };

  window.setStudyQuery = function (v) {
    state.study.query = v;
    state.study.view = v.trim() ? 'list' : (state.study.cat === 'all' && state.study.status === 'all' ? 'sections' : 'list');
    state.study.page = 1;
    saveSaved();
    render();
    const input = [...document.querySelectorAll('#studySearch, #studySearchMain')].find(el => el.offsetParent !== null);
    if (input) {
      input.focus();
      input.setSelectionRange(v.length, v.length);
    }
  };

  window.clearStudyQuery = function () {
    state.study.query = '';
    state.study.view = (state.study.cat === 'all' && state.study.status === 'all') ? 'sections' : 'list';
    state.study.page = 1;
    saveSaved();
    render();
  };

  window.toggleStudyHide = function () {
    state.study.hide = !state.study.hide;
    state.study.revealed.clear();
    render();
  };

  window.revealTheory = function (id) {
    if (state.study.revealed.has(id)) state.study.revealed.delete(id);
    else state.study.revealed.add(id);
    render();
  };

  window.toggleLearned = function (id) {
    if (state.learned.has(id)) state.learned.delete(id);
    else state.learned.add(id);
    saveSaved();
    render();
  };

  window.toggleBookmark = function (id) {
    if (state.bookmarked.has(id)) state.bookmarked.delete(id);
    else state.bookmarked.add(id);
    saveSaved();
    render();
  };

  window.openSection = function (id) {
    state.study.cat = id;
    state.study.view = 'list';
    state.study.page = 1;
    state.study.query = '';
    state.study.status = 'all';
    saveSaved();
    closeMobileSidebar();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  window.backToSections = function () {
    state.study.cat = 'all';
    state.study.view = 'sections';
    state.study.page = 1;
    state.study.query = '';
    state.study.status = 'all';
    saveSaved();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  window.setStudyPage = function (n) {
    const list = filteredTheory();
    const totalPages = Math.max(1, Math.ceil(list.length / state.study.perPage));
    state.study.page = Math.min(Math.max(1, n), totalPages);
    saveSaved();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  window.setStudyPerPage = function (n) {
    state.study.perPage = Number(n) || 20;
    state.study.page = 1;
    saveSaved();
    render();
  };

  window.resumeStudy = function () {
    const t = THEORY_BY_ID[state.study.lastId];
    if (!t) { toast('Нет сохранённой позиции'); return; }
    state.study.cat = t.cat;
    state.study.level = 'all';
    state.study.status = 'all';
    state.study.query = '';
    state.study.view = 'list';
    const list = filteredTheory();
    const idx = list.findIndex(x => x.id === t.id);
    state.study.page = Math.max(1, Math.floor(idx / state.study.perPage) + 1);
    saveSaved();
    render();
    setTimeout(() => {
      const el = document.querySelector(`.q-card[data-id="${t.id}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('resume');
        setTimeout(() => el.classList.remove('resume'), 2600);
      }
    }, 80);
  };

  window.resetStudyFilters = function () {
    state.study.cat = 'all';
    state.study.level = 'all';
    state.study.status = 'all';
    state.study.query = '';
    state.study.view = 'sections';
    state.study.page = 1;
    saveSaved();
    render();
  };

  window.resetStudyProgress = function () {
    if (!confirm('Сбросить отметки «Изучено» и «В закладках»?')) return;
    state.learned.clear();
    state.bookmarked.clear();
    saveSaved();
    render();
    toast('Отметки сброшены');
  };

  window.startConceptTest = function (conceptId) {
    const pool = TESTS_BY_CONCEPT[conceptId] || [];
    if (!pool.length) { toast('По этой теме пока нет тестов'); return; }
    const theory = THEORY_BY_ID[conceptId];
    const questions = shuffle(pool).slice(0, Math.min(10, pool.length)).map(q => prepareQuestion(q));
    beginTest({
      config: { cat: theory ? theory.cat : 'search', level: 'all', count: questions.length, unique: false, shuffleOptions: true },
      questions
    });
  };

  window.startSearchTest = function () {
    const q = state.study.query.trim();
    if (!q) { toast('Введите поисковый запрос'); return; }
    const pool = testsForQuery(q);
    if (!pool.length) { toast('По запросу нет тестов'); return; }
    const questions = shuffle(pool).slice(0, Math.min(20, pool.length)).map(item => prepareQuestion(item));
    beginTest({
      config: { cat: 'search', level: 'all', count: questions.length, unique: false, shuffleOptions: true, query: q },
      questions
    });
  };

  /* ============================================================
     TEST
     ============================================================ */
  function prepareQuestion(q) {
    const correctSet = new Set(Array.isArray(q.a) ? q.a : [q.a]);
    const options = q.o.map((text, idx) => ({ text, correct: correctSet.has(idx) }));
    const shuffled = shuffle(options);
    return {
      id: q.id,
      cat: q.cat,
      lvl: q.lvl,
      concept: q.concept,
      var: q.var,
      q: q.q,
      e: q.e,
      multi: Array.isArray(q.a),
      options: shuffled,
      correctIndices: shuffled.map((o, i) => o.correct ? i : -1).filter(i => i >= 0),
      correctIndex: shuffled.findIndex(o => o.correct)
    };
  }

  function isAnswerCorrect(q, picked) {
    const sel = picked || [];
    return sel.length === q.correctIndices.length &&
           sel.every(i => q.correctIndices.includes(i));
  }

  function buildTestPool(config) {
    const q = (config.query || '').trim().toLowerCase();
    const selectedCats = (config.cats && config.cats.length) ? config.cats : null;
    let pool = TESTS.filter(t => {
      const catOk = selectedCats
        ? selectedCats.includes(t.cat)
        : (config.cat === 'all' || config.cat === 'search' || t.cat === config.cat);
      const levelOk = config.level === 'all' || t.lvl === config.level;
      const queryOk = !q || matchesQuery([t.q, t.e, catName(t.cat), theoryTags(THEORY_BY_ID[t.concept] || { id: '' }), ...(t.o || [])].join(' ').toLowerCase(), q);
      return catOk && levelOk && queryOk;
    });

    if (config.unique) {
      const byConcept = {};
      pool.forEach(t => {
        if (!byConcept[t.concept]) byConcept[t.concept] = [];
        byConcept[t.concept].push(t);
      });
      pool = Object.values(byConcept).map(arr => arr[Math.floor(Math.random() * arr.length)]);
    }

    pool = shuffle(pool);
    if (config.count !== 'all') pool = pool.slice(0, Math.min(Number(config.count), pool.length));
    return pool.map(prepareQuestion);
  }

  function countPool(cat, level, unique, query, cats) {
    const q = (query || '').trim().toLowerCase();
    const selectedCats = (cats && cats.length) ? cats : null;
    let pool = TESTS.filter(t => {
      const catOk = selectedCats
        ? selectedCats.includes(t.cat)
        : (cat === 'all' || cat === 'search' || t.cat === cat);
      const levelOk = level === 'all' || t.lvl === level;
      const queryOk = !q || matchesQuery([t.q, t.e, catName(t.cat), theoryTags(THEORY_BY_ID[t.concept] || { id: '' }), ...(t.o || [])].join(' ').toLowerCase(), q);
      return catOk && levelOk && queryOk;
    });
    if (unique) pool = [...new Set(pool.map(t => t.concept))];
    return pool.length;
  }

  function beginTest({ config, questions }) {
    stopTestTimer();
    state.test = {
      screen: 'running',
      config,
      questions,
      index: 0,
      answers: new Array(questions.length).fill(null),
      multiSelection: [],
      startedAt: Date.now(),
      elapsed: 0,
      timer: null,
      recorded: false
    };
    state.mode = 'test';
    startTestTimer();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  window.startTest = function () {
    const config = { ...state.test.config };
    const questions = buildTestPool(config);
    if (!questions.length) { toast('Нет вопросов под выбранные фильтры'); return; }
    beginTest({ config, questions });
  };

  window.toggleTestCat = function (cat) {
    const cfg = state.test.config;
    const set = new Set(cfg.cats || []);
    if (set.has(cat)) set.delete(cat);
    else set.add(cat);
    cfg.cats = [...set];
    cfg.cat = cfg.cats.length ? 'multi' : 'all';
    render();
  };

  window.clearTestCats = function () {
    state.test.config.cats = [];
    state.test.config.cat = 'all';
    render();
  };

  window.setTestCat = function (cat) {
    state.test.config.cats = cat === 'all' ? [] : [cat];
    state.test.config.cat = cat;
    render();
  };

  window.setTestQuery = function (query) {
    state.test.config.query = query;
    render();
    const input = document.getElementById('testSearchInput');
    if (input) {
      input.focus();
      input.setSelectionRange(query.length, query.length);
    }
  };

  window.setTestLevel = function (level) {
    state.test.config.level = level;
    render();
  };

  window.setTestCount = function (count) {
    state.test.config.count = count;
    render();
  };

  window.toggleTestUnique = function () {
    state.test.config.unique = !state.test.config.unique;
    render();
  };

  window.toggleTestShuffle = function () {
    state.test.config.shuffleOptions = !state.test.config.shuffleOptions;
    render();
  };

  window.exitTest = function () {
    if (!confirm('Выйти из теста? Текущий прогресс не сохранится.')) return;
    stopTestTimer();
    state.test.screen = 'setup';
    render();
  };

  window.pickOption = function (i) {
    const t = state.test;
    if (t.answers[t.index]) return;
    const q = t.questions[t.index];
    if (q.multi) toggleMultiOption(i);
    else answerTest(i);
  };

  window.answerTest = function (picked) {
    const t = state.test;
    if (t.answers[t.index]) return;
    const q = t.questions[t.index];
    const correct = picked === q.correctIndex;
    t.answers[t.index] = { picked: [picked], correct, multi: false };
    t.multiSelection = [];
    recordAnswer(q, correct);
    saveSaved();
    renderMain();
  };

  function toggleMultiOption(i) {
    const t = state.test;
    if (t.answers[t.index]) return;
    const set = new Set(t.multiSelection || []);
    if (set.has(i)) set.delete(i);
    else set.add(i);
    t.multiSelection = [...set].sort((a, b) => a - b);
    renderMain();
  }

  window.submitMultiAnswer = function () {
    const t = state.test;
    if (t.answers[t.index]) return;
    const q = t.questions[t.index];
    const picked = (t.multiSelection || []).slice().sort((a, b) => a - b);
    if (!picked.length) { toast('Выбери хотя бы один вариант'); return; }
    const correct = picked.length === q.correctIndices.length &&
                    picked.every(i => q.correctIndices.includes(i));
    t.answers[t.index] = { picked, correct, multi: true };
    t.multiSelection = [];
    recordAnswer(q, correct);
    saveSaved();
    renderMain();
  };

  window.nextTestQuestion = function () {
    const t = state.test;
    if (!t.answers[t.index]) return;
    if (t.index < t.questions.length - 1) {
      t.index++;
      t.multiSelection = [];
      renderMain();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      finishTest();
    }
  };

  function finishTest() {
    stopTestTimer();
    const t = state.test;
    if (!t.recorded) {
      t.recorded = true;
      const correct = t.answers.filter(a => a && a.correct).length;
      pushAttempt('test', correct, t.questions.length, t.elapsed);
    }
    t.screen = 'result';
    saveSaved();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  window.finishTestNow = function () {
    if (!confirm('Завершить тест досрочно и увидеть результат?')) return;
    finishTest();
  };

  window.retryWrongTest = function () {
    const t = state.test;
    const wrong = [];
    t.questions.forEach((q, i) => {
      if (!t.answers[i] || !t.answers[i].correct) wrong.push(q);
    });
    if (!wrong.length) { toast('Ошибок нет — отличная работа!'); return; }
    beginTest({
      config: { ...t.config, count: wrong.length, conceptRetry: true },
      questions: shuffle(wrong)
    });
  };

  window.newTest = function () {
    stopTestTimer();
    state.test.screen = 'setup';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function startTestTimer() {
    stopTestTimer();
    state.test.timer = setInterval(() => {
      state.test.elapsed++;
      document.querySelectorAll('.js-test-timer').forEach(el => {
        el.textContent = fmtTime(state.test.elapsed);
      });
    }, 1000);
  }

  function stopTestTimer() {
    if (state.test.timer) {
      clearInterval(state.test.timer);
      state.test.timer = null;
    }
  }

  function renderTestMain() {
    if (state.test.screen === 'setup') return renderTestSetup();
    if (state.test.screen === 'running') return renderTestRunner();
    return renderTestResult();
  }

  function renderTestSetup() {
    const cfg = state.test.config;
    const selectedCats = cfg.cats || [];
    const available = countPool(cfg.cat, cfg.level, cfg.unique, cfg.query, selectedCats);
    const counts = [10, 20, 30, 50, 100, 200, 'all'];

    const catCards = CATEGORIES.map(c => {
      const n = countPool(c.id, cfg.level, cfg.unique, cfg.query);
      const active = selectedCats.includes(c.id) || (!selectedCats.length && cfg.cat === c.id);
      return `
        <button class="setup-card ${active ? 'active' : ''}" onclick="toggleTestCat('${c.id}')">
          <div class="sc-icon">${CAT_INDEX[c.id]}</div>
          <div class="sc-name">${esc(c.name)}</div>
          <div class="sc-meta">${n}</div>
        </button>
      `;
    }).join('');

    return `
      <section class="section-hero">
        <span class="eyebrow">Тесты · мгновенная проверка</span>
        <h2>Проверь себя по каждому направлению</h2>
        <p>${TESTS.length} тестов с вариантами ответов и объяснениями. Выбери направление, уровень и количество — тренажёр соберёт случайный набор и покажет, где есть пробелы.</p>
        <div class="hero-badges">
          <span class="hero-badge">Тестов <b>${TESTS.length}</b></span>
          <span class="hero-badge">Тем <b>${new Set(TESTS.map(t => t.concept)).size}</b></span>
          <span class="hero-badge">Вариантов на тему <b>${(TESTS.length / Math.max(1, new Set(TESTS.map(t => t.concept)).size)).toFixed(1)}</b></span>
          <span class="hero-badge">Проходной балл <b>70%</b></span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-body">
          <div class="input-wrap">
            <span class="input-icon">⌕</span>
            <input class="input" id="testSearchInput" type="text" value="${esc(cfg.query || '')}"
              placeholder="Найти тест по термину: меши, PMA, 9-slice, Git..."
              oninput="setTestQuery(this.value)" />
            ${cfg.query ? '<button class="input-clear" onclick="setTestQuery(\'\')">✕</button>' : ''}
          </div>
          ${cfg.query ? `<p class="small muted" style="margin:8px 0 0">Найдено тестов: ${available}. Категории ниже показывают количество с учётом поиска.</p>` : ''}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">1. Направления</h2>
          <div class="row">
            <span class="badge badge-muted">${selectedCats.length ? selectedCats.length + ' выбрано' : available + (cfg.unique ? ' тем' : ' доступно')}</span>
            ${selectedCats.length ? '<button class="btn btn-sm btn-ghost" onclick="clearTestCats()">Сбросить</button>' : ''}
          </div>
        </div>
        <div class="panel-body">
          <div class="setup-grid">
            <button class="setup-card all-card ${!selectedCats.length && cfg.cat === 'all' ? 'active' : ''}" onclick="clearTestCats()">
              <div class="sc-icon">00</div>
              <div class="sc-body">
                <div class="sc-name">Все направления</div>
                <div class="sc-meta">случайный микс из ${CATEGORIES.length} блоков</div>
              </div>
            </button>
            ${catCards}
          </div>
          <p class="small muted" style="margin:10px 0 0">Можно выбрать несколько направлений — вопросы смешаются в один тест.</p>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">2. Параметры теста</h2></div>
        <div class="panel-body">
          <div class="setup-row">
            <div>
              <div class="setup-label">Уровень сложности</div>
              <div class="setup-hint">J — база, J+ — strong junior, M — запас на рост</div>
            </div>
            <div class="setup-control">
              <div class="segmented">
                <button class="${cfg.level === 'all' ? 'active' : ''}" onclick="setTestLevel('all')">Все</button>
                <button class="${cfg.level === 'J' ? 'active' : ''}" onclick="setTestLevel('J')">J</button>
                <button class="${cfg.level === 'J+' ? 'active' : ''}" onclick="setTestLevel('J+')">J+</button>
                <button class="${cfg.level === 'M' ? 'active' : ''}" onclick="setTestLevel('M')">M</button>
              </div>
            </div>
          </div>
          <div class="setup-row">
            <div>
              <div class="setup-label">Количество вопросов</div>
              <div class="setup-hint">Доступно с учётом фильтров: ${available}</div>
            </div>
            <div class="setup-control">
              <div class="segmented">
                ${counts.map(c => `
                  <button class="${String(cfg.count) === String(c) ? 'active' : ''}" onclick="setTestCount('${c}')">${c === 'all' ? 'Все' : c}</button>
                `).join('')}
              </div>
            </div>
          </div>
          <div class="setup-row">
            <div>
              <div class="setup-label">Не повторять вариации</div>
              <div class="setup-hint">Одна формулировка на тему — шире охват</div>
            </div>
            <div class="setup-control">
              <label class="toggle">
                <input type="checkbox" ${cfg.unique ? 'checked' : ''} onchange="toggleTestUnique()" />
                <span class="track"></span>
                <span class="toggle-text">${cfg.unique ? 'Включено' : 'Выключено'}</span>
              </label>
            </div>
          </div>
          <div class="setup-row">
            <div>
              <div class="setup-label">Перемешивать варианты ответов</div>
              <div class="setup-hint">Правильный ответ не остаётся на одном месте</div>
            </div>
            <div class="setup-control">
              <label class="toggle">
                <input type="checkbox" ${cfg.shuffleOptions ? 'checked' : ''} onchange="toggleTestShuffle()" />
                <span class="track"></span>
                <span class="toggle-text">${cfg.shuffleOptions ? 'Включено' : 'Выключено'}</span>
              </label>
            </div>
          </div>
        </div>
      </section>

      <div class="row" style="justify-content:space-between">
        <span class="small muted">Будет собрано: <b style="color:var(--text)">${cfg.count === 'all' ? available : Math.min(Number(cfg.count), available)}</b> вопросов</span>
        <button class="btn btn-primary btn-lg" onclick="startTest()">▶ Начать тест</button>
      </div>
    `;
  }

  function renderTestRunner() {
    const t = state.test;
    const q = t.questions[t.index];
    const ans = t.answers[t.index];
    const answered = !!ans;
    const total = t.questions.length;
    const p = pct(t.index + (answered ? 1 : 0), total);
    const isMulti = !!q.multi;
    const selectedNow = t.multiSelection || [];

    const options = q.options.map((o, i) => {
      let cls = '';
      if (answered) {
        if (q.correctIndices.includes(i)) cls = 'correct';
        else if (ans.picked.includes(i)) cls = 'wrong';
        else cls = 'dim';
      } else if (isMulti && selectedNow.includes(i)) {
        cls = 'selected';
      }
      return `
        <button class="option ${cls}" ${answered ? 'disabled' : ''} onclick="pickOption(${i})">
          <span class="option-key">${String.fromCharCode(65 + i)}</span>
          <span>${esc(o.text)}</span>
        </button>
      `;
    }).join('');

    const feedback = answered ? `
      <div class="feedback ${ans.correct ? 'ok' : 'bad'}">
        <div class="feedback-head">${ans.correct ? 'Верно' : 'Неверно'}</div>
        <p><span class="explain-label">Разбор:</span> ${esc(q.e)}</p>
      </div>
    ` : '';

    let actions = '';
    if (answered) {
      actions = `
        <span class="kbd-hint">Enter — дальше</span>
        <span class="right"></span>
        <button class="btn btn-sm btn-ghost" onclick="finishTestNow()">Завершить досрочно</button>
        <button class="btn btn-primary" onclick="nextTestQuestion()">
          ${t.index < total - 1 ? 'Дальше' : 'Показать результат'}
        </button>
      `;
    } else if (isMulti) {
      actions = `
        <span class="kbd-hint">Можно выбрать несколько вариантов</span>
        <span class="right"></span>
        <button class="btn btn-sm btn-ghost" onclick="finishTestNow()">Завершить досрочно</button>
        <button class="btn btn-primary" onclick="submitMultiAnswer()" ${selectedNow.length ? '' : 'disabled'}>Проверить</button>
      `;
    } else {
      actions = `
        <span class="kbd-hint">Выбери ответ или нажми <span class="kbd">1</span>–<span class="kbd">4</span></span>
        <span class="right"></span>
        <button class="btn btn-sm btn-ghost" onclick="finishTestNow()">Завершить досрочно</button>
      `;
    }

    return `
      <div class="runner-top">
        <div>
          <div class="rt-title">${CAT_INDEX[q.cat]} · ${esc(catName(q.cat))}</div>
          <div class="rt-sub">Вопрос ${t.index + 1} из ${total} · ${levelShort(q.lvl)}${q.var > 1 ? ' · вариант ' + q.var : ''}</div>
        </div>
        <span class="spacer"></span>
        <span class="timer js-test-timer">${fmtTime(t.elapsed)}</span>
        <button class="btn btn-sm btn-ghost" onclick="exitTest()">Выйти</button>
      </div>

      <div class="progress-line"><i style="width:${p}%"></i></div>

      <section class="panel question-panel fade-in">
        <div class="question-meta">
          <span class="badge badge-cat">${CAT_INDEX[q.cat]} · ${esc(catName(q.cat))}</span>
          ${levelBadge(q.lvl)}
          ${q.var > 1 ? `<span class="badge badge-var">Вариация ${q.var}</span>` : ''}
          ${isMulti ? '<span class="badge badge-var">Несколько ответов</span>' : ''}
          <span class="q-id">${q.id}</span>
        </div>
        <h2 class="question-text">${esc(q.q)}</h2>
        <div class="options">${options}</div>
        ${feedback}
        <div class="runner-actions">${actions}</div>
      </section>
    `;
  }

  function renderTestResult() {
    const t = state.test;
    const total = t.questions.length;
    const correct = t.answers.filter(a => a && a.correct).length;
    const p = pct(correct, total);
    const ringCls = p >= 85 ? '' : p >= 60 ? 'mid' : 'low';
    const msg = p >= 90 ? 'Отличный результат — уровень уверенного strong junior!' :
                p >= 75 ? 'Хороший результат. Осталось закрыть точечные пробелы.' :
                p >= 60 ? 'База есть, но есть темы, которые стоит повторить.' :
                'Пока есть заметные пробелы. Разбери ошибки и пройди ещё раз.';

    const byCat = {};
    t.questions.forEach((q, i) => {
      if (!byCat[q.cat]) byCat[q.cat] = { total: 0, correct: 0 };
      byCat[q.cat].total++;
      if (t.answers[i] && t.answers[i].correct) byCat[q.cat].correct++;
    });

    const breakdown = Object.entries(byCat).map(([cat, s]) => `
      <div class="breakdown-row">
        <span class="breakdown-name">${CAT_INDEX[cat]} · ${esc(catName(cat))}</span>
        <span class="breakdown-bar"><i style="width:${pct(s.correct, s.total)}%"></i></span>
        <span class="breakdown-val">${s.correct}/${s.total}</span>
      </div>
    `).join('');

    const wrong = [];
    t.questions.forEach((q, i) => {
      if (!t.answers[i] || !t.answers[i].correct) wrong.push({ q, i });
    });

    const wrongHtml = wrong.length ? wrong.map(({ q, i }) => {
      const ans = t.answers[i];
      const pickedText = ans && ans.picked.length ? ans.picked.map(x => q.options[x].text).join('; ') : 'Нет ответа';
      const correctText = q.correctIndices.map(x => q.options[x].text).join('; ');
      return `
        <div class="wrong-item">
          <p class="wq">${esc(q.q)}</p>
          <div class="wa">Твой ответ: <span style="color:var(--red)">${esc(pickedText)}</span><br><b>Правильно:</b> ${esc(correctText)}</div>
          <div class="we">${esc(q.e)}</div>
        </div>
      `;
    }).join('') : '<p class="small muted" style="margin:0">Ошибок нет — идеальный результат.</p>';

    return `
      <section class="panel result-hero">
        <div class="score-ring ${ringCls}" style="--p:${p}">
          <div class="score-inner">
            <div class="score-num">${p}%</div>
            <div class="score-pct">${correct} из ${total}</div>
          </div>
        </div>
        <div class="result-info">
          <span class="eyebrow">Результат теста</span>
          <h2>${correct} / ${total} правильных</h2>
          <p>${msg}</p>
          <div class="result-stats">
            <span class="stat-chip">Время <b>${fmtTime(t.elapsed)}</b></span>
            <span class="stat-chip">Точность <b>${p}%</b></span>
            <span class="stat-chip">Ошибок <b>${total - correct}</b></span>
            <span class="stat-chip">Тем <b>${Object.keys(byCat).length}</b></span>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">По направлениям</h2></div>
        <div class="panel-body"><div class="breakdown">${breakdown}</div></div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2 class="panel-title">Разбор ошибок</h2>
          <span class="badge ${wrong.length ? 'badge-var' : 'badge-j'}">${wrong.length}</span>
        </div>
        <div class="panel-body"><div class="wrong-list">${wrongHtml}</div></div>
      </section>

      <div class="result-actions">
        <button class="btn secondary" onclick="setMode('stats')">Статистика</button>
        ${wrong.length ? `
          <button class="btn secondary" onclick="newTest()">Новый тест</button>
          <button class="btn btn-primary" onclick="retryWrongTest()">Повторить ошибки</button>
        ` : `
          <button class="btn btn-primary" onclick="newTest()">Новый тест</button>
        `}
      </div>
    `;
  }

  /* ============================================================
     MOCK INTERVIEW
     ============================================================ */
  function renderMockMain() {
    if (state.mock.screen === 'setup') return renderMockSetup();
    if (state.mock.screen === 'running') return renderMockRunner();
    return renderMockResult();
  }

  function renderMockSidebar() {
    const m = state.mock;
    const count = m.cat === 'all' ? THEORY.length : THEORY.filter(t => t.cat === m.cat).length;
    return `
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Формат</h2></div>
        <div class="panel-body stack">
          <div class="row" style="justify-content:space-between"><span class="small muted">Вопросов</span><b class="small">${m.count}</b></div>
          <div class="row" style="justify-content:space-between"><span class="small muted">На ответ</span><b class="small">${Math.round(m.duration / 60)} мин</b></div>
          <div class="row" style="justify-content:space-between"><span class="small muted">Доступно</span><b class="small">${count}</b></div>
          <div class="divider" style="margin:4px 0"></div>
          <p class="small muted" style="margin:0;line-height:1.7">
            Отвечай вслух, не подглядывая. Когда таймер закончится или ответишь — открой разбор и сверься.
          </p>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Совет</h2></div>
        <div class="panel-body">
          <p class="small muted" style="margin:0;line-height:1.7">
            Записывай себя на видео или диктофон. 2 минуты вслух показывают то, что не видно в тексте: структуру, уверенность и воду.
          </p>
        </div>
      </section>
    `;
  }

  function renderMockSetup() {
    const m = state.mock;
    const groups = [
      { id: 'interview', name: 'Интервью-практика' },
      { id: 'portfolio', name: 'Портфолио' },
      { id: 'hr', name: 'HR и софт-скиллы' },
      { id: 'cases', name: 'Сценарные задачи' },
      { id: 'all', name: 'Все темы' }
    ];
    const catCards = groups.map(g => {
      const n = g.id === 'all' ? THEORY.length : THEORY.filter(t => t.cat === g.id).length;
      return `
        <button class="setup-card ${m.cat === g.id ? 'active' : ''}" onclick="setMockCat('${g.id}')">
          <div class="sc-icon">${g.id === 'all' ? '00' : CAT_INDEX[g.id]}</div>
          <div class="sc-name">${g.name}</div>
          <div class="sc-meta">${n}</div>
        </button>
      `;
    }).join('');

    return `
      <section class="section-hero">
        <span class="eyebrow">Mock-interview · ответ вслух</span>
        <h2>Ответь так, как на собеседовании</h2>
        <p>Случайные вопросы из выбранного блока. Таймер идёт, ответ скрыт. Сначала говоришь вслух, потом открываешь разбор и отмечаешь, что нужно повторить.</p>
        <div class="hero-badges">
          <span class="hero-badge">Вопросов <b>${m.count}</b></span>
          <span class="hero-badge">Минут на ответ <b>${Math.round(m.duration / 60)}</b></span>
          <span class="hero-badge">Формат <b>вслух</b></span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">1. Блок вопросов</h2></div>
        <div class="panel-body">
          <div class="setup-grid">${catCards}</div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">2. Параметры</h2></div>
        <div class="panel-body">
          <div class="setup-row">
            <div><div class="setup-label">Время на ответ</div><div class="setup-hint">Можно остановить раньше и открыть ответ</div></div>
            <div class="setup-control">
              <div class="segmented">
                ${[120, 180, 300].map(sec => `<button class="${m.duration === sec ? 'active' : ''}" onclick="setMockDuration(${sec})">${sec / 60} мин</button>`).join('')}
              </div>
            </div>
          </div>
          <div class="setup-row">
            <div><div class="setup-label">Количество вопросов</div><div class="setup-hint">Лучше 5–10 за один подход</div></div>
            <div class="setup-control">
              <div class="segmented">
                ${[5, 10, 15].map(n => `<button class="${m.count === n ? 'active' : ''}" onclick="setMockCount(${n})">${n}</button>`).join('')}
              </div>
            </div>
          </div>
        </div>
      </section>

      <div class="setup-footer">
        <span class="small muted">Будет выбрано: <b style="color:var(--ink)">${Math.min(m.count, m.cat === 'all' ? THEORY.length : THEORY.filter(t => t.cat === m.cat).length)}</b> вопросов</span>
        <button class="btn btn-primary btn-lg" onclick="startMock()">Начать интервью</button>
      </div>
    `;
  }

  window.setMockCat = function (cat) {
    state.mock.cat = cat;
    render();
  };

  window.setMockDuration = function (sec) {
    state.mock.duration = sec;
    render();
  };

  window.setMockCount = function (n) {
    state.mock.count = n;
    render();
  };

  window.startMock = function () {
    const m = state.mock;
    const pool = THEORY.filter(t => m.cat === 'all' || t.cat === m.cat);
    if (!pool.length) { toast('Нет вопросов в выбранном блоке'); return; }
    const questions = shuffle(pool).slice(0, Math.min(m.count, pool.length));
    state.mock = {
      ...m,
      screen: 'running',
      questions,
      index: 0,
      timeLeft: m.duration,
      revealed: false,
      self: []
    };
    state.mode = 'mock';
    startMockTimer();
    saveSaved();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function startMockTimer() {
    stopMockTimer();
    updateMockTimerDom();
    state.mock.timer = setInterval(() => {
      state.mock.timeLeft--;
      if (state.mock.timeLeft <= 0) {
        state.mock.timeLeft = 0;
        updateMockTimerDom();
        revealMockAnswer();
        return;
      }
      updateMockTimerDom();
    }, 1000);
  }

  function stopMockTimer() {
    if (state.mock.timer) {
      clearInterval(state.mock.timer);
      state.mock.timer = null;
    }
  }

  function updateMockTimerDom() {
    document.querySelectorAll('.js-mock-timer').forEach(el => {
      el.textContent = fmtTime(state.mock.timeLeft);
      el.classList.toggle('danger', state.mock.timeLeft <= 15);
    });
  }

  window.revealMockAnswer = function () {
    if (state.mock.screen !== 'running' || state.mock.revealed) return;
    state.mock.revealed = true;
    stopMockTimer();
    saveSaved();
    renderMain();
  };

  window.mockNext = function (confident) {
    const m = state.mock;
    const q = m.questions[m.index];
    if (!q) return;
    if (m.revealed && confident === false) {
      state.bookmarked.add(q.id);
      toast('Добавлено в закладки');
    }
    m.self.push({ id: q.id, revealed: m.revealed, confident: confident === true });
    if (m.index < m.questions.length - 1) {
      m.index++;
      m.timeLeft = m.duration;
      m.revealed = false;
      startMockTimer();
      saveSaved();
      renderMain();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      stopMockTimer();
      m.screen = 'result';
      saveSaved();
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  window.skipMock = function () {
    mockNext(null);
  };

  window.exitMock = function () {
    if (!confirm('Выйти из mock-интервью? Текущий прогресс не сохранится.')) return;
    stopMockTimer();
    state.mock.screen = 'setup';
    saveSaved();
    render();
  };

  function renderMockRunner() {
    const m = state.mock;
    const q = m.questions[m.index];
    if (!q) return renderMockSetup();
    const total = m.questions.length;
    const p = pct(m.index + (m.revealed ? 1 : 0), total);

    const answer = m.revealed ? `
      <div class="answer-grid" style="margin-top:16px">
        <div class="answer-block short">
          <div class="answer-label">Короткий ответ</div>
          <p class="answer-text">${esc(q.a)}</p>
        </div>
        ${q.d ? `<div class="answer-block deep">
          <div class="answer-label">Глубже</div>
          <p class="answer-text">${esc(q.d)}</p>
        </div>` : ''}
      </div>
      ${q.tip ? `<div class="tip-block"><p><b>Связь с опытом:</b> ${esc(q.tip)}</p></div>` : ''}
      <div class="runner-actions">
        <span class="kbd-hint">${m.timeLeft <= 0 ? 'Время вышло' : 'Сверься и отметь'}</span>
        <span class="right"></span>
        <button class="btn" onclick="mockNext(false)">Повторить</button>
        <button class="btn btn-primary" onclick="mockNext(true)">Дальше</button>
      </div>
    ` : `
      <div class="mock-prompt">
        <p>Отвечай вслух. Когда будешь готов(а), открой разбор.</p>
        <div class="mock-clock js-mock-timer">${fmtTime(m.timeLeft)}</div>
        <div class="row" style="justify-content:center">
          <button class="btn btn-primary btn-lg" onclick="revealMockAnswer()">Показать ответ</button>
          <button class="btn btn-lg" onclick="skipMock()">Пропустить</button>
        </div>
      </div>
    `;

    return `
      <div class="runner-top">
        <div>
          <div class="rt-title">Mock-interview</div>
          <div class="rt-sub">Вопрос ${m.index + 1} из ${total} · ${CAT_INDEX[q.cat]} · ${esc(catName(q.cat))}</div>
        </div>
        <span class="spacer"></span>
        <span class="timer js-mock-timer ${m.timeLeft <= 15 ? 'danger' : ''}">${fmtTime(m.timeLeft)}</span>
        <button class="btn btn-sm btn-ghost" onclick="exitMock()">Выйти</button>
      </div>

      <div class="progress-line"><i style="width:${p}%"></i></div>

      <section class="panel question-panel fade-in">
        <div class="question-meta">
          <span class="badge badge-cat">${CAT_INDEX[q.cat]} · ${esc(catName(q.cat))}</span>
          ${levelBadge(q.lvl)}
          <span class="q-id">${q.id}</span>
        </div>
        <h2 class="question-text">${esc(q.q)}</h2>
        ${answer}
      </section>
    `;
  }

  function renderMockResult() {
    const m = state.mock;
    const total = m.self.length;
    const revealed = m.self.filter(x => x.revealed).length;
    const confident = m.self.filter(x => x.confident).length;

    return `
      <section class="section-hero">
        <span class="eyebrow">Mock-interview завершён</span>
        <h2>${total} вопросов вслух</h2>
        <p>Разобрано: ${revealed}. Уверенно: ${confident}. Всё, что отмечено «Повторить», добавлено в закладки.</p>
        <div class="hero-badges">
          <span class="hero-badge">Вопросов <b>${total}</b></span>
          <span class="hero-badge">Разобрано <b>${revealed}</b></span>
          <span class="hero-badge">Уверенно <b>${confident}</b></span>
        </div>
      </section>

      <div class="result-actions">
        <button class="btn secondary" onclick="setMode('test')">К тестам</button>
        <button class="btn secondary" onclick="setMode('study')">К конспекту</button>
        <button class="btn btn-primary" onclick="startMock()">Ещё раз</button>
      </div>
    `;
  }

  /* ============================================================
     EXAM
     ============================================================ */
  window.startExam = function () {
    const pool = shuffle(TESTS).slice(0, Math.min(50, TESTS.length)).map(prepareQuestion);
    stopExamTimer();
    state.exam = {
      screen: 'running',
      questions: pool,
      index: 0,
      selected: new Array(pool.length).fill(null),
      flags: new Set(),
      remaining: 45 * 60,
      timer: null,
      startedAt: Date.now(),
      recorded: false
    };
    state.mode = 'exam';
    startExamTimer();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  function startExamTimer() {
    stopExamTimer();
    state.exam.timer = setInterval(() => {
      state.exam.remaining--;
      if (state.exam.remaining <= 0) {
        state.exam.remaining = 0;
        submitExam(true);
        return;
      }
      document.querySelectorAll('.js-exam-timer').forEach(el => {
        el.textContent = fmtTime(state.exam.remaining);
        el.classList.toggle('danger', state.exam.remaining < 300);
      });
    }, 1000);
  }

  function stopExamTimer() {
    if (state.exam.timer) {
      clearInterval(state.exam.timer);
      state.exam.timer = null;
    }
  }

  window.selectExamOption = function (i) {
    if (state.exam.screen !== 'running') return;
    const q = state.exam.questions[state.exam.index];
    const cur = state.exam.selected[state.exam.index];
    if (q.multi) {
      const set = new Set(cur || []);
      if (set.has(i)) set.delete(i);
      else set.add(i);
      state.exam.selected[state.exam.index] = [...set].sort((a, b) => a - b);
    } else {
      state.exam.selected[state.exam.index] = [i];
    }
    renderMain();
  };

  window.examNav = function (i) {
    state.exam.index = i;
    renderMain();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  window.examPrev = function () {
    if (state.exam.index > 0) {
      state.exam.index--;
      renderMain();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  window.examNext = function () {
    if (state.exam.index < state.exam.questions.length - 1) {
      state.exam.index++;
      renderMain();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  window.toggleExamFlag = function () {
    const i = state.exam.index;
    if (state.exam.flags.has(i)) state.exam.flags.delete(i);
    else state.exam.flags.add(i);
    renderMain();
  };

  window.confirmSubmitExam = function () {
    const unanswered = state.exam.selected.filter(x => !x || !x.length).length;
    const msg = unanswered
      ? `Есть ${unanswered} вопросов без ответа. Сдать экзамен?`
      : 'Сдать экзамен и увидеть результат?';
    if (confirm(msg)) submitExam();
  };

  window.submitExam = function (auto) {
    if (state.exam.screen !== 'running') return;
    if (!auto && state.exam.selected.filter(x => !x || !x.length).length) {
      if (!confirm('Остались вопросы без ответа. Всё равно сдать?')) return;
    }
    stopExamTimer();
    const e = state.exam;
    if (!e.recorded) {
      e.recorded = true;
      let correct = 0;
      e.questions.forEach((q, i) => {
        const sel = e.selected[i] || [];
        const ok = sel.length === q.correctIndices.length &&
                   sel.every(x => q.correctIndices.includes(x));
        if (ok) correct++;
        recordAnswer(q, ok);
      });
      pushAttempt('exam', correct, e.questions.length, 45 * 60 - e.remaining);
    }
    e.screen = 'result';
    saveSaved();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  window.exitExam = function () {
    if (!confirm('Выйти из экзамена? Прогресс не сохранится.')) return;
    stopExamTimer();
    state.exam.screen = 'setup';
    render();
  };

  function renderExamMain() {
    if (state.exam.screen === 'setup') return renderExamSetup();
    if (state.exam.screen === 'running') return renderExamRunner();
    return renderExamResult();
  }

  function renderExamSetup() {
    return `
      <section class="section-hero">
        <span class="eyebrow">Экзамен · 50 вопросов</span>
        <h2>Финальная проверка перед собеседованием</h2>
        <p>50 случайных вопросов из всех направлений, 45 минут, без мгновенной проверки. Результат и разбор ошибок — после сдачи. Проходной балл — 70%.</p>
        <div class="hero-badges">
          <span class="hero-badge">Вопросов <b>50</b></span>
          <span class="hero-badge">Минут <b>45</b></span>
          <span class="hero-badge">Проходной балл <b>70%</b></span>
          <span class="hero-badge">Направлений <b>${CATEGORIES.length}</b></span>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Правила</h2></div>
        <div class="panel-body">
          <div class="setup-grid">
            <div class="setup-card" style="cursor:default">
              <div class="sc-icon">01</div>
              <div class="sc-name">Случайная выборка</div>
              <div class="sc-meta">Из всего банка без повторов</div>
            </div>
            <div class="setup-card" style="cursor:default">
              <div class="sc-icon">02</div>
              <div class="sc-name">Флажки</div>
              <div class="sc-meta">Помечай сложные вопросы</div>
            </div>
            <div class="setup-card" style="cursor:default">
              <div class="sc-icon">03</div>
              <div class="sc-name">Таймер</div>
              <div class="sc-meta">45 минут, затем автосдача</div>
            </div>
          </div>
          <div class="divider"></div>
          <div class="setup-footer">
            <span class="small muted">Можно менять ответы до сдачи. После сдачи — только разбор.</span>
            <button class="btn btn-primary btn-lg" onclick="startExam()">Начать экзамен</button>
          </div>
        </div>
      </section>
    `;
  }

  function renderExamRunner() {
    const e = state.exam;
    const q = e.questions[e.index];
    const selected = e.selected[e.index] || [];
    const answeredCount = e.selected.filter(x => x && x.length).length;
    const p = pct(answeredCount, e.questions.length);

    const options = q.options.map((o, i) => `
      <button class="option ${selected.includes(i) ? 'selected' : ''}" onclick="selectExamOption(${i})">
        <span class="option-key">${String.fromCharCode(65 + i)}</span>
        <span>${esc(o.text)}</span>
      </button>
    `).join('');

    const nav = e.questions.map((_, i) => {
      const cls = [
        e.selected[i] && e.selected[i].length ? 'answered' : '',
        i === e.index ? 'current' : '',
        e.flags.has(i) ? 'flagged' : ''
      ].filter(Boolean).join(' ');
      return `<button class="${cls}" onclick="examNav(${i})">${i + 1}</button>`;
    }).join('');

    return `
      <div class="runner-top">
        <div>
          <div class="rt-title">Экзамен</div>
          <div class="rt-sub">Вопрос ${e.index + 1} из ${e.questions.length} · отвечено ${answeredCount}</div>
        </div>
        <span class="spacer"></span>
        <span class="timer js-exam-timer ${e.remaining < 300 ? 'danger' : ''}">${fmtTime(e.remaining)}</span>
        <button class="btn btn-sm btn-ghost" onclick="exitExam()">Выйти</button>
      </div>

      <div class="progress-line"><i style="width:${p}%"></i></div>

      <div class="exam-layout">
        <section class="panel question-panel fade-in">
          <div class="question-meta">
            <span class="badge badge-cat">${CAT_INDEX[q.cat]} · ${esc(catName(q.cat))}</span>
            ${levelBadge(q.lvl)}
            ${q.var > 1 ? `<span class="badge badge-var">Вариация ${q.var}</span>` : ''}
            ${q.multi ? '<span class="badge badge-var">Несколько ответов</span>' : ''}
            <span class="q-id">${q.id}</span>
          </div>
          <h2 class="question-text">${esc(q.q)}</h2>
          <div class="options">${options}</div>
          <div class="runner-actions">
            <button class="btn" onclick="examPrev()" ${e.index === 0 ? 'disabled' : ''}>Назад</button>
            <button class="btn ${e.flags.has(e.index) ? 'btn-amber' : ''}" onclick="toggleExamFlag()">${e.flags.has(e.index) ? 'Снять флажок' : 'Пометить'}</button>
            <span class="right"></span>
            ${e.index < e.questions.length - 1
              ? '<button class="btn btn-primary" onclick="examNext()">Далее</button>'
              : '<button class="btn btn-emerald" onclick="confirmSubmitExam()">Сдать экзамен</button>'}
          </div>
        </section>

        <aside class="panel">
          <div class="panel-head"><h2 class="panel-title">Навигация</h2><span class="badge badge-muted">${answeredCount}/${e.questions.length}</span></div>
          <div class="panel-body">
            <div class="exam-nav">${nav}</div>
            <div class="exam-legend">
              <span><i style="background:#8b5cf6"></i>отвечен</span>
              <span><i style="background:#f5b942"></i>флажок</span>
              <span><i style="background:#1e2d47"></i>без ответа</span>
            </div>
            <div class="divider"></div>
            <button class="btn btn-emerald" style="width:100%" onclick="confirmSubmitExam()">Сдать экзамен</button>
          </div>
        </aside>
      </div>
    `;
  }

  function renderExamResult() {
    const e = state.exam;
    const total = e.questions.length;
    let correct = 0;
    e.questions.forEach((q, i) => {
      if (isAnswerCorrect(q, e.selected[i])) correct++;
    });
    const p = pct(correct, total);
    const passed = p >= 70;
    const ringCls = p >= 85 ? '' : p >= 70 ? 'mid' : 'low';

    const byCat = {};
    e.questions.forEach((q, i) => {
      if (!byCat[q.cat]) byCat[q.cat] = { total: 0, correct: 0 };
      byCat[q.cat].total++;
      if (isAnswerCorrect(q, e.selected[i])) byCat[q.cat].correct++;
    });

    const breakdown = Object.entries(byCat).map(([cat, s]) => `
      <div class="breakdown-row">
        <span class="breakdown-name">${CAT_INDEX[cat]} · ${esc(catName(cat))}</span>
        <span class="breakdown-bar"><i style="width:${pct(s.correct, s.total)}%"></i></span>
        <span class="breakdown-val">${s.correct}/${s.total}</span>
      </div>
    `).join('');

    const wrong = [];
    e.questions.forEach((q, i) => {
      if (!isAnswerCorrect(q, e.selected[i])) wrong.push({ q, i });
    });

    const wrongHtml = wrong.length ? wrong.map(({ q, i }) => {
      const picked = e.selected[i] || [];
      const pickedText = picked.length ? picked.map(x => q.options[x].text).join('; ') : 'Нет ответа';
      const correctText = q.correctIndices.map(x => q.options[x].text).join('; ');
      return `
        <div class="wrong-item">
          <p class="wq">${esc(q.q)}</p>
          <div class="wa">Твой ответ: <span style="color:var(--red)">${esc(pickedText)}</span><br><b>Правильно:</b> ${esc(correctText)}</div>
          <div class="we">${esc(q.e)}</div>
        </div>
      `;
    }).join('') : '<p class="small muted" style="margin:0">Ни одной ошибки — экзамен сдан идеально.</p>';

    return `
      <section class="panel result-hero">
        <div class="score-ring ${ringCls}" style="--p:${p}">
          <div class="score-inner">
            <div class="score-num">${p}%</div>
            <div class="score-pct">${correct} из ${total}</div>
          </div>
        </div>
        <div class="result-info">
          <span class="eyebrow">${passed ? 'Экзамен сдан' : 'Экзамен не сдан'}</span>
          <h2>${passed ? 'Проходной балл достигнут' : 'Пока ниже проходного балла'}</h2>
          <p>${passed
            ? 'Ты готов(а) к техническому собеседованию. Осталось отшлифовать слабые темы и повторить кейсы из портфолио.'
            : 'Не хватило нескольких баллов. Разбери ошибки, повтори слабые направления и попробуй снова.'}</p>
          <div class="result-stats">
            <span class="stat-chip">Точность <b>${p}%</b></span>
            <span class="stat-chip">Верно <b>${correct}</b></span>
            <span class="stat-chip">Ошибок <b>${total - correct}</b></span>
            <span class="stat-chip">Осталось <b>${fmtTime(e.remaining)}</b></span>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">По направлениям</h2></div>
        <div class="panel-body"><div class="breakdown">${breakdown}</div></div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Разбор ошибок</h2><span class="badge ${wrong.length ? 'badge-var' : 'badge-j'}">${wrong.length}</span></div>
        <div class="panel-body"><div class="wrong-list">${wrongHtml}</div></div>
      </section>

      <div class="result-actions">
        <button class="btn secondary" onclick="setMode('stats')">Статистика</button>
        <button class="btn secondary" onclick="setMode('test')">К тестам</button>
        <button class="btn btn-primary" onclick="startExam()">Пройти ещё раз</button>
      </div>
    `;
  }

  /* ============================================================
     STATS
     ============================================================ */
  function renderStatsMain() {
    const attempts = state.stats.attempts || [];
    const perCat = state.stats.perCat || {};
    const totalAnswered = Object.values(perCat).reduce((s, x) => s + x.answered, 0);
    const totalCorrect = Object.values(perCat).reduce((s, x) => s + x.correct, 0);
    const accuracy = pct(totalCorrect, totalAnswered);
    const best = attempts.length ? Math.max(...attempts.map(a => pct(a.correct, a.total))) : 0;
    const avg = attempts.length ? Math.round(attempts.reduce((s, a) => s + pct(a.correct, a.total), 0) / attempts.length) : 0;

    const catRows = CATEGORIES.map(c => {
      const s = perCat[c.id] || { answered: 0, correct: 0 };
      const acc = pct(s.correct, s.answered);
      return `
        <div class="breakdown-row">
          <span class="breakdown-name">${CAT_INDEX[c.id]} · ${esc(c.name)}</span>
          <span class="breakdown-bar"><i style="width:${s.answered ? acc : 0}%"></i></span>
          <span class="breakdown-val">${s.answered ? acc + '%' : '—'}</span>
        </div>
      `;
    }).join('');

    const recent = attempts.slice().reverse().slice(0, 12).map(a => {
      const p = pct(a.correct, a.total);
      const cls = p >= 85 ? 'good' : p >= 60 ? 'mid' : 'bad';
      return `
        <div class="attempt-row">
          <span class="date">${fmtDate(a.date)}</span>
          <span class="mode">${a.mode === 'exam' ? 'Экзамен' : 'Тест'}</span>
          <span class="muted">${a.correct}/${a.total}</span>
          <span class="score ${cls}">${p}%</span>
        </div>
      `;
    }).join('') || '<p class="small muted" style="margin:0">Пока нет завершённых попыток.</p>';

    const weak = weakTopics();

    return `
      <section class="section-hero">
        <span class="eyebrow">Статистика</span>
        <h2>Прогресс подготовки</h2>
        <p>Данные сохраняются локально в браузере. Чем больше тестов — тем точнее картина слабых тем.</p>
        <div class="hero-badges">
          <span class="hero-badge">попыток <b>${attempts.length}</b></span>
          <span class="hero-badge">ответов <b>${totalAnswered}</b></span>
          <span class="hero-badge">точность <b>${accuracy}%</b></span>
        </div>
      </section>

      <div class="stat-grid">
        <div class="stat-card violet"><div class="sc-label">Попыток</div><div class="sc-value">${attempts.length}</div><div class="sc-sub">завершённых тестов</div></div>
        <div class="stat-card green"><div class="sc-label">Точность</div><div class="sc-value">${accuracy}%</div><div class="sc-sub">${totalCorrect} из ${totalAnswered}</div></div>
        <div class="stat-card amber"><div class="sc-label">Средний балл</div><div class="sc-value">${avg}%</div><div class="sc-sub">по всем попыткам</div></div>
        <div class="stat-card sky"><div class="sc-label">Лучший результат</div><div class="sc-value">${best}%</div><div class="sc-sub">личный рекорд</div></div>
      </div>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Точность по направлениям</h2><span class="badge badge-muted">${CATEGORIES.length} блоков</span></div>
        <div class="panel-body"><div class="breakdown">${catRows}</div></div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Что подтянуть</h2><span class="badge ${weak.length ? 'badge-var' : 'badge-j'}">${weak.length}</span></div>
        <div class="panel-body">
          ${weak.length ? `<div class="stack">${weak.slice(0, 8).map(w => `
            <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding-bottom:8px">
              <span class="small">${CAT_INDEX[w.cat.id]} · ${esc(w.cat.name)}</span>
              <span class="row"><span class="small mono" style="color:var(--red)">${w.accuracy}%</span>
              <button class="btn btn-sm" onclick="startWeakTest('${w.cat.id}')">Тренировать</button></span>
            </div>
          `).join('')}</div>` : '<p class="small muted" style="margin:0">Пока нет тем с точностью ниже 70% (нужно минимум 3 ответа по теме).</p>'}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Данные</h2></div>
        <div class="panel-body">
          <p class="small muted" style="margin:0 0 10px;line-height:1.7">
            Прогресс хранится в браузере и восстанавливается после закрытия. Для переноса на другое устройство скачай копию и загрузи её там.
          </p>
          <div class="btn-row">
            <button class="btn btn-sm" onclick="exportBackup()">Скачать копию</button>
            <label class="btn btn-sm" style="cursor:pointer">
              Загрузить копию
              <input type="file" accept="application/json" onchange="importBackup(this)" style="display:none" />
            </label>
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="panel-title">Последние попытки</h2></div>
        <div class="panel-body"><div class="attempts">${recent}</div></div>
      </section>
    `;
  }

  window.startWeakTest = function (catId) {
    state.test.config.cat = catId;
    state.test.config.cats = [catId];
    state.test.config.count = 20;
    state.mode = 'test';
    state.test.screen = 'setup';
    render();
  };

  window.exportBackup = function () {
    try {
      const data = localStorage.getItem(LS_KEY) || '{}';
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '2d-interview-trainer-backup.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('Копия сохранена');
    } catch (e) {
      toast('Не удалось сохранить копию');
    }
  };

  window.importBackup = function (input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || typeof data !== 'object') throw new Error('bad');
        localStorage.setItem(LS_KEY, JSON.stringify(data));
        location.reload();
      } catch (e) {
        toast('Файл повреждён');
      }
    };
    reader.readAsText(file);
  };

  window.resetAllStats = function () {
    if (!confirm('Сбросить всю статистику тестов и экзаменов?')) return;
    state.stats = { attempts: [], perCat: {}, perTest: {} };
    saveSaved();
    render();
    toast('Статистика сброшена');
  };

  /* ============================================================
     SHARED STATS WRITE
     ============================================================ */
  function recordAnswer(q, correct) {
    const perCat = state.stats.perCat;
    if (!perCat[q.cat]) perCat[q.cat] = { answered: 0, correct: 0 };
    perCat[q.cat].answered++;
    if (correct) perCat[q.cat].correct++;

    if (!state.stats.perTest) state.stats.perTest = {};
    const perTest = state.stats.perTest;
    if (!perTest[q.id]) perTest[q.id] = { answered: 0, correct: 0 };
    perTest[q.id].answered++;
    if (correct) perTest[q.id].correct++;
  }

  function pushAttempt(mode, correct, total, duration) {
    if (!state.stats.attempts) state.stats.attempts = [];
    state.stats.attempts.push({
      date: Date.now(),
      mode,
      correct,
      total,
      duration
    });
    if (state.stats.attempts.length > 100) {
      state.stats.attempts = state.stats.attempts.slice(-100);
    }
  }

  /* ============================================================
     KEYBOARD
     ============================================================ */
  document.addEventListener('keydown', function (e) {
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    const isSearchKey = e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k');
    if (isSearchKey && !(state.mode === 'test' && state.test.screen === 'running') && !(state.mode === 'exam' && state.exam.screen === 'running')) {
      e.preventDefault();
      const input = state.mode === 'study'
        ? [...document.querySelectorAll('#studySearch, #studySearchMain')].find(el => el.offsetParent !== null)
        : state.mode === 'test' ? document.getElementById('testSearchInput') : null;
      if (input) input.focus();
      return;
    }

    if (state.mode === 'test' && state.test.screen === 'running') {
      const t = state.test;
      const ans = t.answers[t.index];
      if (!ans && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        const idx = Number(e.key) - 1;
        if (idx < t.questions[t.index].options.length) pickOption(idx);
      } else if (e.key === 'Enter') {
        if (ans) {
          e.preventDefault();
          nextTestQuestion();
        } else if (t.questions[t.index].multi && t.multiSelection && t.multiSelection.length) {
          e.preventDefault();
          submitMultiAnswer();
        }
      }
    }

    if (state.mode === 'exam' && state.exam.screen === 'running') {
      if (['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        const idx = Number(e.key) - 1;
        if (idx < state.exam.questions[state.exam.index].options.length) selectExamOption(idx);
      }
      if (e.key === 'ArrowRight') examNext();
      if (e.key === 'ArrowLeft') examPrev();
      if (e.key === 'f' || e.key === 'F') toggleExamFlag();
    }
  });

  /* ============================================================
     INIT
     ============================================================ */
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  window.addEventListener('scroll', function () {
    if (window.scrollY > 120) state.studyScrolled = true;
    const btn = document.getElementById('backToTop');
    if (btn) btn.classList.toggle('show', window.scrollY > 500);
  }, { passive: true });

  window.scrollToTop = function () {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  applyTheme(state.theme);
  restoreSession(saved.session, saved.lastMode);
  render();

  setInterval(saveSaved, 10000);
  window.addEventListener('pagehide', saveSaved);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') saveSaved();
  });
})();
