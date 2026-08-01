import { randomUUID } from 'node:crypto';
import {
  CurrencyMismatchError,
  DemoBankAccountNotFoundError,
  DemoBankAccountUnavailableError,
  DemoBankInsufficientFundsError,
  DuplicateRequestInProgressError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidTransferError,
  WalletAccountAccessDeniedError,
  WalletAccountNotFoundError,
  WalletAccountUnavailableError,
} from '../../shared/errors/app-error.js';
import type { Database, DbExecutor } from '../../shared/db/database.js';

export type TransferFundsInput = {
  authenticatedUserId: string;
  idempotencyKey: string;
  requestHash: string;
  fromAccountId: string;
  toAccountId: string;
  amountMinor: string;
  currency: string;
  referenceType: string;
  referenceId: string;
};

export type TransferFundsResponse = {
  transactionId: string;
  fromAccountId: string;
  toAccountId: string;
  amountMinor: string;
  currency: string;
  referenceType: string;
  referenceId: string;
  balanceMinor: string;
  idempotentReplay: boolean;
};

export type FundWalletInput = {
  adminUserId: string;
  idempotencyKey: string;
  requestHash: string;
  accountId: string;
  amountMinor: string;
  currency: string;
  referenceId: string;
  note?: string | undefined;
};

export type FundWalletResponse = {
  transactionId: string;
  accountId: string;
  amountMinor: string;
  currency: string;
  referenceType: 'ADMIN_FUND';
  referenceId: string;
  balanceMinor: string;
  idempotentReplay: boolean;
};

export type DepositFromDemoBankInput = {
  authenticatedUserId: string;
  idempotencyKey: string;
  requestHash: string;
  demoBankAccountId: string;
  walletAccountId: string;
  amountMinor: string;
  currency: string;
  referenceId: string;
};

export type DepositFromDemoBankResponse = {
  transactionId: string;
  demoBankAccountId: string;
  walletAccountId: string;
  amountMinor: string;
  currency: string;
  referenceType: 'BANK_DEPOSIT';
  referenceId: string;
  bankBalanceMinor: string;
  walletBalanceMinor: string;
  idempotentReplay: boolean;
};

type AccountRow = {
  id: string;
  owner_user_id: string;
  currency: string;
  status: string;
};

type BalanceRow = {
  balance_minor: string | number;
};

type DemoBankAccountRow = {
  id: string;
  owner_user_id: string;
  currency: string;
  balance_minor: string | number;
  status: string;
};

type IdempotencyRow = {
  request_hash: string;
  response_status: number | null;
  response_payload: unknown;
  locked_until: Date | null;
  completed_at: Date | null;
};

export class LedgerService {
  constructor(private readonly db: Database) {}

  async depositFromDemoBank(
    input: DepositFromDemoBankInput,
  ): Promise<DepositFromDemoBankResponse> {
    return this.db.transaction(async (tx) => {
      const replay = await this.prepareIdempotency<DepositFromDemoBankResponse>(
        tx,
        input.idempotencyKey,
        input.requestHash,
      );
      if (replay) {
        return {
          ...replay,
          idempotentReplay: true,
        };
      }

      const demoBankAccount = await this.lockDemoBankAccount(tx, input.demoBankAccountId);
      if (!demoBankAccount || demoBankAccount.owner_user_id !== input.authenticatedUserId) {
        throw new DemoBankAccountNotFoundError();
      }

      if (demoBankAccount.status !== 'ACTIVE') {
        throw new DemoBankAccountUnavailableError();
      }

      const walletAccounts = await this.lockAccounts(tx, [input.walletAccountId]);
      const walletAccount = walletAccounts.get(input.walletAccountId);
      if (!walletAccount) {
        throw new WalletAccountNotFoundError();
      }

      if (walletAccount.owner_user_id !== input.authenticatedUserId) {
        throw new WalletAccountAccessDeniedError();
      }

      if (walletAccount.status !== 'ACTIVE') {
        throw new WalletAccountUnavailableError();
      }

      if (demoBankAccount.currency !== input.currency || walletAccount.currency !== input.currency) {
        throw new CurrencyMismatchError();
      }

      const amountMinor = BigInt(input.amountMinor);
      const bankBalanceMinor = BigInt(String(demoBankAccount.balance_minor));
      if (bankBalanceMinor < amountMinor) {
        throw new DemoBankInsufficientFundsError();
      }

      const walletBalanceMinor = await this.getBalanceMinor(tx, input.walletAccountId);
      const transactionId = randomUUID();
      const metadata = {
        demoBankAccountId: input.demoBankAccountId,
        idempotencyKey: input.idempotencyKey,
      };

      await tx.query(
        `update demo_bank_accounts
         set balance_minor = balance_minor - $2,
             updated_at = now()
         where id = $1`,
        [input.demoBankAccountId, input.amountMinor],
      );

      await tx.query(
        `insert into wallet_transaction_ledger
          (transaction_id, account_id, owner_user_id, entry_type, amount_minor, currency, reference_type, reference_id, metadata)
         values ($1, $2, $3, 'CREDIT', $4, $5, 'BANK_DEPOSIT', $6, $7::jsonb)`,
        [
          transactionId,
          walletAccount.id,
          walletAccount.owner_user_id,
          input.amountMinor,
          input.currency,
          input.referenceId,
          JSON.stringify(metadata),
        ],
      );

      const response: DepositFromDemoBankResponse = {
        transactionId,
        demoBankAccountId: input.demoBankAccountId,
        walletAccountId: input.walletAccountId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        referenceType: 'BANK_DEPOSIT',
        referenceId: input.referenceId,
        bankBalanceMinor: (bankBalanceMinor - amountMinor).toString(),
        walletBalanceMinor: (walletBalanceMinor + amountMinor).toString(),
        idempotentReplay: false,
      };

      await this.completeIdempotency(tx, input.idempotencyKey, 201, response);

      return response;
    });
  }

