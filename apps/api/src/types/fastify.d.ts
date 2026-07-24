import type { Database } from '../shared/db/database.js';
import type { AuthContext } from '../modules/auth/auth.service.js';
import type { FirebaseTokenVerifier } from '../modules/auth/firebase-token-verifier.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    firebaseTokenVerifier: FirebaseTokenVerifier;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    auth: AuthContext | null;
  }
}
