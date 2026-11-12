import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const BASE_ID = process.env.AIRTABLE_BASE_ID || 'appdovTw57IDaQBrs';
const TABLE_NAME = process.env.AIRTABLE_TABLE || 'Reservas_B1';
const RESIDENT_TABLE = 'Identificacao';
const COOKIE_NAME = 'florence_session';
const SESSION_SECONDS = 60 * 60 * 24 * 30;

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

function sessionFrom(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const parts = match[1].split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = sign(payload);
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.apartment || data.block !== '1' || !data.credentialTag ||
        data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}

function sessionCookie(value, maxAge = SESSION_SECONDS) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function todayKey() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find(p => p.type === type)?.value;
  return `${get('year')}/${get('month')}/${get('day')}`;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

function airtableUrl(tableName = TABLE_NAME, path = '') {
  return `https://api.airtable.com/v0/${encodeURIComponent(BASE_ID)}/${encodeURIComponent(tableName)}${path}`;
}

function airtableHeaders() {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error('AIRTABLE_TOKEN não configurado');
  return { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function airtableFind(formula) {
  const params = new URLSearchParams();
  params.set('filterByFormula', formula);
  params.append('fields[]', 'apartamento');
  params.append('fields[]', 'data');
  const response = await fetch(`${airtableUrl()}?${params}`, { headers: airtableHeaders() });
  if (!response.ok) {
    console.error('Airtable reservation query failed:', response.status, await response.text());
    throw new Error('Falha ao consultar reservas');
  }
  const payload = await response.json();
  return payload.records || [];
}

async function findResident(apartment) {
  const formula = `AND(OR({apartamento}='${apartment}',{apartamento}=${apartment}),OR({bloco}='1',{bloco}=1))`;
  const params = new URLSearchParams();
  params.set('filterByFormula', formula);
  for (const field of ['apartamento', 'bloco', 'senha']) params.append('fields[]', field);
  params.set('maxRecords', '2');
  const response = await fetch(`${airtableUrl(RESIDENT_TABLE)}?${params}`, { headers: airtableHeaders() });
  if (!response.ok) {
    console.error('Airtable resident validation failed:', response.status, await response.text());
    throw new Error('Falha ao validar sessão');
  }
  const payload = await response.json();
  if (!Array.isArray(payload.records) || payload.records.length !== 1) return null;
  return payload.records[0];
}

function renewedCookie(session, password) {
  return sessionCookie(makeSession(String(session.apartment), password));
}

export default async (request) => {
  try {
    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE') {
      return json({ error: 'Método não permitido' }, 405);
    }
    if (request.method !== 'GET') {
      const origin = request.headers.get('origin');
      if (origin && origin !== new URL(request.url).origin) return json({ error: 'Origem não autorizada' }, 403);
    }

    const session = sessionFrom(request);
    if (!session) return json({ error: 'Faça login para continuar.' }, 401, { 'set-cookie': sessionCookie('', 0) });

    const apartment = String(session.apartment);
    const resident = await findResident(apartment);
    const savedPassword = String(resident?.fields?.senha ?? '');
    if (!resident || !savedPassword ||
        credentialTag(apartment, savedPassword) !== session.credentialTag) {
      return json({ error: 'Sua sessão expirou. Entre novamente.' }, 401, { 'set-cookie': sessionCookie('', 0) });
    }
    const keepAlive = { 'set-cookie': renewedCookie(session, savedPassword) };

    if (request.method === 'GET') {
      const records = await airtableFind(`{apartamento}='${apartment}'`);
      return json({
        apartment,
        records: records.map(record => ({
          id: record.id,
          date: String(record.fields?.data || '').replaceAll('/', '-'),
        })).sort((a, b) => a.date.localeCompare(b.date)),
      }, 200, keepAlive);
    }

    if (request.method === 'POST') {
      const apartmentNumber = Number(apartment);
      if (!Number.isSafeInteger(apartmentNumber)) {
        return json({ error: 'Apartamento inválido na sessão. Faça login novamente.' }, 400, keepAlive);
      }

      const body = await request.json().catch(() => null);
      const date = validDate(body?.date);
      if (!date) return json({ error: 'Informe uma data válida.' }, 400, keepAlive);
      if (date < todayKey()) return json({ error: 'Não é possível reservar uma data que já passou.' }, 400, keepAlive);

      const existing = await airtableFind(`{data}='${date}'`);
      if (existing.length) return json({ error: 'Essa data já está reservada. Escolha outra.' }, 409, keepAlive);

      const today = todayKey();
      const apartmentReservations = await airtableFind(
        `AND({apartamento}=${apartmentNumber},{data}>='${today}')`
      );
      if (apartmentReservations.length) {
        return json({
          error: 'Seu apartamento já possui uma reserva futura. Cancele essa reserva antes de fazer outra.'
        }, 409, keepAlive);
      }

      const createFields = { apartamento: apartmentNumber, data: date };
      const response = await fetch(airtableUrl(), {
        method: 'POST',
        headers: airtableHeaders(),
        body: JSON.stringify({ records: [{ fields: createFields }] }),
      });
      if (!response.ok) {
        console.error('Airtable reservation create failed:', response.status, await response.text());
        return json({ error: 'Não foi possível salvar a reserva.' }, 502, keepAlive);
      }
      const payload = await response.json();
      return json({
        success: true,
        record: { id: payload.records?.[0]?.id, date: date.replaceAll('/', '-') },
      }, 201, keepAlive);
    }

    const body = await request.json().catch(() => null);
    const recordId = String(body?.recordId || '');
    if (!/^rec[a-zA-Z0-9]{10,}$/.test(recordId)) return json({ error: 'Reserva inválida.' }, 400, keepAlive);

    const recordResponse = await fetch(airtableUrl(TABLE_NAME, `/${encodeURIComponent(recordId)}`), {
      headers: airtableHeaders(),
    });
    if (recordResponse.status === 404) return json({ error: 'Essa reserva não foi encontrada.' }, 404, keepAlive);
    if (!recordResponse.ok) {
      console.error('Airtable reservation lookup failed:', recordResponse.status, await recordResponse.text());
      return json({ error: 'Não foi possível verificar a reserva.' }, 502, keepAlive);
    }
    const record = await recordResponse.json();
    if (String(record.fields?.apartamento ?? '') !== apartment) {
      return json({ error: 'Você só pode cancelar reservas do seu apartamento.' }, 403, keepAlive);
    }
    const recordDate = String(record.fields?.data || '').replaceAll('-', '/');
    if (!/^\d{4}\/\d{2}\/\d{2}$/.test(recordDate) || recordDate < todayKey()) {
      return json({ error: 'Não é possível cancelar uma reserva passada.' }, 400, keepAlive);
    }

    const deleteResponse = await fetch(airtableUrl(TABLE_NAME, `/${encodeURIComponent(recordId)}`), {
      method: 'DELETE', headers: airtableHeaders(),
    });
    if (!deleteResponse.ok) {
      console.error('Airtable reservation delete failed:', deleteResponse.status, await deleteResponse.text());
      return json({ error: 'Não foi possível cancelar a reserva.' }, 502, keepAlive);
    }
    return json({ success: true }, 200, keepAlive);
  } catch (error) {
    console.error('Resident area error:', error);
    return json({ error: 'Ocorreu um erro ao processar sua solicitação.' }, 500);
  }
};
