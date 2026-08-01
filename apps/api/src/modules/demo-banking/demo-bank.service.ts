import { DemoBankNotFoundError } from '../../shared/errors/app-error.js';
import type { Database } from '../../shared/db/database.js';

export type DemoBank = {
  code: string;
  name: string;
  country: 'SS';
  currencies: string[];
};

export type DemoBankAccountResponse = {
  id: string;
  bankCode: string;
  bankName: string;
  accountName: string;
  accountNumberLast4: string;
  currency: string;
  balanceMinor: string;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
};

export type LinkDemoBankAccountInput = {
  authenticatedUserId: string;
  bankCode: string;
  accountName: string;
  accountNumber: string;
  currency: string;
  openingBalanceMinor: string;
};

type DemoBankAccountRow = {
  id: string;
  bank_code: string;
  bank_name: string;
  account_name: string;
  account_number_last4: string;
  currency: string;
  balance_minor: string | number;
  status: 'ACTIVE' | 'DISABLED';
  created_at: Date;
};

const DEMO_BANKS: DemoBank[] = [
  {
    code: 'KCB_SS',
    name: 'KCB South Sudan',
    country: 'SS',
    currencies: ['SSP', 'USD'],
  },
  {
    code: 'ECOBANK_SS',
    name: 'Ecobank South Sudan',
    country: 'SS',
    currencies: ['SSP', 'USD'],
  },
  {
    code: 'EDEN_BANK',
    name: 'Eden Commercial Bank',
    country: 'SS',
    currencies: ['SSP'],
  },
];

export class DemoBankService {
  constructor(private readonly db: Database) {}

  listBanks(): DemoBank[] {
    return DEMO_BANKS;
  }

  async listUserAccounts(authenticatedUserId: string): Promise<DemoBankAccountResponse[]> {
    const result = await this.db.query<DemoBankAccountRow>(
      `select id, bank_code, bank_name, account_name, account_number_last4, currency,
              balance_minor, status, created_at
       from demo_bank_accounts
       where owner_user_id = $1
       order by created_at asc`,
      [authenticatedUserId],
    );

    return result.rows.map(mapDemoBankAccountRow);
  }

  async linkAccount(input: LinkDemoBankAccountInput): Promise<DemoBankAccountResponse> {
    const bank = DEMO_BANKS.find((candidate) => candidate.code === input.bankCode);
    if (!bank || !bank.currencies.includes(input.currency)) {
      throw new DemoBankNotFoundError();
    }

    const result = await this.db.query<DemoBankAccountRow>(
      `insert into demo_bank_accounts
        (owner_user_id, bank_code, bank_name, account_name, account_number_last4, currency, balance_minor, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')
       returning id, bank_code, bank_name, account_name, account_number_last4, currency,
                 balance_minor, status, created_at`,
      [
        input.authenticatedUserId,
        bank.code,
        bank.name,
        input.accountName,
        input.accountNumber.slice(-4),
        input.currency,
        input.openingBalanceMinor,
      ],
    );

    return mapDemoBankAccountRow(result.rows[0]!);
  }
}

function mapDemoBankAccountRow(row: DemoBankAccountRow): DemoBankAccountResponse {
  return {
    id: row.id,
    bankCode: row.bank_code,
    bankName: row.bank_name,
    accountName: row.account_name,
    accountNumberLast4: row.account_number_last4,
    currency: row.currency,
    balanceMinor: String(row.balance_minor),
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}
