import assert from "node:assert/strict";
import test from "node:test";

import {
  createRecoveryController,
  installViteRecovery,
  isDynamicImportFailure,
  wrapDynamicImport,
} from "../src/index.js";

const makeWindow = () => {
  const values = new Map();
  const listeners = new Map();
  const replacements = [];
  const historyReplacements = [];
  return {
    location: {
      href: "https://example.test/dashboard?tab=one#chart",
      replace: (url) => replacements.push(url),
    },
    history: {
      state: null,
      replaceState: (...argumentsList) => {
        historyReplacements.push(argumentsList);
      },
    },
    sessionStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    listeners,
    replacements,
    historyReplacements,
  };
};

test("reloads once for a stale dynamic import and prevents a loop", () => {
  const windowObject = makeWindow();
  const controller = createRecoveryController({
    windowObject,
    now: () => 1_000,
  });
  const error = new TypeError("Failed to fetch dynamically imported module");
  assert.equal(controller.recover(error), true);
  assert.equal(controller.recover(error), false);
  assert.equal(windowObject.replacements.length, 1);
});

test("reports recovery, suppression, and query cleanup without blocking", () => {
  const windowObject = makeWindow();
  const events = [];
  const controller = createRecoveryController({
    windowObject,
    now: () => 1_000,
    onEvent: (event) => {
      events.push(event);
      throw new Error("telemetry unavailable");
    },
  });
  const error = new TypeError("Failed to fetch dynamically imported module");

  assert.equal(controller.recover(error), true);
  assert.equal(controller.recover(error), false);
  assert.equal(events[0].type, "reload");
  assert.equal(events[0].attemptCount, 1);
  assert.equal(events[0].error, error);
  assert.match(events[0].reloadUrl, /__chunk_recovery=1000/u);
  assert.deepEqual(events[1], {
    type: "suppressed",
    url: "https://example.test/dashboard?tab=one#chart",
    attemptedAt: 1_000,
    previousAttemptedAt: 1_000,
    attemptCount: 1,
    remainingMs: 60_000,
    error,
  });

  const cleanupWindow = makeWindow();
  cleanupWindow.location.href =
    "https://example.test/dashboard?__chunk_recovery=1000";
  const cleanupEvents = [];
  createRecoveryController({
    windowObject: cleanupWindow,
    onEvent: (event) => cleanupEvents.push(event),
  }).clearRecoveryQuery();
  assert.deepEqual(cleanupEvents, [{
    type: "query-cleared",
    url: "https://example.test/dashboard",
  }]);
});

test("uses the recovery URL marker when session storage is unavailable", () => {
  const firstWindow = makeWindow();
  firstWindow.sessionStorage.getItem = () => {
    throw new Error("storage disabled");
  };
  firstWindow.sessionStorage.setItem = () => {
    throw new Error("storage disabled");
  };
  const error = new TypeError("Failed to fetch dynamically imported module");
  const firstController = createRecoveryController({
    windowObject: firstWindow,
    now: () => 1_000,
  });

  assert.equal(firstController.recover(error), true);
  assert.equal(firstWindow.replacements.length, 1);

  const secondWindow = makeWindow();
  secondWindow.location.href = firstWindow.replacements[0];
  secondWindow.sessionStorage.getItem = firstWindow.sessionStorage.getItem;
  secondWindow.sessionStorage.setItem = firstWindow.sessionStorage.setItem;
  const secondController = createRecoveryController({
    windowObject: secondWindow,
    now: () => 1_001,
  });

  assert.equal(secondController.recover(error), false);
  assert.equal(secondWindow.replacements.length, 0);
});

test("rejects a disabled recovery window", () => {
  assert.throws(
    () => createRecoveryController({ windowObject: makeWindow(), ttlMs: 0 }),
    /ttlMs/,
  );
  assert.throws(
    () => createRecoveryController({
      windowObject: makeWindow(),
      ttLms: 10,
    }),
    /unknown recovery option/,
  );
  assert.equal(isDynamicImportFailure(undefined), false);
  assert.throws(
    () => isDynamicImportFailure(new Error("chunk"), [/chunk/]),
    /non-empty strings/,
  );
  assert.throws(
    () => isDynamicImportFailure(new Error("chunk"), [""]),
    /non-empty strings/,
  );
});

test("ignores malformed persisted recovery state", () => {
  const windowObject = makeWindow();
  windowObject.sessionStorage.getItem = () => JSON.stringify({
    url: "https://example.test/dashboard?tab=one#chart",
    attemptedAt: "not-a-number",
    count: 99,
  });
  const controller = createRecoveryController({
    windowObject,
    now: () => 1_000,
  });

  assert.equal(
    controller.recover(
      new TypeError("Failed to fetch dynamically imported module"),
    ),
    true,
  );
});

