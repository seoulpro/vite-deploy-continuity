const DEFAULT_PATTERNS = Object.freeze([
  "failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "importing a module script failed",
  "failed to load module script",
  "loading chunk",
  "chunkloaderror",
]);

const assertPatterns = (patterns) => {
  if (
    !Array.isArray(patterns)
    || patterns.some(
      (pattern) => typeof pattern !== "string" || pattern.length === 0,
    )
  ) {
    throw new TypeError("patterns must be an array of non-empty strings");
  }
};

const stringifyError = (error) => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
};

export const isDynamicImportFailure = (error, patterns = DEFAULT_PATTERNS) => {
  assertPatterns(patterns);
  const text = stringifyError(error).toLowerCase();
  return patterns.some((pattern) => text.includes(pattern.toLowerCase()));
};

export const createRecoveryController = (options = {}) => {
  if (
    typeof options !== "object"
    || options === null
    || Array.isArray(options)
  ) {
    throw new TypeError("recovery options must be an object");
  }
  const allowedOptions = new Set([
    "windowObject",
    "storageKey",
    "queryKey",
    "ttlMs",
    "now",
    "patterns",
    "onEvent",
  ]);
  for (const name of Object.keys(options)) {
    if (!allowedOptions.has(name)) {
      throw new TypeError(`unknown recovery option: ${name}`);
    }
  }
  const {
    windowObject = globalThis.window,
    storageKey = "viteDeployContinuity.recovery",
    queryKey = "__chunk_recovery",
    ttlMs = 60_000,
    now = () => Date.now(),
    patterns = DEFAULT_PATTERNS,
    onEvent,
  } = options;
  if (!windowObject) throw new TypeError("a window-like object is required");
  if (typeof storageKey !== "string" || storageKey.length === 0) {
    throw new TypeError("storageKey must be a non-empty string");
  }
  if (typeof queryKey !== "string" || queryKey.length === 0) {
    throw new TypeError("queryKey must be a non-empty string");
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RangeError("ttlMs must be a positive finite number");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }
  if (onEvent !== undefined && typeof onEvent !== "function") {
    throw new TypeError("onEvent must be a function");
  }
  assertPatterns(patterns);

  const emit = (event) => {
    try {
      onEvent?.(Object.freeze(event));
    } catch {
      // Telemetry must never change recovery behavior.
    }
  };
  const normalizedUrl = () => {
    const url = new URL(windowObject.location.href);
    url.searchParams.delete(queryKey);
    return url.toString();
  };
  const initialUrl = new URL(windowObject.location.href);
  const initialAttemptValue = initialUrl.searchParams.get(queryKey);
  const initialAttempt = initialAttemptValue !== null
    && /^\d+$/u.test(initialAttemptValue)
    ? Number(initialAttemptValue)
    : Number.NaN;
  let memoryState = Number.isSafeInteger(initialAttempt) && initialAttempt >= 0
    ? {
        url: normalizedUrl(),
        attemptedAt: initialAttempt,
        count: 1,
      }
    : null;

  const readState = (expectedUrl) => {
    let persistedState = null;
    try {
      const parsed = JSON.parse(windowObject.sessionStorage.getItem(storageKey));
      if (
        parsed
        && typeof parsed === "object"
        && !Array.isArray(parsed)
        && typeof parsed.url === "string"
        && Number.isSafeInteger(parsed.attemptedAt)
        && parsed.attemptedAt >= 0
        && Number.isInteger(parsed.count)
        && parsed.count >= 1
      ) {
        persistedState = parsed;
      }
    } catch {
      // Fall through to the recovery marker carried in the URL.
    }
    const matchingStates = [memoryState, persistedState]
      .filter((state) => state?.url === expectedUrl)
      .sort((left, right) => right.attemptedAt - left.attemptedAt);
    return matchingStates[0] ?? persistedState ?? memoryState;
  };
  const writeState = (state) => {
    memoryState = state;
    try {
      windowObject.sessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // The URL marker preserves one-attempt loop protection without storage.
    }
  };
  const clearRecoveryQuery = () => {
    const url = new URL(windowObject.location.href);
    if (!url.searchParams.has(queryKey)) return;
    url.searchParams.delete(queryKey);
    windowObject.history.replaceState(
      windowObject.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
    emit({
      type: "query-cleared",
      url: url.toString(),
    });
  };

  const recover = (error) => {
    if (!isDynamicImportFailure(error, patterns)) return false;
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new RangeError("now() must return a non-negative safe integer");
    }
    const url = normalizedUrl();
    const previous = readState(url);
    const elapsedMs = previous ? timestamp - previous.attemptedAt : null;
    if (
      previous
      && previous.url === url
      && previous.count >= 1
      && Math.abs(elapsedMs) < ttlMs
    ) {
      emit({
        type: "suppressed",
        url,
        attemptedAt: timestamp,
        previousAttemptedAt: previous.attemptedAt,
        attemptCount: previous.count,
        remainingMs: Math.max(0, ttlMs - Math.abs(elapsedMs)),
        error,
      });
      return false;
    }
    const state = {
      url,
      attemptedAt: timestamp,
      count: previous?.url === url ? previous.count + 1 : 1,
    };
    writeState(state);
    const reloadUrl = new URL(url);
    reloadUrl.searchParams.set(queryKey, String(timestamp));
    emit({
      type: "reload",
      url,
      reloadUrl: reloadUrl.toString(),
      attemptedAt: timestamp,
      attemptCount: state.count,
      error,
    });
    windowObject.location.replace(reloadUrl.toString());
    return true;
  };

  return { recover, clearRecoveryQuery };
};

export const installViteRecovery = (options = {}) => {
  if (
    typeof options !== "object"
    || options === null
    || Array.isArray(options)
  ) {
    throw new TypeError("recovery options must be an object");
  }
  const windowObject = options.windowObject ?? globalThis.window;
  const controller = createRecoveryController({ ...options, windowObject });
  controller.clearRecoveryQuery();

  const preload = (event) => {
    if (controller.recover(event.payload)) event.preventDefault();
  };
  const rejection = (event) => {
    if (controller.recover(event.reason)) event.preventDefault();
  };
  const error = (event) => {
    if (controller.recover(event.error ?? event.message)) event.preventDefault();
  };
  windowObject.addEventListener("vite:preloadError", preload);
  windowObject.addEventListener("unhandledrejection", rejection);
  windowObject.addEventListener("error", error);

  return () => {
    windowObject.removeEventListener("vite:preloadError", preload);
    windowObject.removeEventListener("unhandledrejection", rejection);
    windowObject.removeEventListener("error", error);
  };
};

export const wrapDynamicImport = (loader, controller) => {
  if (typeof loader !== "function") {
    throw new TypeError("loader must be a function");
  }
  if (!controller || typeof controller.recover !== "function") {
    throw new TypeError("controller must provide a recover function");
  }
  return async function wrappedDynamicImport(...argumentsList) {
    try {
      return await loader.apply(this, argumentsList);
    } catch (error) {
      if (controller.recover(error)) {
        return await new Promise(() => {});
      }
      throw error;
    }
  };
};
