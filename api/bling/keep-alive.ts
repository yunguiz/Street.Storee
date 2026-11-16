import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getValidBlingToken } from '../../lib/blingToken';

/**
 * Vercel Cron Job Endpoint: GET /api/bling/keep-alive
 * Executado 1 vez por semana via vercel.json para chamar getValidBlingToken()
 * e garantir que o refresh_token do Bling nunca passe de 30 dias sem uso.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Se CRON_SECRET estiver definido na Vercel, protege o endpoint contra chamadas externas não autorizadas
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  if (cronSecret) {
    const authHeader = req.headers.authorization || '';
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  }

  try {
    const accessToken = await getValidBlingToken();
    return res.status(200).json({
      ok: true,
      refreshedOrValid: Boolean(accessToken),
      checkedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[Vercel Cron /api/bling/keep-alive Error]:', message);
    return res.status(500).json({
      ok: false,
      error: message,
    });
  }
}
