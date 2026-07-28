export interface PrecompressedVariant {
  path: string;
  extension: ".br" | ".gz";
  encoding: "br" | "gzip";
}

export interface FindFreshPrecompressedVariantOptions {
  originalPath: string;
  acceptEncoding?: string | string[];
  mtimeToleranceMs?: number;
  rootDirectory?: string;
}

export interface CacheControlOptions {
  versionParameter?: string;
  versioned?: string;
  unversioned?: string;
  versionPattern?: RegExp;
  isVersioned?: (url: URL) => boolean;
}

export interface StaticRequestLike {
  method: string;
  url: string;
  headers?: Record<string, string | string[] | undefined>;
}

export interface StaticResponseLike {
  statusCode?: number;
  getHeader?(name: string): string | number | string[] | undefined;
  setHeader(name: string, value: string): void;
  end(): unknown;
}

export type StaticNextFunction = (error?: unknown) => unknown;

export interface PrecompressedMiddlewareOptions {
  rootDirectory: string;
  extensions?: string[];
  cacheControl?: CacheControlOptions;
  contentType?: ((pathname: string) => string | null | undefined) | null;
}

export type PrecompressedMiddleware = (
  request: StaticRequestLike,
  response: StaticResponseLike,
  next: StaticNextFunction,
) => Promise<unknown>;

export function resolvePathInside(
  rootDirectory: string,
  requestPath: string,
): string | null;

export function findFreshPrecompressedVariant(
  options: FindFreshPrecompressedVariantOptions,
): Promise<PrecompressedVariant | null>;

export function cacheControlForRequest(
  requestUrl: string,
  options?: CacheControlOptions,
): string;

export function createPrecompressedMiddleware(
  options: PrecompressedMiddlewareOptions,
): PrecompressedMiddleware;
