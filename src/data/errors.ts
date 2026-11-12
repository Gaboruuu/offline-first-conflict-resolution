/** The server could not be reached (no connection, server down, or the request timed out). */
export class NetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
  }
}

/** The server answered with an error status; `code` and `fields` come from its JSON error body. */
export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ServerError';
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }
}

export const isNotFound = (error: unknown): boolean => error instanceof ServerError && error.isNotFound;
