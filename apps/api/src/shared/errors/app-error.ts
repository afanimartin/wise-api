export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class InsufficientFundsError extends AppError {
  constructor() {
    super('INSUFFICIENT_FUNDS', 'Insufficient wallet balance', 409);
  }
}

export class IdempotencyConflictError extends AppError {
  constructor() {
    super('IDEMPOTENCY_CONFLICT', 'Idempotency key was reused with a different request', 409);
  }
}

export class DuplicateRequestInProgressError extends AppError {
  constructor() {
    super('DUPLICATE_REQUEST_IN_PROGRESS', 'A request with this idempotency key is still processing', 409);
  }
}

export class InvalidTransferError extends AppError {
  constructor(message = 'Invalid wallet transfer') {
    super('INVALID_TRANSFER', message, 400);
  }
}

export class WalletAccountNotFoundError extends AppError {
  constructor() {
    super('WALLET_ACCOUNT_NOT_FOUND', 'Wallet account was not found', 404);
  }
}

export class WalletAccountUnavailableError extends AppError {
  constructor() {
    super('WALLET_ACCOUNT_UNAVAILABLE', 'Wallet account is not available for transfers', 409);
  }
}

export class CurrencyMismatchError extends AppError {
  constructor() {
    super('CURRENCY_MISMATCH', 'Wallet accounts do not support the requested currency', 400);
  }
}

export class AuthenticationRequiredError extends AppError {
  constructor() {
    super('AUTHENTICATION_REQUIRED', 'Authentication is required', 401);
  }
}

export class InvalidAuthTokenError extends AppError {
  constructor() {
    super('INVALID_AUTH_TOKEN', 'Authentication token is invalid', 401);
  }
}

export class UserAccountUnavailableError extends AppError {
  constructor() {
    super('USER_ACCOUNT_UNAVAILABLE', 'User account is not available', 403);
  }
}

export class PermissionDeniedError extends AppError {
  constructor() {
    super('PERMISSION_DENIED', 'User does not have permission to perform this action', 403);
  }
}

export class WalletAccountAccessDeniedError extends AppError {
  constructor() {
    super('WALLET_ACCOUNT_ACCESS_DENIED', 'Wallet account does not belong to the authenticated user', 403);
  }
}
