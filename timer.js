/**
 * timer.js — лёгкая библиотека таймера без зависимостей (ESM).
 *
 * Возможности:
 *  - высокая точность (performance.now / Date.now, с поправкой на дрейф)
 *  - pause / resume / cancel / reset / restart / retrigger
 *  - countdown / countup / interval-режимы
 *  - повторы (repeat) с лимитом или бесконечно
 *  - старт по системным часам: startAt (Date / "HH:MM:SS" / timestamp)
 *  - расписание (cron-подобное: секунды/минуты/часы/дни, имена дней/месяцев)
 *  - Jobs — менеджер задач: добавить/удалить/перезаписать/обновить функции по id
 *  - события: onStart, onTick, onPause, onResume, onCancel, onComplete, onError
 *  - promisе (await timer.done), then/catch/finally
 *  - глобальный реестр активных таймеров (Timer.list/count/pauseAll/cancelAll)
 *  - unref() — не держать процесс Node живым
 *  - утилиты: formatMs, TimeSpan, timeUntil, fromNow, retry, debounce, throttle
 */

const now =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? () => performance.now()
    : () => Date.now();

const clamp = (n, min = 0, max = 86400000) => Math.min(max, Math.max(min, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GLOBAL = typeof globalThis !== "undefined" ? globalThis : window;

/**
 * Вычислить мс до заданного системного времени (по часам компьютера).
 * Принимает:
 *   Date               — конкретный момент
 *   "HH:MM" / "HH:MM:SS" — ближайшее (сегодня; если уже прошло — завтра)
 *   число              — timestamp (Date.now() + N)
 * @param {Date|string|number} when
 * @returns {number} миллисекунды ожидания (>= 0)
 */
export function timeUntil(when) {
  let target;
  if (when instanceof Date) {
    target = when.getTime();
  } else if (typeof when === "number") {
    target = when;
  } else if (typeof when === "string") {
    const m = when.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!m) throw new Error(`bad time "${when}", ожидается "HH:MM" или "HH:MM:SS"`);
    const nowD = new Date();
    let t = new Date(nowD);
    t.setHours(Number(m[1]), Number(m[2]), Number(m[3] ?? 0), 0);
    if (t.getTime() <= nowD.getTime()) t.setDate(t.getDate() + 1);
    target = t.getTime();
  } else {
    throw new Error('timeUntil: ожидается Date, "HH:MM" или число');
  }
  return Math.max(0, target - Date.now());
}

const msUntil = timeUntil;

/** Безопасный вызов колбэка с обработкой ошибок. */
function safeCall(fn, arg, onError) {
  if (typeof fn !== "function") return;
  try {
    fn(arg);
  } catch (err) {
    if (typeof onError === "function") onError(err);
    else if (typeof console !== "undefined") console.error(err);
  }
}

/** Внутренний механизм: один общий менеджер интервалов (минимальный тик). */
const TICK = 32;

/* --------------------------- Реестр таймеров --------------------------- */

const registry = new Set();

function track(t) {
  registry.add(t);
}
function untrack(t) {
  registry.delete(t);
}

/* ------------------------------- Timer ------------------------------- */

export class Timer {
  /**
   * @param {object} opts
   * @param {number} [opts.duration]  длительность в мс (countdown/countup)
   * @param {number} [opts.interval]  режим "интервал": срабатывать каждые N мс
   * @param {number} [opts.startIn]   отложенный старт в мс
   * @param {number} [opts.delay]     то же, что startIn
   * @param {Date|string|number} [opts.startAt]  старт по системным часам
   * @param {boolean} [opts.autostart=true]
   * @param {boolean} [opts.countup]  если true — считаем вверх
   * @param {number} [opts.repeat]    0 = один раз, N = ещё N раз, Infinity = всегда
   * @param {function} [opts.onTick]
   * @param {function} [opts.onStart]
   * @param {function} [opts.onPause]
   * @param {function} [opts.onResume]
   * @param {function} [opts.onCancel]
   * @param {function} [opts.onComplete]
   * @param {function} [opts.onError]  обрабатывает ошибки колбэков
   */
  constructor(opts = {}) {
    const o = opts;
    this.countup = !!o.countup;
    this.duration = clamp(o.duration ?? 0);
    this.repeat = o.repeat ?? 0; // по умолчанию один запуск
    this.interval = o.interval ? clamp(o.interval) : null;

    this.onTick = o.onTick || null;
    this.onStart = o.onStart || null;
    this.onPause = o.onPause || null;
    this.onResume = o.onResume || null;
    this.onCancel = o.onCancel || null;
    this.onComplete = o.onComplete || null;
    this.onError = o.onError || null;

    this._t0 = 0;
    this._elapsed = 0;
    this._done = 0;
    this._handle = null;
    this._pendingStart = null;
    this._unrefd = false;
    this._state = "idle"; // idle | running | paused | done | cancelled
    this._listeners = new Map();

    this._startTimer =
      o.startAt !== undefined
        ? timeUntil(o.startAt)
        : o.startIn > 0
          ? o.startIn
          : o.delay > 0
            ? o.delay
            : 0;

    this.done = new Promise((res) => (this._resolve = res));

    track(this);

    if (o.autostart !== false) this.start();
  }

  // ------------------------------ getters ------------------------------

  get state() {
    return this._state;
  }
  get elapsed() {
    return this._elapsed + (this._state === "running" ? this._now() - this._t0 : 0);
  }
  get remaining() {
    return this.interval || this.countup ? null : Math.max(0, this.duration - this.elapsed);
  }
  get progress() {
    if (this.interval || this.duration <= 0 || this.countup) return null;
    return Math.min(1, Math.max(0, this.elapsed / this.duration));
  }
  get isRunning() {
    return this._state === "running";
  }
  get isPaused() {
    return this._state === "paused";
  }
  get isDone() {
    return this._state === "done";
  }
  get isCancelled() {
    return this._state === "cancelled";
  }
  get isIdle() {
    return this._state === "idle";
  }
  get cycles() {
    return this._done;
  }

  // ------------------------------ методы ------------------------------

  _now() {
    return now();
  }

  /* ---------------------- EventEmitter-интерфейс ---------------------- */

  /**
   * Подписаться на событие: "start" | "tick" | "pause" | "resume" |
   * "cancel" | "complete" | "error".
   * @returns {Function} unsubscribe
   */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const set = this._listeners.get(event);
    if (set) set.delete(fn);
    return this;
  }

  once(event, fn) {
    const off = this.on(event, (...a) => {
      off();
      fn(...a);
    });
    return off;
  }

  removeAllListeners(event) {
    if (event) this._listeners.delete(event);
    else this._listeners.clear();
    return this;
  }

  listenerCount(event) {
    return this._listeners.get(event)?.size ?? 0;
  }

  /** Внутренняя эмиссия: зовёт листенеры + именованный колбэк onXxx. */
  _emit(event, arg) {
    const named = this["on" + event[0].toUpperCase() + event.slice(1)];
    if (typeof named === "function") {
      try {
        named(arg);
      } catch (err) {
        this._emitError(err);
      }
    }
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of [...set]) {
        try {
          fn(arg);
        } catch (err) {
          this._emitError(err);
        }
      }
    }
  }

  _emitError(err) {
    if (typeof this.onError === "function") {
      try {
        this.onError(err);
      } catch (_) {
        /* noop */
      }
    } else if (typeof console !== "undefined") console.error(err);
  }

  /** EventTarget-совместимость (для браузерных библиотек). */
  addEventListener(event, fn) {
    this.on(event, fn);
    return this;
  }
  removeEventListener(event, fn) {
    this.off(event, fn);
    return this;
  }

  /** RxJS-совместимая подписка. observer: { next?, error?, complete? }. */
  subscribe(observer) {
    const offTick = this.on("tick", (v) => observer.next?.(v));
    const offComplete = this.on("complete", () => observer.complete?.());
    const offCancel = this.on("cancel", () => observer.complete?.());
    const offError = this.on("error", (e) => observer.error?.(e));
    if (this._state === "running") observer.next?.(this.elapsed);
    return () => {
      offTick();
      offComplete();
      offCancel();
      offError();
    };
  }

  /** Асинхронный итератор: for await (const v of timer). */
  async *[Symbol.asyncIterator]() {
    const queue = [];
    const waiters = [];
    const push = (v) => {
      if (waiters.length) waiters.shift()(v);
      else queue.push(v);
    };
    const offTick = this.on("tick", (el) => push({ state: "tick", value: el }));
    const offComplete = this.on("complete", () => push({ state: "done" }));
    const offCancel = this.on("cancel", () => push({ state: "done" }));
    const offError = this.on("error", (e) => push({ state: "error", value: e }));

    try {
      while (true) {
        const item = queue.length ? queue.shift() : await new Promise((res) => waiters.push(res));
        if (item.state === "done") return;
        if (item.state === "error") throw item.value;
        yield item.value;
      }
    } finally {
      offTick();
      offComplete();
      offCancel();
      offError();
    }
  }

  _unrefHandle() {
    if (this._handle && typeof this._handle.unref === "function") this._handle.unref();
    if (this._pendingStart && typeof this._pendingStart.unref === "function") this._pendingStart.unref();
  }

  /** Не держать процесс Node живым. Учитывается и при последующих паузах/резюме. */
  unref() {
    this._unrefd = true;
    this._unrefHandle();
    return this;
  }

  start() {
    if (this._state === "running" || this._state === "done") return this;
    if (this._state === "cancelled" || this._state === "idle") this._elapsed = 0;
    if (this._startTimer > 0) {
      this._state = "idle";
      this._pendingStart = setTimeout(() => {
        this._pendingStart = null;
        if (this._state === "idle") this._run();
      }, this._startTimer);
      if (this._unrefd) this._unrefHandle();
      return this;
    }
    return this._run();
  }

  pause() {
    if (this._state !== "running") return this;
    clearTimeout(this._pendingStart);
    this._pendingStart = null;
    this._elapsed += this._now() - this._t0;
    this._stopHandle();
    this._state = "paused";
    this._emit("pause", this);
    return this;
  }

  resume() {
    if (this._state !== "paused") return this;
    this._state = "running";
    this._t0 = this._now();
    this._ensureHandle();
    this._emit("resume", this);
    return this;
  }

  reset() {
    clearTimeout(this._pendingStart);
    this._pendingStart = null;
    this._stopHandle();
    this._elapsed = 0;
    this._done = 0;
    this._state = "idle";
    return this;
  }

  /** Полный перезапуск: сброс + старт. */
  restart() {
    return this.reset().start();
  }

  /** Сбросить текущий цикл (для interval/повторов) и снова вызвать onStart. */
  retrigger() {
    if (this._state !== "running") return this;
    this._elapsed = 0;
    this._t0 = this._now();
    this._emit("start", this);
    return this;
  }

  cancel() {
    if (this._state === "cancelled" || this._state === "done") return this;
    clearTimeout(this._pendingStart);
    this._pendingStart = null;
    this._stopHandle();
    this._state = "cancelled";
    untrack(this);
    this._resolve(null);
    this._emit("cancel", this);
    return this;
  }

  /** alias для cancel(). */
  stop() {
    return this.cancel();
  }

  _stopHandle() {
    if (this._handle) {
      clearInterval(this._handle);
      this._handle = null;
    }
  }

  _ensureHandle() {
    if (!this._handle) this._handle = setInterval(() => this._tick(), TICK);
    if (this._unrefd) this._unrefHandle();
  }

  _run() {
    if (this._state === "done") return this;
    this._state = "running";
    this._t0 = this._now();
    this._emit("start", this);
    this._tick();
    this._ensureHandle();
    return this;
  }

  _tick() {
    if (this._state !== "running") return;
    const el = this.elapsed;

    if (this.interval) {
      this._emit("tick", el);
      if (el >= this.interval) this._finishInterval();
      return;
    }

    this._emit("tick", el);

    if (this.duration <= 0) return; // бесконечный секундомер без конца
    if (el >= this.duration) this._finishCycle();
  }

  _resetCycle() {
    this._elapsed = 0;
    this._t0 = this._now();
    this._emit("start", this);
  }

  _finishInterval() {
    if (this.repeat === Infinity) {
      this._resetCycle();
      return;
    }
    this._done++;
    if (this._done > this.repeat) return this._complete();
    this._resetCycle();
  }

  _finishCycle() {
    this._done++;
    if (this.repeat !== Infinity && this._done > this.repeat) return this._complete();
    this._resetCycle();
  }

  _complete() {
    this._freezeElapsed();
    this._stopHandle();
    this._state = "done";
    untrack(this);
    this._resolve(null);
    this._emit("complete", this);
  }

  /** Заморозить накопленное время, чтобы elapsed был доступен и после завершения. */
  _freezeElapsed() {
    if (this._state === "running") this._elapsed += this._now() - this._t0;
  }

  then(res, rej) {
    return this.done.then(res, rej);
  }
  catch(rej) {
    return this.done.catch(rej);
  }
  finally(fn) {
    return this.done.finally(fn);
  }

  /**
   * Запустить таймер в заданное системное время.
   * @param {Date|string|number} when
   * @param {object} opts  те же опции, что в конструкторе
   */
  static startAt(when, opts = {}) {
    return new Timer({ ...opts, startAt: when });
  }

  /** Разовый обратный отсчёт: через duration вызовется колбэк. */
  static after(duration, fn, opts = {}) {
    return new Timer({ duration, onComplete: fn, ...opts });
  }

  /** Интервальный таймер: колбэк каждые interval мс (бесконечно). */
  static every(interval, fn, opts = {}) {
    return new Timer({ interval, repeat: Infinity, onTick: fn, ...opts });
  }

  /** Промис-задержка: await Timer.delay(ms). */
  static delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // --------------------------- статика / реестр ---------------------------

  /**
   * Таймер по промису: измеряет время выполнения promise.
   * Полный (complete) — при resolve, отмененный — при reject.
   * Удобно для объединения с async-библиотеками/fetch/await.
   */
  static fromPromise(promise, opts = {}) {
    const t = new Timer({ countup: true, duration: 0, ...opts });
    t.start();
    promise.then(
      () => t._complete(),
      () => t.cancel(),
    );
    return t;
  }

  static list() {
    return [...registry];
  }
  static count() {
    return registry.size;
  }
  static pauseAll() {
    for (const t of [...registry]) t.pause();
    return registry.size;
  }
  static resumeAll() {
    for (const t of [...registry]) if (t._state === "paused") t.resume();
    return registry.size;
  }
  static cancelAll() {
    const n = registry.size;
    for (const t of [...registry]) t.cancel();
    return n;
  }
  static clearAll() {
    return Timer.cancelAll();
  }

  /** Сериализация состояния. */
  toJSON() {
    return {
      class: "Timer",
      state: this._state,
      countup: this.countup,
      duration: this.duration,
      interval: this.interval,
      repeat: this.repeat,
      done: this._done,
      elapsed: Math.round(this.elapsed * 100) / 100,
      remaining: this.remaining,
      progress: this.progress,
      startAt: this._startTimer > 0 ? new Date(Date.now() + this._startTimer).toISOString() : null,
    };
  }
}

