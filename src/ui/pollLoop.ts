/**
 * A SELF-RESCHEDULING POLL THAT CAN BE WOKEN — with one request in flight and one timer
 * pending, AT MOST, however it is woken.
 *
 * `useFriends` used to do this inline and got it wrong in the way that is easy to get wrong:
 * `wake` cleared the pending timer and ran a poll, but did not know a poll might already be on
 * the wire, and each finished poll's `schedule()` overwrote the timer handle without clearing
 * the one already there. Coming back to a tab fires `visibilitychange`, `focus` and the idle
 * detector's wake together, so every return started two or three concurrent `/api/friends`
 * reads, and each of their `finally`s armed a timer — only the last of which anybody could
 * cancel. The orphans kept firing and re-arming, so a session that switched tabs a dozen times
 * was running a dozen poll chains against an endpoint that reads the database.
 *
 * DOM-free and clock-injected, so the smoke run drives it with a fake timer.
 */
export interface PollLoop {
  /** poll NOW (cancelling the pending timer), unless a poll is already in flight — that one's
   *  answer is as fresh as a new one would be, and it reschedules when it lands */
  wake(): void;
  /** stop for good: cancel the timer and ignore whatever is still in flight */
  stop(): void;
}

export interface PollLoopOptions<Timer> {
  /** one poll. Returns the delay (ms) before the next one — synchronously for a poll that made no
   *  request (an unattended page just re-checks later), or as a promise that settles when the
   *  request has. A rejected promise is treated as "try again in `fallbackMs`". */
  run: () => number | Promise<number>;
  setTimer: (fn: () => void, ms: number) => Timer;
  clearTimer: (t: Timer) => void;
  /** the next delay when `run` rejects */
  fallbackMs: number;
}

export function startPollLoop<Timer>(opts: PollLoopOptions<Timer>): PollLoop {
  let timer: Timer | undefined;
  let inFlight = false;
  let stopped = false;

  const cancel = (): void => {
    if (timer !== undefined) opts.clearTimer(timer);
    timer = undefined;
  };
  const schedule = (ms: number): void => {
    if (stopped) return;
    cancel(); // never two pending: the handle being replaced is the one nobody could clear
    timer = opts.setTimer(tick, ms);
  };
  function tick(): void {
    timer = undefined;
    if (stopped || inFlight) return;
    let next: number | Promise<number>;
    try {
      next = opts.run();
    } catch {
      schedule(opts.fallbackMs);
      return;
    }
    if (typeof next === 'number') {
      schedule(next);
      return;
    }
    inFlight = true;
    next.then(
      (ms) => {
        inFlight = false;
        schedule(ms);
      },
      () => {
        inFlight = false;
        schedule(opts.fallbackMs);
      },
    );
  }

  tick();
  return {
    wake: () => {
      if (stopped || inFlight) return;
      cancel();
      tick();
    },
    stop: () => {
      stopped = true;
      cancel();
    },
  };
}
