import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { isProductHidden } from './src/lib/hiddenProducts';
import { extractImagesFromBlingItem, getBlingImagesForProduct } from './server-bling-images';
import {
  getBlingTokenFromDb,
  upsertBlingTokenInDb,
  clearBlingTokenFromDb,
  BLING_ACCESS_TTL_MS
} from './server-bling-db';

dotenv.config();

const router = express.Router();

// Constantes oficiais da API v3 do Bling
const BLING_AUTH_BASE = 'https://www.bling.com.br/Api/v3/oauth/authorize';
const BLING_TOKEN_URL = 'https://www.bling.com.br/Api/v3/oauth/token';
const BLING_API_BASE = 'https://www.bling.com.br/Api/v3';
const TEN_MINUTES_MS = 10 * 60 * 1000;

export interface BlingTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  obtained_at: number;
}

// Cache em memória + trava contra chamadas simultâneas de renovação
let cachedTokens: BlingTokens | null = null;
let activeRefreshPromise: Promise<BlingTokens> | null = null;

function getClientCredentials() {
  const clientId = (process.env.BLING_CLIENT_ID || '').trim();
  const clientSecret = (process.env.BLING_CLIENT_SECRET || '').trim();
  const state = (process.env.BLING_STATE || 'streetstore_oauth_state').trim();
  const redirectUri = (process.env.BLING_REDIRECT_URI || '').trim();
  return { clientId, clientSecret, state, redirectUri };
}

/**
 * Lê os tokens persistidos no Firestore (integrations/bling)
 */
export async function loadBlingTokens(): Promise<BlingTokens | null> {
  const dbRow = await getBlingTokenFromDb();
  if (dbRow && (dbRow.access_token || dbRow.refresh_token)) {
    cachedTokens = {
      access_token: dbRow.access_token,
      refresh_token: dbRow.refresh_token || undefined,
      expires_in: dbRow.expires_in || 21600,
      expires_at: dbRow.expires_at,
      token_type: dbRow.token_type || 'Bearer',
      scope: dbRow.scope || '',
      obtained_at: dbRow.obtained_at
    };
    return cachedTokens;
  }
  return cachedTokens;
}

/**
 * Salva/sobrescreve access_token, refresh_token e expires_at no Firestore
 */
export async function saveBlingTokens(tokens: BlingTokens): Promise<void> {
  const obtainedAt = tokens.obtained_at || Date.now();
  const expiresInSec = Number(tokens.expires_in) || 21600;
  const expiresAt = tokens.expires_at ?? (obtainedAt + (tokens.access_token ? expiresInSec * 1000 : 0));

  const stored = await upsertBlingTokenInDb({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || '',
    expires_at: expiresAt,
    expires_in: expiresInSec,
    token_type: tokens.token_type || 'Bearer',
    scope: tokens.scope || '',
    obtained_at: obtainedAt
  });

  cachedTokens = {
    access_token: stored.access_token,
    refresh_token: stored.refresh_token || undefined,
    expires_in: stored.expires_in,
    expires_at: stored.expires_at,
    token_type: stored.token_type,
    scope: stored.scope,
    obtained_at: stored.obtained_at
  };

  console.log(`[Bling Firestore] Tokens atualizados com sucesso (expira em ${stored.expires_at_iso}).`);
}

export async function clearBlingTokens(): Promise<void> {
  cachedTokens = null;
  await clearBlingTokenFromDb();
}

/**
 * Troca o authorization_code inicial pelo primeiro par de tokens
 */
export async function exchangeCodeForTokens(code: string, redirectUri?: string): Promise<BlingTokens> {
  const { clientId, clientSecret } = getClientCredentials();
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const bodyParams = new URLSearchParams();
  bodyParams.append('grant_type', 'authorization_code');
  bodyParams.append('code', code.trim());
  if (redirectUri) {
    bodyParams.append('redirect_uri', redirectUri);
  }

  const res = await fetch(BLING_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': '1.0'
    },
    body: bodyParams.toString()
  });

  const json: any = await res.json();
  if (!res.ok || json.error) {
    const errDesc = json.error?.message || json.error_description || json.error || 'Erro OAuth Bling';
    throw new Error(`Erro Bling OAuth: ${errDesc}`);
  }

  const obtainedAt = Date.now();
  const expiresInSec = Number(json.expires_in) || 21600;
  const expiresAt = obtainedAt + expiresInSec * 1000;

  const tokenData: BlingTokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: expiresInSec,
    expires_at: expiresAt,
    token_type: json.token_type || 'Bearer',
    scope: json.scope || '',
    obtained_at: obtainedAt
  };

  await saveBlingTokens(tokenData);
  return tokenData;
}

/**
 * Renova o access_token automaticamente usando o refresh_token salvo no Firestore
 */
