export interface RecoveryLocationLike {
  href: string;
  replace(url: string): void;
}

export interface RecoveryHistoryLike {
  state: unknown;
  replaceState(state: unknown, unused: string, url?: string): void;
}

export interface RecoveryStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface RecoveryWindowLike {
  location: RecoveryLocationLike;
  history: RecoveryHistoryLike;
  sessionStorage: RecoveryStorageLike;
  addEventListener(
    type: string,
    listener: (event: any) => void,
    options?: unknown,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: any) => void,
    options?: unknown,
  ): void;
}

export interface RecoveryReloadEvent {
  type: "reload";
  url: string;
  reloadUrl: string;
  attemptedAt: number;
  attemptCount: number;
  error: unknown;
}

export interface RecoverySuppressedEvent {
  type: "suppressed";
  url: string;
  attemptedAt: number;
  previousAttemptedAt: number;
  attemptCount: number;
  remainingMs: number;
  error: unknown;
}

export interface RecoveryQueryClearedEvent {
  type: "query-cleared";
  url: string;
}

export type RecoveryEvent =
  | RecoveryReloadEvent
  | RecoverySuppressedEvent
  | RecoveryQueryClearedEvent;

export interface RecoveryOptions {
  windowObject?: RecoveryWindowLike;
  storageKey?: string;
  queryKey?: string;
  ttlMs?: number;
  now?: () => number;
  patterns?: readonly string[];
  onEvent?: (event: RecoveryEvent) => void;
}

export interface RecoveryController {
  recover(error: unknown): boolean;
  clearRecoveryQuery(): void;
}

export function isDynamicImportFailure(
  error: unknown,
  patterns?: readonly string[],
): boolean;

export function createRecoveryController(
  options?: RecoveryOptions,
): RecoveryController;

export function installViteRecovery(options?: RecoveryOptions): () => void;

export function wrapDynamicImport<
  Result,
  Arguments extends unknown[] = [],
>(
  loader: (...argumentsList: Arguments) => Result | PromiseLike<Result>,
  controller: Pick<RecoveryController, "recover">,
): (...argumentsList: Arguments) => Promise<Result>;
