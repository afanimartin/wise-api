import { createRemoteJWKSet, jwtVerify } from 'jose';

const firebaseJwks = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

export type VerifiedFirebaseToken = {
  uid: string;
  email?: string | undefined;
  phoneNumber?: string | undefined;
};

export type FirebaseTokenVerifier = {
  verifyIdToken: (idToken: string) => Promise<VerifiedFirebaseToken>;
};

export function createFirebaseTokenVerifier(projectId: string | undefined): FirebaseTokenVerifier {
  if (!projectId) {
    throw new Error('FIREBASE_PROJECT_ID is required to verify Firebase ID tokens');
  }

  return {
    verifyIdToken: async (idToken) => {
      const { payload } = await jwtVerify(idToken, firebaseJwks, {
        issuer: `https://securetoken.google.com/${projectId}`,
        audience: projectId,
      });

      if (!payload.sub) {
        throw new Error('Firebase token is missing subject');
      }

      return {
        uid: payload.sub,
        email: typeof payload.email === 'string' ? payload.email : undefined,
        phoneNumber: typeof payload.phone_number === 'string' ? payload.phone_number : undefined,
      };
    },
  };
}