/* --------------------------- Форматирование --------------------------- */

/**
 * ms -> "HH:MM:SS.mmm". Опции: { hh=true, mm=true, ss=true, ms=true, pad=true }.
 */
export function formatMs(ms, opts = {}) {
  const { hh = true, mm = true, ss = true, mil = true, pad = true } = opts;
  let n = Math.max(0, Math.round(ms));
  const milli = n % 1000;
  n = Math.floor(n / 1000);
  const sec = n % 60;
  n = Math.floor(n / 60);
  const min = n % 60;
  n = Math.floor(n / 60);
  const hr = n;

  const parts = [];
  if (hh) parts.push(pad ? String(hr).padStart(2, "0") : String(hr));
  if (mm) parts.push(pad ? String(min).padStart(2, "0") : String(min));
  if (ss) parts.push(pad ? String(sec).padStart(2, "0") : String(sec));
  let out = parts.join(":");
  if (mil) out += "." + String(milli).padStart(3, "0");
  return out;
}

/** Короткие названия единиц для fromNow. */
const UNITS = [
  [86400000, "дн"],
  [3600000, "ч"],
  [60000, "мин"],
  [1000, "сек"],
];

/**
 * Человекочитаемое описание промежутка ("через 5 мин", "3 сек назад").
 * @param {number|Date} val  мс или момент времени
 */