export async function refreshBlingToken(): Promise<BlingTokens> {
  if (activeRefreshPromise) {
    return activeRefreshPromise;
  }

  activeRefreshPromise = (async () => {
    try {
      const tokens = await loadBlingTokens();
      if (!tokens?.refresh_token) {
        throw new Error('Nenhum refresh_token disponível no Firestore para renovar sessão do Bling.');
      }

      const { clientId, clientSecret } = getClientCredentials();
      const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const bodyParams = new URLSearchParams();
      bodyParams.append('grant_type', 'refresh_token');
      bodyParams.append('refresh_token', tokens.refresh_token);

      console.log('[Bling] Renovando par de tokens via OAuth v3...');

      const res = await fetch(BLING_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': '1.0'
        },
        body: bodyParams.toString()
      });

      const json: any = await res.json();

      if (!res.ok || json.error || !json.access_token) {
        const errorMsg = json.error?.message || json.error_description || json.error || 'Falha ao renovar token';
        if (String(errorMsg).includes('invalid_grant')) {
          console.warn('[Bling] Refresh token inválido (invalid_grant). Limpando registro.');
          await clearBlingTokens();
        }
        throw new Error(`Erro ao renovar token Bling: ${errorMsg}`);
      }

      const now = Date.now();
      const expiresInSec = Number(json.expires_in) || 21600;
      const expiresAt = now + expiresInSec * 1000;

      // REGRA CRÍTICA BLING v3: Sobrescrever AMBOS access_token e o novo refresh_token
      const newTokens: BlingTokens = {
        access_token: json.access_token,
        refresh_token: json.refresh_token || tokens.refresh_token,
        expires_in: expiresInSec,
        expires_at: expiresAt,
        token_type: json.token_type || 'Bearer',
        scope: json.scope || tokens.scope || '',
        obtained_at: now
      };

      await saveBlingTokens(newTokens);
      return newTokens;
    } finally {
      activeRefreshPromise = null;
    }
  })();

  return activeRefreshPromise;
}

/**
 * Retorna sempre um access_token válido (renova se faltar menos de 10 min para vencer)
 */
export async function getValidBlingToken(): Promise<string> {
  const tokens = await loadBlingTokens();
  if (!tokens) {
    throw new Error('Integração com o Bling não autorizada. Acesse /api/bling/auth para conectar.');
  }

  const now = Date.now();
  const isExpired = !tokens.access_token || !tokens.expires_at || now >= tokens.expires_at - TEN_MINUTES_MS;

  if (isExpired) {
    const refreshed = await refreshBlingToken();
    return refreshed.access_token;
  }

  return tokens.access_token;
}

export async function fetchFromBling(endpoint: string): Promise<any> {
  const token = await getValidBlingToken();
  const url = endpoint.startsWith('http') ? endpoint : `${BLING_API_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    }
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Erro Bling API [${res.status}]: ${errText}`);
  }
  return res.json();
}
// ============================================================================
// ROTAS EXPRESS (OAuth, Manutenção Automática e Sincronização Paginada)
// ============================================================================

// 1. Iniciar autorização manual (1 única vez)
router.get('/auth', (req: Request, res: Response) => {
  const { clientId, state, redirectUri } = getClientCredentials();
  if (!clientId) {
    return res.status(400).send('BLING_CLIENT_ID não configurado nas variáveis de ambiente.');
  }

  const authUrl = new URL(BLING_AUTH_BASE);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('state', state);
  if (redirectUri) {
    authUrl.searchParams.set('redirect_uri', redirectUri);
  }

  return res.redirect(authUrl.toString());
});

// 2. Callback OAuth do Bling
router.get('/callback', async (req: Request, res: Response) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code) {
      return res.status(400).json({ error: 'Parâmetro code não informado pelo Bling.' });
    }

    const { redirectUri } = getClientCredentials();
    await exchangeCodeForTokens(code, redirectUri || undefined);

    return res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #111; color: #fff;">
          <h1 style="color: #22c55e;">✅ Bling Conectado com Sucesso!</h1>
          <p>Os tokens foram salvos no Firestore e a renovação automática está ativa.</p>
          <p><a href="/" style="color: #38bdf8;">Voltar para a Street Store</a></p>
        </body>
      </html>
    `);
  } catch (err: any) {
    console.error('[Bling Callback Error]:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 3. Rota de manutenção para o Cron Job da Vercel (evita expirar após 30 dias sem uso)
router.get('/keep-alive', async (req: Request, res: Response) => {
  try {
    const token = await getValidBlingToken();
    return res.json({ ok: true, message: 'Token Bling verificado e ativo.', hasToken: Boolean(token) });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// 4. Sincronização paginada dos 1.411 produtos (100 por página para não dar timeout na Vercel)
router.get('/sync', async (req: Request, res: Response) => {
  try {
    const pagina = Math.max(1, Number(req.query.pagina) || 1);
    const limite = 100;
    const accessToken = await getValidBlingToken();

    const url = `${BLING_API_BASE}/produtos?pagina=${pagina}&limite=${limite}&criterio=2`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json'
      }
    });

    const json: any = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Erro na API do Bling', detalhes: json });
    }

    const lista = Array.isArray(json.data) ? json.data : [];

    if (lista.length === 0) {
      return res.json({
        finalizado: true,
        paginaAtual: pagina,
        importadosNaPagina: 0,
        mensagem: 'Sincronização concluída! Todos os produtos foram importados.'
      });
    }

    const { getFirestore, FieldValue } = await import('firebase-admin/firestore');
    const db = getFirestore();
    const batch = db.batch();
    let count = 0;

    for (const item of lista) {
      if (isProductHidden && isProductHidden(item)) continue;

      const blingId = String(item.id);
      const docRef = db.collection('products').doc(blingId);

      const imagens = extractImagesFromBlingItem
        ? extractImagesFromBlingItem(item)
        : (item.imagemURL ? [item.imagemURL] : []);

      const estoque = Number(item.estoque?.saldoVirtualTotal ?? item.estoque?.saldoFisicoTotal ?? 0);

      batch.set(docRef, {
        blingId,
        name: item.nome || 'Produto sem nome',
        sku: item.codigo || '',
        price: Number(item.preco) || 0,
        stock: estoque,
        active: item.situacao === 'A',
        images: imagens,
        image: (Array.isArray(imagens) && imagens[0]) || item.imagemURL || '',
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });

      count++;
    }

    await batch.commit();

    return res.json({
      finalizado: lista.length < limite,
      paginaAtual: pagina,
      proximaPagina: pagina + 1,
      importadosNaPagina: count
    });
  } catch (err: any) {
    console.error('[Bling Sync Error]:', err);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
