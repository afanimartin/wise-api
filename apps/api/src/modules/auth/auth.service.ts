import {
  AuthenticationRequiredError,
  InvalidAuthTokenError,
  UserAccountUnavailableError,
} from '../../shared/errors/app-error.js';
import type { Database } from '../../shared/db/database.js';
import type { FirebaseTokenVerifier } from './firebase-token-verifier.js';
import { DEFAULT_CUSTOMER_PERMISSIONS, DEFAULT_CUSTOMER_ROLE } from './permissions.js';

export type AuthContext = {
  userId: string;
  firebaseUid: string;
  roles: string[];
  permissions: string[];
};

type AppUserRow = {
  id: string;
  firebase_uid: string;
  roles: string[];
  permissions: string[];
  status: string;
};

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly tokenVerifier: FirebaseTokenVerifier,
    private readonly defaultWalletCurrency = 'SSP',
  ) {}

  async authenticate(authorizationHeader: string | undefined): Promise<AuthContext> {
    const token = this.extractBearerToken(authorizationHeader);

    let verified;
    try {
      verified = await this.tokenVerifier.verifyIdToken(token);
    } catch {
      throw new InvalidAuthTokenError();
    }

    const user = await this.upsertUser(verified.uid, verified.email, verified.phoneNumber);
    if (user.status !== 'ACTIVE') {
      throw new UserAccountUnavailableError();
    }
    await this.ensureDefaultCustomerWallet(user.id);

    return {
      userId: user.id,
      firebaseUid: user.firebase_uid,
      roles: user.roles,
      permissions: user.permissions,
    };
  }

  private extractBearerToken(authorizationHeader: string | undefined): string {
    if (!authorizationHeader) {
      throw new AuthenticationRequiredError();
    }

    const [scheme, token] = authorizationHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new AuthenticationRequiredError();
    }

    return token;
  }

  private async upsertUser(
    firebaseUid: string,
    email: string | undefined,
    phoneNumber: string | undefined,
  ): Promise<AppUserRow> {
    return this.db.transaction(async (tx) => {
      const upserted = await tx.query<{ id: string }>(
        `insert into app_users (firebase_uid, email, phone_number, roles, permissions, status)
         values ($1, $2, $3, $4, $5, 'ACTIVE')
         on conflict (firebase_uid) do update
         set email = coalesce(excluded.email, app_users.email),
             phone_number = coalesce(excluded.phone_number, app_users.phone_number),
             roles = case
               when cardinality(app_users.roles) = 0 then excluded.roles
               else app_users.roles
             end,
             updated_at = now()
         returning id`,
        [
          firebaseUid,
          email ?? null,
          phoneNumber ?? null,
          [DEFAULT_CUSTOMER_ROLE],
          [...DEFAULT_CUSTOMER_PERMISSIONS],
        ],
      );

      const result = await tx.query<AppUserRow>(
        `update app_users
         set permissions = array(
               select distinct permission
               from unnest(
                 app_users.permissions ||
                 case when $2 = any(app_users.roles) then $3::text[] else '{}'::text[] end
               ) as permission
             ),
             updated_at = now()
         where id = $1
         returning id, firebase_uid, roles, permissions, status`,
        [
          upserted.rows[0]!.id,
          DEFAULT_CUSTOMER_ROLE,
          [...DEFAULT_CUSTOMER_PERMISSIONS],
        ],
      );

      return result.rows[0]!;
    });
  }

  private async ensureDefaultCustomerWallet(userId: string): Promise<void> {
    await this.db.query(
      `insert into wallet_accounts (owner_user_id, account_type, currency, status)
       values ($1, 'CUSTOMER', $2, 'ACTIVE')
       on conflict (owner_user_id, account_type, currency) do nothing`,
      [userId, this.defaultWalletCurrency],
    );
  }
}
