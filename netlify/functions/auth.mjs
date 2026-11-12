import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appdovTw57IDaQBrs';
const TABLE_NAME = 'Identificacao';
const COOKIE_NAME = 'florence_session';
const SESSION_SECONDS = 60 * 60 * 8;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET ausente ou muito curta');
  return secret;
}

function sign(value) {
  return createHmac('sha256', getSecret()).update(value).digest('base64url');
}

function makeSession(apartment) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    apartment, block: '1', iat: now, exp: now + SESSION_SECONDS,
    nonce: randomBytes(12).toString('hex'),
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const parts = match[1].split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.apartment || data.block !== '1' || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}

function sessionCookie(value, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function findResident(apartment) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN não configurado');
  // apartment contém somente dígitos, validado antes de montar a fórmula.
  const formula = `AND(OR({apartamento}='${apartment}',{apartamento}=${apartment}),OR({bloco}='1',{bloco}=1))`;
  const params = new URLSearchParams();
  params.set('filterByFormula', formula);
  for (const field of ['apartamento', 'bloco', 'senha']) params.append('fields[]', field);
  params.set('maxRecords', '2');
  const url = `https://api.airtable.com/v0/${encodeURIComponent(BASE_ID)}/${encodeURIComponent(TABLE_NAME)}?${params}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const detail = await response.text();
    console.error('Airtable auth lookup failed:', response.status, detail);
    throw new Error('Falha ao consultar cadastro');
  }
  const payload = await response.json();
  if (!Array.isArray(payload.records) || payload.records.length !== 1) return null;
  return payload.records[0];
}

export default async (request) => {
  try {
    if (request.method === 'GET') {
      const session = readSession(request);
      if (!session) return json({ authenticated: false }, 401);
      return json({ authenticated: true, apartment: session.apartment, block: '1' });
    }
    if (request.method !== 'POST') return json({ error: 'Método não permitido' }, 405, { Allow: 'GET, POST' });
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'Requisição inválida' }, 400);
    if (body.action === 'logout') return json({ success: true }, 200, { 'set-cookie': sessionCookie('', 0) });
    if (body.action !== 'login') return json({ error: 'Ação inválida' }, 400);

    const apartment = String(body.apartment || '').trim();
    const password = String(body.password || '');
    if (!/^\d{3,4}$/.test(apartment) || !password || password.length > 200) {
      return json({ error: 'Informe o apartamento e a senha.' }, 400);
    }

    const resident = await findResident(apartment);
    const savedPassword = resident?.fields?.senha;
    // A senha é conferida somente no servidor e nunca é devolvida ao navegador.
    if (!resident || String(savedPassword ?? '') !== password) {
      return json({ error: 'Apartamento ou senha incorretos.' }, 401);
    }

    return json({ success: true, apartment, block: '1' }, 200, {
      'set-cookie': sessionCookie(makeSession(apartment)),
    });
  } catch (error) {
    console.error('Auth function error:', error);
    return json({ error: 'Não foi possível realizar o login neste momento.' }, 500);
  }
};
