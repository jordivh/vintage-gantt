/** Convex Auth must never access a throwing localStorage getter during render. */
export function authStorage(browser: Pick<Window, "localStorage">): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  try {
    const storage = browser.localStorage;
    const probe = `__vintage_auth_probe_${Math.random().toString(36).slice(2)}`;
    storage.setItem(probe, probe);
    storage.getItem(probe);
    storage.removeItem(probe);
    // Keep the native object so Convex Auth's cross-tab storage events still work.
    return storage;
  } catch {
    // Privacy settings / embedded browsers can reject even reading localStorage.
    // In that case tokens last only for this page, never on disk.
    const values = new Map<string, string>();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
  }
}
