/**
 * True test-body serialization for `bun test --concurrent`.
 *
 * Bun 1.3.11 type-declares `describe.serial`/`test.serial` but the runner does
 * not honor them (tests still interleave). This helper serializes at the
 * promise level instead: wrap each test body in `serial(...)` from one
 * `serialChain()` and every wrapped body waits for the previous wrapped body
 * to settle, regardless of how the runner schedules the tests.
 *
 *   const serial = serialChain();
 *   test("a", serial(async () => { ... }));
 *   test("b", serial(async () => { ... }));
 *
 * Note: a wrapped test's queue wait counts against its own timeout, so use
 * this with the raised timeout of the `test:concurrent` script.
 */
export function serialChain(): <T>(fn: () => Promise<T>) => () => Promise<T> {
  let chain: Promise<void> = Promise.resolve();
  return function serial<T>(fn: () => Promise<T>): () => Promise<T> {
    return () => {
      const run = chain.then(fn, fn);
      chain = run.then(
        () => {},
        () => {},
      );
      return run;
    };
  };
}