export function fromNow(val) {
  const ms = val instanceof Date ? val.getTime() - Date.now() : val;
  const abs = Math.abs(ms);
  let unit = UNITS.find(([size]) => abs >= size);
  if (!unit) unit = [1, "мс"];
  const [size, label] = unit;
  const v = Math.max(1, Math.round(abs / size));
  return ms < 0 ? `${v} ${label} назад` : `через ${v} ${label}`;
}

/* ------------------------------ TimeSpan ------------------------------ */

/** Арифметика длительностей: сложение, вычитание, сравнение, формат. */
export class TimeSpan {
  constructor(ms = 0) {
    this.ms = ms;
  }

  static fromMs(ms) {
    return new TimeSpan(ms);
  }
  static fromSeconds(s) {
    return new TimeSpan(s * 1000);
  }
  static fromMinutes(m) {
    return new TimeSpan(m * 60000);
  }
  static fromHours(h) {
    return new TimeSpan(h * 3600000);
  }
  static fromDays(d) {
    return new TimeSpan(d * 86400000);
  }
  /** Разница между двумя датами (по модулю). */
  static between(a, b) {
    return new TimeSpan(Math.abs(new Date(a).getTime() - new Date(b).getTime()));
  }

  add(other) {
    return new TimeSpan(this.ms + (other instanceof TimeSpan ? other.ms : other));
  }
  subtract(other) {
    return new TimeSpan(this.ms - (other instanceof TimeSpan ? other.ms : other));
  }
  multiply(factor) {
    return new TimeSpan(this.ms * factor);
  }
  isLongerThan(other) {
    return this.ms > (other instanceof TimeSpan ? other.ms : other);
  }
  isShorterThan(other) {
    return this.ms < (other instanceof TimeSpan ? other.ms : other);
  }