  async fundWallet(input: FundWalletInput): Promise<FundWalletResponse> {
    return this.db.transaction(async (tx) => {
      const replay = await this.prepareIdempotency<FundWalletResponse>(
        tx,
        input.idempotencyKey,
        input.requestHash,
      );
      if (replay) {
        return {
          ...replay,
          idempotentReplay: true,
        };
      }

      const accounts = await this.lockAccounts(tx, [input.accountId]);
      const account = accounts.get(input.accountId);
      if (!account) {
        throw new WalletAccountNotFoundError();
      }

      if (account.status !== 'ACTIVE') {
        throw new WalletAccountUnavailableError();
      }

      if (account.currency !== input.currency) {
        throw new CurrencyMismatchError();
      }

      const balanceMinor = await this.getBalanceMinor(tx, input.accountId);
      const amountMinor = BigInt(input.amountMinor);
      const transactionId = randomUUID();
      const metadata = {
        adminUserId: input.adminUserId,
        idempotencyKey: input.idempotencyKey,
        note: input.note ?? null,
      };

      await tx.query(
        `insert into wallet_transaction_ledger
          (transaction_id, account_id, owner_user_id, entry_type, amount_minor, currency, reference_type, reference_id, metadata)
         values ($1, $2, $3, 'CREDIT', $4, $5, 'ADMIN_FUND', $6, $7::jsonb)`,
        [
          transactionId,
          account.id,
          account.owner_user_id,
          input.amountMinor,
          input.currency,
          input.referenceId,
          JSON.stringify(metadata),
        ],
      );

      const response: FundWalletResponse = {
        transactionId,
        accountId: input.accountId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        referenceType: 'ADMIN_FUND',
        referenceId: input.referenceId,
        balanceMinor: (balanceMinor + amountMinor).toString(),
        idempotentReplay: false,
      };

      await this.completeIdempotency(tx, input.idempotencyKey, 201, response);

      return response;
    });
  }

