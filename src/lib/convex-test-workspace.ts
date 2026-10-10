import { convexTest as rawConvexTest } from "convex-test";
import { getFunctionName, type FunctionReference } from "convex/server";
import { api } from "../convex/_generated/api";
import { fingerprint, type Workspace } from "./workspace-changes";

/** Only sequential setup fixtures use fresh bases. Concurrency regression tests
 * use raw convex-test and carry deliberately stale preconditions themselves.
 */
function wrap<T extends object>(actor: T): T {
  return new Proxy(actor, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property === "withIdentity" && typeof value === "function") {
        return (...args: unknown[]) => wrap(Reflect.apply(value, target, args) as object);
      }
      if (property === "mutation" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const reference = args[0];
          if (typeof reference !== "function") {
            const name = getFunctionName(reference as FunctionReference<"mutation">);
            if (["planner:replaceState", "planner:deleteProject", "planner:deleteTasks", "planner:deleteResource", "planner:deleteCalendar", "planner:deleteTemplate", "planner:hideTemplate"].includes(name)) {
              const input = (args[1] ?? {}) as Record<string, unknown>;
              if (!("expected" in input)) {
                const query = Reflect.get(target, "query") as (...args: unknown[]) => Promise<unknown>;
                const state = await Reflect.apply(query, target, [api.planner.getState, {}]);
                args[1] = { ...input, expected: await fingerprint((state ?? {}) as Workspace) };
              }
            }
          }
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
export const convexTest: typeof rawConvexTest = new Proxy(rawConvexTest, {
  apply(target, thisArg, args) { return wrap(Reflect.apply(target, thisArg, args) as object); },
});
