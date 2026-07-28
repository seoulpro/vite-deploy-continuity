export interface ViteManifestEntry {
  file?: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
  [key: string]: unknown;
}

export type ViteManifest = Record<string, ViteManifestEntry>;

export type RetentionAssetPreset = "code" | "vite";
export type RetentionAssetPolicy = RetentionAssetPreset | "custom";

export interface RetainedGeneration {
  historyFile: string;
  createdAt: string | null;
  ageMs: number | null;
  assetCount: number;
  current: boolean;
}

export interface RetentionLockEvent {
  type: "lock-acquired" | "lock-released";
  lockPath: string;
}

export interface RetentionPlannedEvent {
  type: "planned";
  assetPolicy: RetentionAssetPolicy;
  currentAssetCount: number;
  retainedGenerations: readonly RetainedGeneration[];
  removableAssetCount: number;
  removableBytes: number;
  oldestRemovableAgeMs: number | null;
  dryRun: boolean;
}

export interface RetentionAssetRemovedEvent {
  type: "asset-removed";
  asset: string;
  sizeBytes: number;
  ageMs: number;
}

export interface RetentionCompletedEvent {
  type: "completed";
  assetPolicy: RetentionAssetPolicy;
  removedAssetCount: number;
  removedBytes: number;
  dryRun: boolean;
}

export type RetentionEvent =
  | RetentionLockEvent
  | RetentionPlannedEvent
  | RetentionAssetRemovedEvent
  | RetentionCompletedEvent;

export interface RetainBuildAssetsOptions {
  distDirectory: string;
  manifestPath?: string;
  historyDirectory?: string;
  assetsDirectory?: string;
  assetsBase?: string;
  historyLimit?: number;
  gracePeriodMs?: number;
  nowMs?: number;
  assetPreset?: RetentionAssetPreset;
  assetPattern?: RegExp;
  dryRun?: boolean;
  lock?: boolean;
  lockPath?: string;
  lockStaleMs?: number;
  onEvent?: (event: RetentionEvent) => void;
}

export interface RetainBuildAssetsResult {
  currentAssets: string[];
  retainedHistoryCount: number;
  retainedGenerations: RetainedGeneration[];
  removable: string[];
  removableBytes: number;
  oldestRemovableAgeMs: number | null;
  assetPolicy: RetentionAssetPolicy;
  dryRun: boolean;
}

export class RetentionLockError extends Error {
  readonly code: "ERR_RETENTION_LOCKED";
  readonly lockPath: string;
  constructor(lockPath: string);
}

export function collectManifestAssets(manifest: unknown): Set<string>;

export function retainBuildAssets(
  options: RetainBuildAssetsOptions,
): Promise<RetainBuildAssetsResult>;
