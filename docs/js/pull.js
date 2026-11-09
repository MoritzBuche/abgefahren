// Pull down at the top of the page to refresh, as in native apps. A round
// indicator follows the finger. If a refresh is not allowed yet, it shows the
// struck-through symbol and shakes instead.

// Distances are counted from the hidden position above the screen edge. With a
// 44 px indicator, a travel of 64 puts its top edge exactly at the screen edge.
const TRIGGER = 100; // px the indicator has to travel to trigger a refresh
const MAX_TRAVEL = 160; // the pull gets stiffer towards this distance
const REST = 112; // where the indicator waits while loading: fully on screen
const HIDDEN = -64; // above the screen edge
const BLOCKED_MS = 1100;

export function setupPullToRefresh({ indicator, isAllowed, refresh, ignore }) {
  let startY = null;
  let travel = 0;
  let pulling = false;
  let busy = false;

  function place(distance, animate) {
    indicator.style.transition = animate ? "" : "none";
    indicator.style.transform = `translate(-50%, ${HIDDEN + distance}px)`;
    indicator.style.opacity = String(Math.min(distance / (TRIGGER * 0.6), 1));
    indicator.style.setProperty("--turn", `${(distance / TRIGGER) * 270}deg`);
  }

  function hide() {
    indicator.classList.remove("is-ready", "is-loading", "is-blocked", "is-shaking");
    place(0, true);
  }

  function reset() {
    startY = null;
    pulling = false;
  }

  document.addEventListener("touchstart", (event) => {
    if (busy || event.touches.length !== 1 || window.scrollY > 0 || ignore(event.target)) {
      reset();
      return;
    }
    startY = event.touches[0].clientY;
    travel = 0;
  }, { passive: true });

  document.addEventListener("touchmove", (event) => {
    if (startY === null) return;
    const dy = event.touches[0].clientY - startY;
    if (!pulling) {
      // A first move upwards is normal scrolling.
      if (dy <= 0 || window.scrollY > 0) {
        reset();
        return;
      }
      pulling = true;
      indicator.classList.toggle("is-blocked", !isAllowed());
    }
    // Stops the browser's own bounce or page reload while the app handles the pull.
    if (event.cancelable) event.preventDefault();
    travel = MAX_TRAVEL * (1 - Math.exp(-Math.max(dy, 0) / MAX_TRAVEL));
    indicator.classList.toggle("is-ready", travel >= TRIGGER);
    place(travel, false);
  }, { passive: false });

  async function release() {
    if (!pulling) {
      reset();
      return;
    }
    reset();
    if (travel < TRIGGER) {
      hide();
      return;
    }
    busy = true;
    place(REST, true);
    if (isAllowed()) {
      indicator.classList.remove("is-blocked");
      indicator.classList.add("is-loading");
      try {
        await refresh();
      } finally {
        hide();
        busy = false;
      }
    } else {
      indicator.classList.add("is-blocked", "is-shaking");
      setTimeout(() => {
        hide();
        busy = false;
      }, BLOCKED_MS);
    }
  }

  document.addEventListener("touchend", release);
  document.addEventListener("touchcancel", release);
}
