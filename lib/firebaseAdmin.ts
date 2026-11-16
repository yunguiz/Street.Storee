import { App, cert, getApps, initializeApp, ServiceAccount } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';

function parseServiceAccountFromEnv(): ServiceAccount {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT_KEY || '').trim();
  if (!raw) {
    throw new Error(
      'Variável de ambiente FIREBASE_SERVICE_ACCOUNT_KEY não configurada. Cole o JSON da Service Account (string JSON ou Base64).'
    );
  }

  let jsonString = raw;
  if (!raw.startsWith('{')) {
    // Decodifica Base64 caso a chave tenha sido salva codificada no painel da Vercel
    try {
      jsonString = Buffer.from(raw, 'base64').toString('utf8').trim();
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY inválida: não é JSON nem Base64 válido.');
    }
  }

  let parsed: ServiceAccount & { private_key?: string };
  try {
    parsed = JSON.parse(jsonString) as ServiceAccount & { private_key?: string };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Falha ao fazer parse do JSON em FIREBASE_SERVICE_ACCOUNT_KEY: ${msg}`);
  }

  // Normaliza quebras de linha escapadas (\n) na private_key colada no painel da Vercel
  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }

  return parsed;
}

export function getFirebaseAdminApp(): App {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  const serviceAccount = parseServiceAccountFromEnv();
  return initializeApp({
    credential: cert(serviceAccount),
  });
}

/**
 * Retorna a instância do Firestore com privilégios Admin SDK.
 * Usa o banco "(default)" do plano Spark ou o ID definido em FIREBASE_DATABASE_ID.
 */
export function getAdminFirestore(): Firestore {
  const app = getFirebaseAdminApp();
  const databaseId = (process.env.FIREBASE_DATABASE_ID || '').trim();

  if (databaseId && databaseId !== '(default)') {
    return getFirestore(app, databaseId);
  }

  return getFirestore(app);
}