test("installs the official Vite preload error listener", () => {
  const windowObject = makeWindow();
  const uninstall = installViteRecovery({
    windowObject,
    now: () => 2_000,
  });
  let prevented = false;
  windowObject.listeners.get("vite:preloadError")({
    payload: new Error("Loading chunk 17 failed"),
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(windowObject.replacements.length, 1);
  uninstall();
  assert.equal(windowObject.listeners.size, 0);
});

test("recognizes supported error shapes without matching unrelated failures", () => {
  assert.equal(
    isDynamicImportFailure("Error loading dynamically imported module"),
    true,
  );
  assert.equal(
    isDynamicImportFailure({ message: "ChunkLoadError: chunk 9" }),
    true,
  );
  assert.equal(isDynamicImportFailure({ code: "ECONNRESET" }), false);
  assert.equal(isDynamicImportFailure("request timed out"), false);
  const circular = {};
  circular.self = circular;
  assert.equal(isDynamicImportFailure(circular, ["object Object"]), true);
});

test("validates recovery options before installing listeners", () => {
  assert.throws(() => createRecoveryController(null), /must be an object/);
  assert.throws(() => createRecoveryController([]), /must be an object/);
  assert.throws(
    () => createRecoveryController({ windowObject: null }),
    /window-like object/,
  );
  assert.throws(
    () => createRecoveryController({
      windowObject: makeWindow(),
      storageKey: "",
    }),
    /storageKey/,
  );
  assert.throws(
    () => createRecoveryController({
      windowObject: makeWindow(),
      queryKey: "",
    }),
    /queryKey/,
  );
  assert.throws(
    () => createRecoveryController({
      windowObject: makeWindow(),
      now: 1,
    }),
    /now must be a function/,
  );
  assert.throws(
    () => createRecoveryController({
      windowObject: makeWindow(),
      onEvent: true,
    }),
    /onEvent must be a function/,
  );
  assert.throws(
    () => installViteRecovery([]),
    /must be an object/,
  );
});

test("allows another recovery after the time window expires", () => {
  const windowObject = makeWindow();
  let timestamp = 1_000;
  const controller = createRecoveryController({
    windowObject,
    ttlMs: 100,
    now: () => timestamp,
  });
  const error = new Error("Loading chunk 1 failed");

  assert.equal(controller.recover(error), true);
  timestamp = 1_099;
  assert.equal(controller.recover(error), false);
  timestamp = 1_100;
  assert.equal(controller.recover(error), true);
  assert.equal(windowObject.replacements.length, 2);
});

test("prefers the current URL marker over stored state for another page", () => {
  const windowObject = makeWindow();
  windowObject.location.href =
    "https://example.test/dashboard?__chunk_recovery=1000";
  windowObject.sessionStorage.getItem = () => JSON.stringify({
    url: "https://example.test/another-page",
    attemptedAt: 1_001,
    count: 1,
  });
  const controller = createRecoveryController({
    windowObject,
    now: () => 1_002,
  });

  assert.equal(
    controller.recover(new Error("Loading chunk 1 failed")),
    false,
  );
  assert.equal(windowObject.replacements.length, 0);
});

test("clears only a valid recovery query from browser history", () => {
  const windowObject = makeWindow();
  windowObject.location.href =
    "https://example.test/dashboard?tab=one&__chunk_recovery=1000#chart";
  const controller = createRecoveryController({
    windowObject,
    now: () => 1_001,
  });

  controller.clearRecoveryQuery();
  assert.deepEqual(windowObject.historyReplacements, [
    [null, "", "/dashboard?tab=one#chart"],
  ]);
});

test("handles fallback rejection and error listeners", () => {
  const windowObject = makeWindow();
  const uninstall = installViteRecovery({
    windowObject,
    now: () => 3_000,
  });
  let rejectionPrevented = false;
  windowObject.listeners.get("unhandledrejection")({
    reason: new Error("request timed out"),
    preventDefault: () => {
      rejectionPrevented = true;
    },
  });
  assert.equal(rejectionPrevented, false);

  let errorPrevented = false;
  windowObject.listeners.get("error")({
    error: new Error("Loading chunk 2 failed"),
    preventDefault: () => {
      errorPrevented = true;
    },
  });
  assert.equal(errorPrevented, true);
  uninstall();
});

test("wraps dynamic imports while preserving arguments and receiver", async () => {
  const recovered = [];
  const controller = {
    recover: (error) => {
      recovered.push(error);
      return false;
    },
  };
  const receiver = {
    base: 4,
    load: wrapDynamicImport(async function load(value) {
      return this.base + value;
    }, controller),
  };
  assert.equal(await receiver.load(3), 7);

  const failure = new Error("request failed");
  const rejected = wrapDynamicImport(async () => {
    throw failure;
  }, controller);
  await assert.rejects(rejected(), failure);
  assert.deepEqual(recovered, [failure]);
  assert.throws(() => wrapDynamicImport(null, controller), /loader/);
  assert.throws(
    () => wrapDynamicImport(async () => {}, null),
    /controller/,
  );
});

test("leaves a recovered dynamic import pending while the page reloads", async () => {
  let recoveryCount = 0;
  const wrapped = wrapDynamicImport(
    async () => {
      throw new Error("Loading chunk 5 failed");
    },
    {
      recover: () => {
        recoveryCount += 1;
        return true;
      },
    },
  );

  let settled = false;
  void wrapped().then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recoveryCount, 1);
  assert.equal(settled, false);
});

test("rejects an invalid recovery clock", () => {
  for (const timestamp of [Number.NaN, -1, 1.5]) {
    const controller = createRecoveryController({
      windowObject: makeWindow(),
      now: () => timestamp,
    });
    assert.throws(
      () => controller.recover(new Error("Loading chunk 1 failed")),
      /non-negative safe integer/,
    );
  }
});