  toSeconds() {
    return this.ms / 1000;
  }
  toMinutes() {
    return this.ms / 60000;
  }
  toHours() {
    return this.ms / 3600000;
  }
  toDays() {
    return this.ms / 86400000;
  }
  toString() {
    return formatMs(this.ms);
  }
  valueOf() {
    return this.ms;
  }
}

/* ----------------------------- Cron / Schedule ----------------------------- */

const FIELD = ["sec", "min", "hour", "day", "month", "dow"];
const FIELD_MIN = [0, 0, 0, 1, 1, 0];
const FIELD_MAX = [59, 59, 23, 31, 12, 6];

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseVal(s, names) {
  const low = s.toLowerCase();
  if (names && low.length === 3 && names[low] !== undefined) return names[low];
  return Number(s);
}

function expandPart(p, min, max, names) {
  if (p === "*") {
    const set = new Set();
    for (let i = min; i <= max; i++) set.add(i);
    return [set];
  }
  const m = p.match(/^([\d*]+|\w{3})(?:-([\d*]+|\w{3}))?(?:\/(\d+))?$/);
  if (!m) throw new Error(`bad schedule field "${p}"`);
  if (m[1] === "*") {
    const step = m[3] ? Number(m[3]) : 1;
    const set = new Set();
    for (let i = min; i <= max; i += step) set.add(i);
    return [set];
  }
  const a = parseVal(m[1], names);
  const b = m[2] ? parseVal(m[2], names) : a;
  const step = m[3] ? Number(m[3]) : 1;
  if (a < min || b > max) throw new Error(`schedule value out of range in "${p}"`);
  const set = new Set();
  for (let v = a; v <= b; v += step) set.add(v);
  return [set];
}

