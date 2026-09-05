<div align="center">

# ⏱️ light-timer

**A featherweight timer library with zero dependencies.**
Countdowns, stopwatches, cron schedules, jobs, retries & debounce in a single ~32 KB ESM file.

[![npm version](https://img.shields.io/badge/npm-light--timer-blue.svg)](https://www.npmjs.com/package/light-timer)
[![License](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)

</div>

---

## ✨ Why light-timer?

```bash
npm install light-timer
```

No build step. No dependencies. No `node_modules` bloat. Just import it and go —
works in **Node.js**, **browsers**, and **Deno** (ESM).

---

## 🚀 Quick start

```js
import { Timer } from "light-timer";

// Countdown
const timer = new Timer({ duration: 5000 });
await timer; // resolves when done

// With callbacks
new Timer({
  duration: 10_000,
  onTick: (elapsed) => updateProgressBar(elapsed),
  onComplete: () => console.log("Time's up!"),
});
```

That's it. One timer, every way to use it.

---

## 🧭 Feature overview

| Timer core | Scheduling | Interop | Utilities |
|---|---|---|---|
| countdown / countup | `startAt` with system clock | EventEmitter (`.on/.once/off`) | `formatMs` |
| pause / resume / reset | cron-style `Schedule` (`MON-FRI`) | `addEventListener` (EventTarget) | `TimeSpan` |
| restart / retrigger | `scheduleJob` | `subscribe` (RxJS-compatible) | `fromNow` |
| repeat / interval | `Jobs` manager (add/remove/overwrite) | async iterator (`for await`) | `timeUntil` |
| global registry | one-shot · every · after | promises (`await t.then`) | `retry` |
| `unref()` for Node | count limits & daily repeats | `Timer.fromPromise` | `debounce` / `throttle` |
| error handling (`onError`) | — | JSON serialization | `Stopwatch` / `wait` / `sleepMs` |

---

## 📦 Core API

### `Timer`

```js
const t = new Timer({
  duration: 2000,          // ms; 0 = never auto-completes
  interval: 500,           // repeat mode: fire every 500 ms
  countup: true,           // count upward instead of down
  repeat: 3,               // total cycles; Infinity = forever
  startIn: 1000,           // delayed start (ms)
  startAt: "14:30:00",     // or Date / timestamp — system clock
  autostart: true,         // start immediately (default)
  onTick: (elapsed) => {}, // ~every 32 ms
  onStart / onPause / onResume / onCancel / onComplete,
  onError: (err) => {},    // safety net for callback errors
});
```

**Lifecycle control:**

```js
t.pause();     // freeze
t.resume();    // continue
t.reset();     // zero-out
t.restart();   // reset + start
t.retrigger(); // refresh current cycle
t.cancel();    // stop forever
t.unref();     // Node: don't keep the process alive
```

**State & introspection:**

```js
t.state            // "idle" | "running" | "paused" | "done" | "cancelled"
t.elapsed          // ms elapsed
t.remaining        // ms left (countdown)
t.progress         // 0..1
t.cycles           // completed cycles
t.isRunning / t.isPaused / t.isDone / t.isCancelled / t.isIdle
```

**Wait for completion — any style:**

```js
await t;                  // thenable
await t.done;             // explicit promise
t.then(() => {});         // promise chaining
```

### Factory shortcuts

```js
Timer.after(1000, () => {});                    // run once in 1s
Timer.every(1000, () => {});                    // tick every second
Timer.delay(500);                               // `await` a pause
Timer.startAt("15:00", { duration: 60_000 });   // start at wall-clock time
Timer.fromPromise(fetch("/api"));               // time a promise — resolves on done, cancels on reject
```

### Static registry

```js
Timer.list();        // all live timers
Timer.count();
Timer.pauseAll();
Timer.resumeAll();
Timer.cancelAll();   // nuke everything
```

---

## ⏰ Scheduling

### `Schedule` — cron, but readable

Six fields: `sec min hour day month dow`. Supports names & ranges:

```js
import { Schedule, scheduleJob } from "light-timer";

const s = new Schedule("0 0 9 * * MON-FRI");     // 09:00, weekdays only

s.matches(new Date());
s.next();                  // next matching Date (or null)
s.nextFrom(new Date());    // search from a given point

scheduleJob("*/5 * * * * *", (at) => {
  console.log("every 5 seconds:", at);
});
```

| Example | Meaning |
|---|---|
| `0 0 12 * * *` | every day at noon |
| `30 15 * * MON-FRI` | 15:30 weekdays |
| `* * * * JAN,JUN *` | every second in January & June |
| `0 9 * * * SUN` | 09:00 on Sundays |
| `0 0 0 1 * *` | midnight on the 1st of each month |

### `Jobs` — named, manageable tasks

Add, remove, overwrite, and hot-update functions by id:

```js
const jobs = new Jobs(onError);

jobs.add("beep", "14:30:00", () => buzzer.on(), { interval: 1000, count: 10 });
jobs.set("beep", "15:00:00", () => buzzer.off());   // overwrite (upsert)
jobs.patch("beep", { when: "16:00", count: 3 });    // partial update
jobs.setTime("beep", "17:30");
jobs.setFn("beep", newFn);

jobs.pause("beep");   jobs.resume("beep");
jobs.remove("beep");  jobs.delete("beep");
jobs.clear();

jobs.get("beep");     jobs.has("beep");
jobs.list();          jobs.next();   // soonest run
JSON.stringify(jobs); // serialize
```

---

## 🔌 Interop — play nicely with others

### Events (Node `EventEmitter` style)

```js
const t = new Timer({ duration: 1000 });
t.on("tick", (el) => render(el));
t.once("complete", () => cleanup());
const off = t.on("pause", handler);
off();  // or t.off("pause", handler)
```

Events: `start`, `tick`, `pause`, `resume`, `cancel`, `complete`, `error`.

### DOM / EventTarget

```js
t.addEventListener("tick", fn);
t.removeEventListener("tick", fn);
```

### RxJS-style `subscribe`

```js
const unsubscribe = t.subscribe({
  next: (elapsed) => update(elapsed),
  error: (err) => handleError(err),
  complete: () => done(),
});
```

Bridges trivially into RxJS: `from(t.subscribe)` and friends.

### Async iteration

```js
for await (const elapsed of new Timer({ duration: 2000 })) {
  console.log("tick", elapsed);   // yields every ~32 ms
}
```

### Promises

```js
const t = Timer.fromPromise(myPromise); // measures promise duration
await t;
```

Synergy with any async/await toolchain — no adapter layer needed.

---

## 🧰 Utilities

```js
import { formatMs, TimeSpan, fromNow, timeUntil, retry, debounce, throttle, Stopwatch, wait, sleepMs } from "light-timer";

formatMs(2_501_345);                 // "00:41:41.345"
new TimeSpan(90_000).toMinutes();    // 1.5
const a = TimeSpan.fromMinutes(5).add(TimeSpan.fromSeconds(30));
a.toString();                        // "00:05:30.000"

fromNow(90_000);                     // "in 2 min"
fromNow(Date.now() - 120_000);       // "2 min ago"
timeUntil("23:59:59");               // ms until midnight

const res = await retry(fetchRemote, { attempts: 5, baseDelay: 100, jitter: true });

const save = debounce(() => persist(), 300);
const log  = throttle(() => console.log("go"), 100);

const sw = new Stopwatch();
sw.start(); await wait(200); sw.pause(); sw.elapsed;
```

---

## 🧑‍💻 Browser & Node

```html
<script type="module">
  import { Timer } from "https://unpkg.com/light-timer/timer.js";
  Timer.every(1000, () => drawClock());
</script>
```

Node: combine with `unref()` to avoid keeping the event loop alive in long-running servers.

---

## 🧪 Try it

```bash
git clone https://github.com/devoffeed/light-timer
cd light-timer
node demo.js
```

Run the demo to see countdowns, pause/resume, cron, `Jobs`, retry, debounce, and interop in action.

---

## 📄 License

Apache License 2.0 — see [LICENSE](LICENSE).