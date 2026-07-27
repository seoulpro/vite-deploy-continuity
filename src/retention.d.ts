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

export interface RetainBuildAssetsOptions {
  distDirectory: string;
  manifestPath?: string;
  historyDirectory?: string;
  assetsDirectory?: string;
  assetsBase?: string;
  historyLimit?: number;
  gracePeriodMs?: number;
  nowMs?: number;
  assetPattern?: RegExp;
  dryRun?: boolean;
}

export interface RetainBuildAssetsResult {
  currentAssets: string[];
  retainedHistoryCount: number;
  removable: string[];
  dryRun: boolean;
}

export function collectManifestAssets(manifest: unknown): Set<string>;

export function retainBuildAssets(
  options: RetainBuildAssetsOptions,
): Promise<RetainBuildAssetsResult>;