function parseField(str, idx, names) {
  let union = null;
  for (const part of str.split(",")) {
    const sets = expandPart(part.trim(), FIELD_MIN[idx], FIELD_MAX[idx], names);
    for (const s of sets) {
      if (!union) union = new Set();
      for (const v of s) union.add(v);
    }
  }
  return union;
}

/** Cron-подобное расписание: "сек мин час день месяц день_недели". */
export class Schedule {
  /**
   * @param {string} expr  6 полей. Имена: JAN..DEC, SUN..SAT (гж. MON-FRI).
   */
  constructor(expr) {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 6) throw new Error("schedule needs 6 fields: sec min hour day month dow");
    this.pattern = expr.trim();
    this.fields = fields.map((f, i) => {
      const names = i === 4 ? MONTHS : i === 5 ? DAYS : null;
      return parseField(f, i, names);
    });
  }

  matches(date) {
    const v = [date.getSeconds(), date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
    for (let i = 0; i < 6; i++) if (!this.fields[i].has(v[i])) return false;
    return true;
  }

  nextFrom(date = new Date()) {
    const d = new Date(date);
    d.setMilliseconds(999);
    for (let i = 0; i < 300000; i++) {
      d.setSeconds(d.getSeconds() + 1);
      if (this.matches(d)) return d;
    }
    return null;
  }

  next(date = new Date()) {
    return this.nextFrom(date);
  }

  toJSON() {
    return { class: "Schedule", pattern: this.pattern };
  }
}

/**
 * Запустить задачу по расписанию.
 * @param {string|Schedule} schedule
 * @param {function} fn
 * @param {object} [opts]  { timezoneOffsetMs, immediate }
 * @returns {{ stop, promise, next }}
 */
