import { describe, expect, test } from "bun:test";
import { authStorage } from "./auth-storage";

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    values,
  };
};

describe("browser auth storage", () => {
  test("uses native storage and preserves existing sessions", () => {
    const native = memory();
    native.setItem("session", "existing-token");
    const storage = authStorage({ localStorage: native as unknown as Storage });
    expect(storage).toBe(native);
    expect(storage.getItem("session")).toBe("existing-token");
    expect(native.values.size).toBe(1);
    storage.setItem("refresh", "new-token");
    expect(native.getItem("refresh")).toBe("new-token");
    storage.removeItem("session");
    expect(native.getItem("session")).toBeNull();
  });

  test("blocked storage getter still supports sign-in, refresh and sign-out", () => {
    const browser = { get localStorage(): Storage { throw new DOMException("Storage blocked", "SecurityError"); } };
    const storage = authStorage(browser);
    expect(storage.getItem("token")).toBeNull();
    storage.setItem("token", "access-token");
    storage.setItem("refresh", "refresh-token");
    expect(storage.getItem("token")).toBe("access-token");
    expect(storage.getItem("refresh")).toBe("refresh-token");
    storage.removeItem("token");
    storage.removeItem("refresh");
    expect(storage.getItem("token")).toBeNull();
    expect(storage.getItem("refresh")).toBeNull();
    // No disk storage: a new page starts signed out.
    expect(authStorage(browser).getItem("token")).toBeNull();
  });

  test("read-only storage falls back without touching existing tokens", () => {
    const native = memory();
    native.setItem("token", "existing-token");
    const blocked = { ...native, setItem: () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); } };
    const storage = authStorage({ localStorage: blocked as unknown as Storage });
    storage.setItem("token", "new-token");
    expect(storage.getItem("token")).toBe("new-token");
    expect(native.getItem("token")).toBe("existing-token");
  });
});
