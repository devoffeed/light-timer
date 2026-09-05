import Timer, {
  Schedule,
  Stopwatch,
  wait,
  Jobs,
  formatMs,
  TimeSpan,
  timeUntil,
  fromNow,
  retry,
  debounce,
  throttle,
} from "./timer.js";

async function main() {
  // --- Countdown с событиями и паузой ---
  const t = new Timer({
    duration: 800,
    onTick: (el) => console.log("tick", Math.round(el)),
    onComplete: () => console.log("done!"),
  });
  await wait(200);
  t.pause();
  console.log("paused at", Math.round(t.elapsed), "ms, isPaused:", t.isPaused);
  await wait(300);
  t.resume();
  await t.done;
  console.log("isDone:", t.isDone, "progress:", t.progress);

  // --- Повтор (repeat: 3 = ещё 3 раза после первого) ---
  let n = 0;
  const rep = new Timer({
    duration: 150,
    repeat: 3,
    onComplete: () => {
      n++;
      console.log("repeat complete #", n);
    },
  });
  rep.unref();
  console.log("repeat: 4 цикла за ~600ms. cycles:", rep.cycles);
  await wait(800);
  console.log("repeat done, n =", n);

  // --- interval-режим (исправлен!) ---
  let fires = 0;
  const iv = new Timer({
    interval: 200,
    repeat: 3,
    onTick: () => fires++,
    onComplete: () => console.log("interval done, всего тиков:", fires),
  });
  iv.unref();
  await wait(1100);
  console.log("interval fires:", fires);

  // --- каждый бесконечно: Timer.every ---
  let e = 0;
  const ev = Timer.every(120, () => e++);
  ev.unref();
  await wait(500);
  ev.cancel();
  console.log("Timer.every посчитал:", e);

  // --- Timer.after + startIn ---
  let after = false;
  Timer.after(300, () => {
    after = true;
    console.log("Timer.after сработал");
  }).unref();
  await wait(400);
  console.log("after:", after);

  // --- старт по системным часам ---
  const startTime = new Date(Date.now() + 2000);
  console.log("startAt демо: старт в", startTime.toTimeString().slice(0, 8));
  await Timer.startAt(startTime, { duration: 100, onStart: () => console.log("startAt: поехали!") });
  console.log("startAt: готово, timeUntil:", Math.round(timeUntil(startTime)), "мс");

  // --- Jobs: добавить / удалить / перезаписать ---
  const jobs = new Jobs();
  jobs.add("tick", Date.now() + 300, ({ id, runs }) => console.log(`[${id}] раз #${runs}`));
  await wait(400);
  console.log("has(tick):", jobs.has("tick"));
  jobs.overwrite("tick", Date.now() + 500, ({ id, runs }) => console.log(`[${id}] перезаписан #${runs}`));
  console.log("Jobs.JSON:", JSON.stringify(jobs.toJSON(), null, 1));
  await wait(600);
  jobs.remove("tick");
  jobs.clear();
  console.log("после clear:", jobs.size);

  // --- форматирование / TimeSpan ---
  console.log("formatMs:", formatMs(9012345)); // 2:30:12.345
  const span = TimeSpan.fromMinutes(90).add(TimeSpan.fromSeconds(12)).multiply(2);
  console.log("TimeSpan(90мин+12с)*2 =", span.toString(), "| часы:", span.toHours().toFixed(2));

  // --- fromNow ---
  console.log("fromNow(+90с):", fromNow(90000));
  console.log("fromNow(-2мин):", fromNow(-120000));

  // --- retry: эмулируем 3 ошибки, потом успех ---
  let attempts = 0;
  try {
    await retry(
      async () => {
        attempts++;
        if (attempts < 4) throw new Error("boom #" + attempts);
        return "успех";
      },
      { attempts: 5, baseDelay: 20, factor: 2, maxDelay: 100 },
    );
    console.log("retry: попыток =", attempts);
  } catch (e) {
    console.log("retry: сдался ->", e.message);
  }

  // --- debounce / throttle ---
  let db = 0;
  const debounced = debounce(() => db++, 50);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  debounced();
  debounced();
  debounced();
  await wait(80);
  console.log("debounce: вызвали 3 раза, сработало раз:", db);

  let th = 0;
  const throttled = throttle(() => th++, 50);
  for (let i = 0; i < 5; i++) {
    throttled();
    await wait(15);
  }
  await wait(60);
  console.log("throttle: за 5 вызовов с паузами 15мс -> раз:", th);

  // --- Stopwatch ---
  const sw = new Stopwatch().start();
  await wait(100);
  sw.pause();
  console.log("Stopwatch:", sw.toString(), "(после pause)");

  // --- Cron с именами дней ---
  const s = new Schedule("0 0 9 * * MON-FRI");
  console.log("Cron пн-пт 09:00, следующий:", s.next().toISOString());

  // --- глобальный реестр ---
  Timer.after(100000, () => {});
  console.log("Активных таймеров:", Timer.count());
  Timer.cancelAll();
  console.log("После cancelAll:", Timer.count(), "активных");

  // --- Интероп: EventEmitter + async-итератор + subscribe + fromPromise ---
  const ie = new Timer({ duration: 150 });
  const evLog = [];
  ie.on("start", () => evLog.push("start"));
  ie.once("complete", () => evLog.push("complete-once"));
  await ie.done;
  console.log("EventEmitter:", evLog.join(" -> "));

  const it = new Timer({ duration: 100 });
  let ticks = 0;
  for await (const v of it) ticks += v;
  console.log("for-await (сумма тиков):", Math.round(ticks));

  const sub = new Timer({ duration: 100 })
    .subscribe({
      next: () => {},
      complete: () => console.log("subscribe: complete"),
    });
  sub();

  const fp = Timer.fromPromise(Promise.resolve());
  await fp.done;
  console.log("fromPromise: state =", fp.state, "| elapsed ~", Math.round(fp.elapsed), "ms");

  console.log("\n=== всё прошло ===");
}

main();