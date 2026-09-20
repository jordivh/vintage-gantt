// Minimal ambient declaration for the Bun test runner API used by this project,
// so `tsc` can typecheck test files without pulling in the full bun-types package.
declare module "bun:test" {
  interface Matchers<T = unknown> {
    toBe(expected: T): void;
    toEqual(expected: T): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toContain(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeLessThan(expected: number): void;
    not: Matchers<T>;
  }
  export function expect<T = unknown>(actual: T): Matchers<T>;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
}