export function scheduleJob(schedule, fn, opts = {}) {
  const sched = schedule instanceof Schedule ? schedule : new Schedule(schedule);
  const tz = opts.timezoneOffsetMs || 0;
  let stopped = false;

  const compute = () => sched.nextFrom(new Date(Date.now() + tz));
  const waitMs = (target) => Math.max(0, target.getTime() - Date.now() - tz);

  const loop = async () => {
    while (!stopped) {
      const next = compute();
      if (!next) break;
      const ms = waitMs(next);
      if (ms > 0) await sleep(ms);
      if (stopped) break;
      try {
        fn(next);
      } catch (err) {
        if (typeof console !== "undefined") console.error(err);
      }
    }
  };

  if (opts.immediate) fn(new Date(Date.now() + tz));
  const p = loop();
  return {
    stop: () => {
      stopped = true;
    },
    promise: p,
    next: compute,
  };
}

/* ----------------------------- Менеджер задач ----------------------------- */

function firstDelayMs(when, opts) {
  if (opts && opts.startIn != null && opts.startIn > 0) return opts.startIn;
  return timeUntil(when);
}

/**
 * Jobs — менеджер вызываемых функций по системе.
 * Добавление, удаление, перезапись, частичное обновление задач по id.
 */
export class Jobs {
  constructor(onError) {
    this._map = new Map();
    this.onError = onError || null;
  }

  add(id, when, fn, opts = {}) {
    if (this._map.has(id)) throw new Error(`job "${id}" already exists`);
    return this._create(id, when, fn, opts);
  }

  set(id, when, fn, opts = {}) {
    if (this._map.has(id)) this.remove(id);
    return this._create(id, when, fn, opts);
  }

  overwrite(id, when, fn, opts = {}) {
    return this.set(id, when, fn, opts);
  }

  patch(id, patch = {}) {
    const job = this._get(id);
    const { when, fn, ...rest } = patch;
    job._stop();
    if (fn !== undefined) job.fn = fn;
    job.opts = { ...job.opts, ...rest };
    if (when !== undefined) job.when.raw = when;
    job.runs = 0;
    job._schedule();
    return job;
  }

  setTime(id, when) {
    return this.patch(id, { when });
  }

  setFn(id, fn) {
    return this.patch(id, { fn });
  }

  remove(id) {
    const job = this._map.get(id);
    if (!job) return false;
    job._stop();
    job.removed = true;
    this._map.delete(id);
    return true;
  }

  delete(id) {
    return this.remove(id);
  }

  clear() {
    for (const id of this._map.keys()) this.remove(id);
  }

  // ------------------------- пауза / возобновление -------------------------

  pause(id) {
    const job = this._get(id);
    job._stop();
    return job;
  }

  resume(id) {
    const job = this._get(id);
    job.runs = 0;
    job._schedule();
    return job;
  }

  startAll() {
    for (const job of this._map.values()) job._schedule();
    return this.size;
  }

  stopAll() {
    for (const job of this._map.values()) job._stop();
    return this.size;
  }

  // ------------------------------ запросы ------------------------------

  get(id) {
    return this._map.get(id);
  }

  has(id) {
    return this._map.has(id);
  }

  get size() {
    return this._map.size;
  }

  list() {
    return [...this._map.values()];
  }

  next() {
    let best = null;
    for (const job of this._map.values()) {
      if (job.nextAt && (!best || job.nextAt < best.nextAt)) best = job;
    }
    return best;
  }

  toJSON() {
    return this.list().map((j) => ({
      id: j.id,
      when: typeof j.when.raw === "string" ? j.when.raw : j.when.raw?.toISOString?.() ?? j.when.raw,
      opts: j.opts,
      runs: j.runs,
      lastAt: j.lastAt ? j.lastAt.toISOString() : null,
      nextAt: j.nextAt ? j.nextAt.toISOString() : null,
    }));
  }

  _get(id) {
    const job = this._map.get(id);
    if (!job) throw new Error(`job "${id}" not found`);
    return job;
  }

