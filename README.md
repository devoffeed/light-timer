# light-timer

Лёгкий таймер без зависимостей (ESM), один файл ~32KB.

- Countdown / countup / interval / repeat
- Пауза, возобновление, сброс, перезапуск
- Старт по системным часам: `startAt` (Date, `"HH:MM:SS"`, timestamp)
- Cron-подобное расписание с именами дней/месяцев (`MON-FRI`)
- `Jobs` — менеджер задач по id: добавить/удалить/перезаписать/обновить
- Интероп: EventEmitter, `addEventListener`, `subscribe` (RxJS), async-итератор, промисы
- Утилиты: `formatMs`, `TimeSpan`, `fromNow`, `timeUntil`, `retry`, `debounce`, `throttle`
- Глобальный реестр таймеров: `Timer.list()/count()/cancelAll()`

## Установка

```bash
npm install light-timer
# или просто скопируйте timer.js в проект
```

## Пример

```js
import { Timer, Jobs, Schedule } from "light-timer";

// Countdown с событиями
const t = new Timer({
  duration: 5000,
  onTick: (el) => console.log(el),
  onComplete: () => console.log("готово!"),
});

// Старт в конкретное время
Timer.startAt("14:30:00", { duration: 10000 });

// Повторяющаяся задача по id
const jobs = new Jobs();
jobs.add("beep", Date.now() + 1000, () => console.log("бип"), { interval: 2000, count: 5 });

// Cron
new Schedule("0 0 9 * * MON-FRI").next().toISOString();

// Интероп
for await (const v of new Timer({ duration: 1000 })) console.log(v);
```

## Лицензия

Apache License 2.0