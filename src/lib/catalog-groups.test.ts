import { describe, expect, test } from "bun:test";
import {
  CATALOG_GROUP_DEFAULTS,
  CATALOG_GROUP_ORDER,
  CATALOG_GROUP_STORAGE_KEY,
  catalogGroupStorage,
  readCatalogGroups,
  toggleCatalogGroup,
  writeCatalogGroups,
} from "./catalog-groups";

/** A tiny in-memory stand-in for localStorage. */
const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    data,
  };
};

describe("catalog group order", () => {
  test("is active projects, then templates, then archived", () => {
    expect(CATALOG_GROUP_ORDER).toEqual(["active", "template", "archived"]);
  });

  test("opens active projects and templates and folds the archive away on first use", () => {
    expect(CATALOG_GROUP_DEFAULTS).toEqual({ active: true, template: true, archived: false });
  });
});

describe("readCatalogGroups", () => {
  test("returns the defaults without any storage", () => {
    expect(readCatalogGroups()).toEqual({ active: true, template: true, archived: false });
    expect(readCatalogGroups(null)).toEqual({ active: true, template: true, archived: false });
  });

  test("returns the defaults the first time, before anything was saved", () => {
    expect(readCatalogGroups(memoryStorage())).toEqual({ active: true, template: true, archived: false });
  });

  test("reads a saved state back", () => {
    const storage = memoryStorage({ [CATALOG_GROUP_STORAGE_KEY]: JSON.stringify({ active: false, template: false, archived: true }) });
    expect(readCatalogGroups(storage)).toEqual({ active: false, template: false, archived: true });
  });

  test("falls back per group when only some groups were saved", () => {
    const storage = memoryStorage({ [CATALOG_GROUP_STORAGE_KEY]: JSON.stringify({ archived: true }) });
    expect(readCatalogGroups(storage)).toEqual({ active: true, template: true, archived: true });
  });

  test("ignores saved values that are not booleans", () => {
    const storage = memoryStorage({ [CATALOG_GROUP_STORAGE_KEY]: JSON.stringify({ active: "no", archived: 1, template: null }) });
    expect(readCatalogGroups(storage)).toEqual({ active: true, template: true, archived: false });
  });

  test("survives malformed or non-object payloads", () => {
    expect(readCatalogGroups(memoryStorage({ [CATALOG_GROUP_STORAGE_KEY]: "{not json" }))).toEqual({ active: true, template: true, archived: false });
    expect(readCatalogGroups(memoryStorage({ [CATALOG_GROUP_STORAGE_KEY]: "true" }))).toEqual({ active: true, template: true, archived: false });
    expect(readCatalogGroups(memoryStorage({ [CATALOG_GROUP_STORAGE_KEY]: "[1,2]" }))).toEqual({ active: true, template: true, archived: false });
  });

  test("survives a storage that refuses to be read", () => {
    const storage = { getItem: () => { throw new Error("blocked"); } };
    expect(readCatalogGroups(storage)).toEqual({ active: true, template: true, archived: false });
  });
});

describe("writeCatalogGroups", () => {
  test("round-trips through storage", () => {
    const storage = memoryStorage();
    writeCatalogGroups({ active: false, template: true, archived: true }, storage);
    expect(readCatalogGroups(storage)).toEqual({ active: false, template: true, archived: true });
  });

  test("does not throw without storage or when writing is refused", () => {
    const groups = { active: true, template: true, archived: false };
    let failure = "";
    try {
      writeCatalogGroups(groups, null);
      writeCatalogGroups(groups, { getItem: () => null, setItem: () => { throw new Error("quota"); } });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure).toBe("");
  });
});

describe("toggleCatalogGroup", () => {
  test("flips one group and leaves the others alone", () => {
    const start = { active: true, template: true, archived: false };
    expect(toggleCatalogGroup(start, "archived")).toEqual({ active: true, template: true, archived: true });
    expect(toggleCatalogGroup(start, "active")).toEqual({ active: false, template: true, archived: false });
    // the original object is never mutated
    expect(start).toEqual({ active: true, template: true, archived: false });
  });
});

describe("catalogGroupStorage", () => {
  test("is null outside a browser", () => {
    expect(catalogGroupStorage()).toBeNull();
  });
});
