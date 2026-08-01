const ACTION_SESSION_FRAGMENT = "icarus-action-session";
export const ACTION_SESSION_STORAGE_KEY = "icarus.action-session";
const ACTION_SESSION_CHANGE_EVENT = "icarus:action-session-change";

const CANONICAL_ACTION_SESSION_PATTERN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const ACTION_SESSION_FRAGMENT_PATTERN =
  /^#icarus-action-session=([A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])$/;

export function isCanonicalActionSession(value: string): boolean {
  return CANONICAL_ACTION_SESSION_PATTERN.test(value);
}

function removeActionSessionFragment(): void {
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

export function clearActionSession(): void {
  let changed = false;
  try {
    changed = window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY) !== null;
    window.sessionStorage.removeItem(ACTION_SESSION_STORAGE_KEY);
  } catch {
    // An unavailable session store is already a fail-closed, review-only state.
  }
  if (changed) window.dispatchEvent(new Event(ACTION_SESSION_CHANGE_EVENT));
}

export function bootstrapActionSession(): void {
  const fragment = window.location.hash;
  const match = ACTION_SESSION_FRAGMENT_PATTERN.exec(fragment);

  if (match !== null) {
    const candidate = match[1];
    if (candidate === undefined) {
      clearActionSession();
      removeActionSessionFragment();
      return;
    }
    try {
      window.sessionStorage.setItem(ACTION_SESSION_STORAGE_KEY, candidate);
      window.dispatchEvent(new Event(ACTION_SESSION_CHANGE_EVENT));
    } catch {
      clearActionSession();
    }
    removeActionSessionFragment();
    return;
  }

  if (fragment.includes(ACTION_SESSION_FRAGMENT)) {
    clearActionSession();
    removeActionSessionFragment();
    return;
  }

  const stored = getActionSession();
  if (stored === null) {
    clearActionSession();
  }
}

export function getActionSession(): string | null {
  try {
    const value = window.sessionStorage.getItem(ACTION_SESSION_STORAGE_KEY);
    if (value !== null && isCanonicalActionSession(value)) return value;
  } catch {
    return null;
  }
  clearActionSession();
  return null;
}

export function hasActionSession(): boolean {
  return getActionSession() !== null;
}

export function subscribeActionSessionAvailability(listener: () => void): () => void {
  window.addEventListener(ACTION_SESSION_CHANGE_EVENT, listener);
  return () => window.removeEventListener(ACTION_SESSION_CHANGE_EVENT, listener);
}
