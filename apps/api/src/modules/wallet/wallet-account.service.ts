import type { Database } from '../../shared/db/database.js';

export type WalletAccountResponse = {
  id: string;
  ownerUserId: string;
  accountType: 'CUSTOMER' | 'MERCHANT' | 'SYSTEM';
  currency: string;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  balanceMinor: string;
  createdAt: string;
};

type WalletAccountRow = {
  id: string;
  owner_user_id: string;
  account_type: 'CUSTOMER' | 'MERCHANT' | 'SYSTEM';
  currency: string;
  status: 'ACTIVE' | 'FROZEN' | 'CLOSED';
  balance_minor: string | number;
  created_at: Date;
};

export class WalletAccountService {
  constructor(private readonly db: Database) {}

  async listUserAccounts(authenticatedUserId: string): Promise<WalletAccountResponse[]> {
    const result = await this.db.query<WalletAccountRow>(
      `select
         account.id,
         account.owner_user_id,
         account.account_type,
         account.currency,
         account.status,
         account.created_at,
         coalesce(sum(
           case
             when ledger.entry_type = 'CREDIT' then ledger.amount_minor
             when ledger.entry_type = 'DEBIT' then -ledger.amount_minor
           end
         ), 0) as balance_minor
       from wallet_accounts account
       left join wallet_transaction_ledger ledger
         on ledger.account_id = account.id
       where account.owner_user_id = $1
       group by account.id
       order by account.created_at asc`,
      [authenticatedUserId],
    );

    return result.rows.map(mapWalletAccountRow);
  }

  async getOrCreateCustomerAccount(
    authenticatedUserId: string,
    currency: string,
  ): Promise<WalletAccountResponse> {
    return this.db.transaction(async (tx) => {
      const result = await tx.query<WalletAccountRow>(
        `with created as (
           insert into wallet_accounts (owner_user_id, account_type, currency, status)
           values ($1, 'CUSTOMER', $2, 'ACTIVE')
           on conflict (owner_user_id, account_type, currency) do update
           set status = wallet_accounts.status
           returning id, owner_user_id, account_type, currency, status, created_at
         )
         select
           created.id,
           created.owner_user_id,
           created.account_type,
           created.currency,
           created.status,
           created.created_at,
           coalesce(sum(
             case
               when ledger.entry_type = 'CREDIT' then ledger.amount_minor
               when ledger.entry_type = 'DEBIT' then -ledger.amount_minor
             end
           ), 0) as balance_minor
         from created
         left join wallet_transaction_ledger ledger
           on ledger.account_id = created.id
         group by
           created.id,
           created.owner_user_id,
           created.account_type,
           created.currency,
           created.status,
           created.created_at`,
        [authenticatedUserId, currency],
      );

      return mapWalletAccountRow(result.rows[0]!);
    });
  }
}

function mapWalletAccountRow(row: WalletAccountRow): WalletAccountResponse {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    accountType: row.account_type,
    currency: row.currency,
    status: row.status,
    balanceMinor: String(row.balance_minor),
    createdAt: row.created_at.toISOString(),
  };
}
