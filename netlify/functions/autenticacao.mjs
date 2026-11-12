import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appdovTw57IDaQBrs';
const TABLE_NAME = 'Identificacao';
const COOKIE_NAME = 'florence_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_PASSWORD = 'Jd#307*res&JoacaBA';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
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

function credentialTag(apartment, password) {
  return sign(`florence-credential-v1:${apartment}:${password}`);
}

function makeSession(apartment, password) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    apartment,
    block: '1',
    credentialTag: credentialTag(apartment, password),
    iat: now,
    exp: now + SESSION_SECONDS,
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
    if (!data.apartment || data.block !== '1' ||
        !data.credentialTag || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

function sessionCookie(value, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function validApartment(value) {
  return /^\d{3,4}$/.test(value);
}

function validNewPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 200 &&
    value !== DEFAULT_PASSWORD;
}

function airtableHeaders() {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN não configurado');
  return { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function findResident(apartment) {
  const formula = `AND(OR({apartamento}='${apartment}',{apartamento}=${apartment}),OR({bloco}='1',{bloco}=1))`;
  const params = new URLSearchParams();
  params.set('filterByFormula', formula);
  for (const field of ['apartamento', 'bloco', 'senha']) params.append('fields[]', field);
  params.set('maxRecords', '2');

  const url = `https://api.airtable.com/v0/${encodeURIComponent(BASE_ID)}/${encodeURIComponent(TABLE_NAME)}?${params}`;
  const response = await fetch(url, { headers: airtableHeaders() });
  if (!response.ok) {
    console.error('Airtable resident lookup failed:', response.status, await response.text());
    throw new Error('Falha ao consultar cadastro');
  }
  const payload = await response.json();
  if (!Array.isArray(payload.records) || payload.records.length !== 1) return null;
  return payload.records[0];
}

async function updateResidentPassword(recordId, password) {
  const url = `https://api.airtable.com/v0/${encodeURIComponent(BASE_ID)}/${encodeURIComponent(TABLE_NAME)}/${encodeURIComponent(recordId)}`;
  const response = await fetch(url, {
    method: 'PATCH',
    headers: airtableHeaders(),
    body: JSON.stringify({ fields: { senha: password } }),
  });
  if (!response.ok) {
    console.error('Airtable password update failed:', response.status, await response.text());
    throw new Error('Não foi possível atualizar a senha');
  }
  return response.json();
}

async function currentResidentSession(request) {
  const session = readSession(request);
  if (!session) return null;
  const resident = await findResident(String(session.apartment));
  if (!resident) return null;
  const savedPassword = String(resident.fields?.senha ?? '');
  if (!savedPassword || credentialTag(String(session.apartment), savedPassword) !== session.credentialTag) return null;
  return { session, resident, savedPassword };
}

export default async (request) => {
  try {
    if (request.method === 'GET') {
      const current = await currentResidentSession(request);
      if (!current) {
        return json({ authenticated: false }, 401, { 'set-cookie': sessionCookie('', 0) });
      }
      const renewed = makeSession(String(current.session.apartment), current.savedPassword);
      return json(
        { authenticated: true, apartment: current.session.apartment, block: '1' },
        200,
        { 'set-cookie': sessionCookie(renewed) },
      );
    }

    if (request.method !== 'POST') {
      return json({ error: 'Método não permitido' }, 405, { Allow: 'GET, POST' });
    }

    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) {
      return json({ error: 'Origem não autorizada' }, 403);
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'Requisição inválida' }, 400);

    if (body.action === 'logout') {
      return json({ success: true }, 200, { 'set-cookie': sessionCookie('', 0) });
    }

    if (body.action === 'login') {
      const apartment = String(body.apartment || '').trim();
      const password = String(body.password || '');
      if (!validApartment(apartment) || password.length > 200) {
        return json({ error: 'Informe um apartamento válido.' }, 400);
      }

      const resident = await findResident(apartment);
      if (!resident) return json({ error: 'Apartamento ou senha incorretos.' }, 401);

      const savedPassword = String(resident.fields?.senha ?? '');
      if (savedPassword === DEFAULT_PASSWORD) {
        return json({ requiresRegistration: true, apartment });
      }
      if (!password || savedPassword !== password) {
        return json({ error: 'Apartamento ou senha incorretos.' }, 401);
      }

      return json({ success: true, apartment, block: '1' }, 200, {
        'set-cookie': sessionCookie(makeSession(apartment, savedPassword)),
      });
    }

    if (body.action === 'register') {
      const apartment = String(body.apartment || '').trim();
      const newPassword = String(body.newPassword || '');
      if (!validApartment(apartment)) return json({ error: 'Informe um apartamento válido.' }, 400);
      if (!validNewPassword(newPassword)) {
        return json({ error: 'A nova senha deve ter pelo menos 8 caracteres e não pode ser a senha padrão.' }, 400);
      }

      const resident = await findResident(apartment);
      if (!resident) return json({ error: 'Apartamento não encontrado no cadastro.' }, 404);
      if (String(resident.fields?.senha ?? '') !== DEFAULT_PASSWORD) {
        return json({ error: 'Este apartamento já possui uma senha cadastrada. Faça login para continuar.' }, 409);
      }

      await updateResidentPassword(resident.id, newPassword);
      return json({ success: true, apartment }, 200, {
        'set-cookie': sessionCookie(makeSession(apartment, newPassword)),
      });
    }

    if (body.action === 'changePassword') {
      const current = await currentResidentSession(request);
      if (!current) {
        return json({ error: 'Sua sessão expirou. Entre novamente.' }, 401, { 'set-cookie': sessionCookie('', 0) });
      }

      const currentPassword = String(body.currentPassword || '');
      const newPassword = String(body.newPassword || '');
      if (current.savedPassword !== currentPassword) {
        return json({ error: 'A senha atual está incorreta.' }, 401);
      }
      if (!validNewPassword(newPassword)) {
        return json({ error: 'A nova senha deve ter pelo menos 8 caracteres e não pode ser a senha padrão.' }, 400);
      }

      await updateResidentPassword(current.resident.id, newPassword);
      const apartment = String(current.session.apartment);
      return json({ success: true, apartment }, 200, {
        'set-cookie': sessionCookie(makeSession(apartment, newPassword)),
      });
    }

    return json({ error: 'Ação inválida' }, 400);
  } catch (error) {
    console.error('Authentication function error:', error);
    return json({ error: 'Não foi possível realizar a operação neste momento.' }, 500);
  }
};