  _create(id, when, fn, opts) {
    const job = {
      id,
      fn,
      when: { raw: when },
      opts,
      runs: 0,
      lastAt: null,
      nextAt: null,
      removed: false,
      timer: null,
    };

    job._stop = () => {
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
      job.nextAt = null;
    };

    job._fire = () => {
      job.timer = null;
      if (job.removed) return;
      job.runs++;
      job.lastAt = new Date();
      try {
        job.fn({ id: job.id, runs: job.runs, at: job.lastAt, job });
      } catch (err) {
        if (typeof this.onError === "function") this.onError(err, job);
        else queueMicrotask(() => {
          throw err;
        });
      }
      job._schedule();
    };

    job._schedule = () => {
      job._stop();
      if (job.removed) return;
      const delay = this._nextDelay(job);
      if (delay == null) return;
      job.nextAt = new Date(Date.now() + delay);
      job.timer = setTimeout(job._fire, delay);
    };

    this._map.set(id, job);
    job._schedule();
    return job;
  }

  _nextDelay(job) {
    const opts = job.opts || {};

    if (job.runs === 0) {
      return firstDelayMs(job.when.raw, opts);
    }

    if (opts.count != null && job.runs >= opts.count) return null;

    if (opts.interval != null) {
      return Math.max(0, job.lastAt.getTime() + opts.interval - Date.now());
    }

    if (opts.repeat === Infinity && typeof job.when.raw === "string") {
      return timeUntil(job.when.raw) || 86400000;
    }

    return null;
  }
}

/* --------------------------- Утилиты ожидания --------------------------- */

/** sleep-промис с возможностью отмены (AbortSignal). */
export function sleepMs(ms, signal) {
  return new Promise((resolve, reject) => {
    const id = setTimeout(resolve, ms);
    signal &&
      signal.addEventListener("abort", () => {
        clearTimeout(id);
        reject(new Error("aborted"));
      });
  });
}

/** Простой промис-таймер ожидания: await wait(1000). */
export function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Повторная попытка асинхронной функции с экспоненциальной задержкой и джиттером.
 * @param {Function} fn  fn(attemptIndex)
 * @param {object} opts  { attempts=4, baseDelay=100, factor=2, maxDelay=15000, jitter=true }
 */
export async function retry(fn, opts = {}) {
  const { attempts = 4, baseDelay = 100, factor = 2, maxDelay = 15000, jitter = true } = opts;
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) throw err;
      let d = Math.min(maxDelay, baseDelay * Math.pow(factor, i));
      if (jitter) d += Math.random() * d;
      await wait(d);
    }
  }
  throw lastErr;
}

/**
 * debounce: вызов fn не чаще чем через ms после последнего вызова.
 * Возвращает функцию с .cancel() и .flush().
 */
export function debounce(fn, ms = 100) {
  let id = null;
  let lastArgs;
  const wrapped = function (...args) {
    lastArgs = args;
    clearTimeout(id);
    id = setTimeout(() => {
      id = null;
      fn(...lastArgs);
    }, ms);
  };
  wrapped.cancel = () => clearTimeout(id);
  wrapped.flush = () => {
    if (id) {
      clearTimeout(id);
      id = null;
      fn(...lastArgs);
    }
  };
  return wrapped;
}

/**
 * throttle: вызывать fn не чаще чем раз в ms.
 * Возвращает функцию с .cancel().
 */
export function throttle(fn, ms = 100) {
  let last = 0;
  let id = null;
  let lastArgs;
  const wrapped = function (...args) {
    const nowT = Date.now();
    const since = nowT - last;
    lastArgs = args;
    if (id) return;
    if (since >= ms) {
      last = nowT;
      fn(...args);
    } else {
      clearTimeout(id);
      id = setTimeout(() => {
        id = null;
        last = Date.now();
        fn(...lastArgs);
      }, ms - since);
    }
  };
  wrapped.cancel = () => clearTimeout(id);
  return wrapped;
}

/* ------------------------------ Stopwatch ------------------------------ */

/** Хронометр (секундомер): время между start и stop, с паузами. */
export class Stopwatch {
  constructor() {
    this._start = null;
    this._acc = 0;
    this._running = false;
  }
  start() {
    if (!this._running) {
      this._start = now();
      this._running = true;
    }
    return this;
  }
  pause() {
    if (this._running) {
      this._acc += now() - this._start;
      this._running = false;
    }
    return this;
  }
  reset() {
    this._start = null;
    this._acc = 0;
    this._running = false;
    return this;
  }
  get elapsed() {
    return this._acc + (this._running ? now() - this._start : 0);
  }
  get isRunning() {
    return this._running;
  }
  toString() {
    return formatMs(this.elapsed);
  }
}

export default Timer;