  async transferFunds(input: TransferFundsInput): Promise<TransferFundsResponse> {
    if (input.fromAccountId === input.toAccountId) {
      throw new InvalidTransferError('Source and destination accounts must be different');
    }

    return this.db.transaction(async (tx) => {
      const replay = await this.prepareIdempotency<TransferFundsResponse>(
        tx,
        input.idempotencyKey,
        input.requestHash,
      );
      if (replay) {
        return {
          ...replay,
          idempotentReplay: true,
        };
      }

      const accounts = await this.lockAccounts(tx, [input.fromAccountId, input.toAccountId]);
      const fromAccount = accounts.get(input.fromAccountId);
      const toAccount = accounts.get(input.toAccountId);

      if (!fromAccount || !toAccount) {
        throw new WalletAccountNotFoundError();
      }

      if (fromAccount.owner_user_id !== input.authenticatedUserId) {
        throw new WalletAccountAccessDeniedError();
      }

      if (fromAccount.status !== 'ACTIVE' || toAccount.status !== 'ACTIVE') {
        throw new WalletAccountUnavailableError();
      }

      if (fromAccount.currency !== input.currency || toAccount.currency !== input.currency) {
        throw new CurrencyMismatchError();
      }

      const balanceMinor = await this.getBalanceMinor(tx, input.fromAccountId);
      const amountMinor = BigInt(input.amountMinor);
      if (balanceMinor < amountMinor) {
        throw new InsufficientFundsError();
      }

      const transactionId = randomUUID();
      const metadata = {
        idempotencyKey: input.idempotencyKey,
      };

      await tx.query(
        `insert into wallet_transaction_ledger
          (transaction_id, account_id, owner_user_id, entry_type, amount_minor, currency, reference_type, reference_id, metadata)
         values
          ($1, $2, $3, 'DEBIT', $4, $5, $6, $7, $8::jsonb),
          ($1, $9, $10, 'CREDIT', $4, $5, $6, $7, $8::jsonb)`,
        [
          transactionId,
          fromAccount.id,
          fromAccount.owner_user_id,
          input.amountMinor,
          input.currency,
          input.referenceType,
          input.referenceId,
          JSON.stringify(metadata),
          toAccount.id,
          toAccount.owner_user_id,
        ],
      );

      const response: TransferFundsResponse = {
        transactionId,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amountMinor: input.amountMinor,
        currency: input.currency,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        balanceMinor: (balanceMinor - amountMinor).toString(),
        idempotentReplay: false,
      };

      await this.completeIdempotency(tx, input.idempotencyKey, 201, response);

      return response;
    });
  }

  private async prepareIdempotency<TResponse>(
    tx: DbExecutor,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<TResponse | null> {
    const inserted = await tx.query(
      `insert into api_idempotency_registry (idempotency_key, request_hash, locked_until)
       values ($1, $2, now() + interval '5 minutes')
       on conflict (idempotency_key) do nothing
       returning request_hash, response_status, response_payload, locked_until, completed_at`,
      [idempotencyKey, requestHash],
    );

    if (inserted.rowCount === 1) {
      return null;
    }

    const existing = await tx.query<IdempotencyRow>(
      `select request_hash, response_status, response_payload, locked_until, completed_at
       from api_idempotency_registry
       where idempotency_key = $1
       for update`,
      [idempotencyKey],
    );

    const row = existing.rows[0];
    if (!row) {
      throw new DuplicateRequestInProgressError();
    }

    if (row.request_hash !== requestHash) {
      throw new IdempotencyConflictError();
    }

    if (row.completed_at && row.response_payload) {
      return row.response_payload as TResponse;
    }

    if (row.locked_until && row.locked_until.getTime() > Date.now()) {
      throw new DuplicateRequestInProgressError();
    }

    await tx.query(
      `update api_idempotency_registry
       set locked_until = now() + interval '5 minutes'
       where idempotency_key = $1`,
      [idempotencyKey],
    );

    return null;
  }

  private async completeIdempotency(
    tx: DbExecutor,
    idempotencyKey: string,
    responseStatus: number,
    responsePayload: unknown,
  ): Promise<void> {
    await tx.query(
      `update api_idempotency_registry
       set response_status = $2,
           response_payload = $3::jsonb,
           completed_at = now(),
           locked_until = null
       where idempotency_key = $1`,
      [idempotencyKey, responseStatus, JSON.stringify(responsePayload)],
    );
  }

  private async lockAccounts(tx: DbExecutor, accountIds: string[]): Promise<Map<string, AccountRow>> {
    const sortedAccountIds = [...new Set(accountIds)].sort();
    const result = await tx.query<AccountRow>(
      `select id, owner_user_id, currency, status
       from wallet_accounts
       where id = any($1::uuid[])
       order by id
       for update`,
      [sortedAccountIds],
    );

    return new Map(result.rows.map((row) => [row.id, row]));
  }

  private async lockDemoBankAccount(
    tx: DbExecutor,
    demoBankAccountId: string,
  ): Promise<DemoBankAccountRow | null> {
    const result = await tx.query<DemoBankAccountRow>(
      `select id, owner_user_id, currency, balance_minor, status
       from demo_bank_accounts
       where id = $1
       for update`,
      [demoBankAccountId],
    );

    return result.rows[0] ?? null;
  }

  private async getBalanceMinor(tx: DbExecutor, accountId: string): Promise<bigint> {
    const result = await tx.query<BalanceRow>(
      `select coalesce(sum(
        case
          when entry_type = 'CREDIT' then amount_minor
          when entry_type = 'DEBIT' then -amount_minor
        end
      ), 0) as balance_minor
      from wallet_transaction_ledger
      where account_id = $1`,
      [accountId],
    );

    return BigInt(result.rows[0]?.balance_minor ?? 0);
  }
}
