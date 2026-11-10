export default async () => {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID || "appdovTw57IDaQBrs";
  const tableName = process.env.AIRTABLE_TABLE || "Reservas_B1";

  if (!token) {
    return new Response(JSON.stringify({ error: "AIRTABLE_TOKEN não configurado" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }

  const fields = ["apartamento", "data"];
  const params = new URLSearchParams();
  fields.forEach((field) => params.append("fields[]", field));

  let allRecords = [];
  let offset = null;

  try {
    do {
      const pageParams = new URLSearchParams(params);
      if (offset) pageParams.set("offset", offset);

      const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableName)}?${pageParams}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        const detail = await response.text();
        console.error("Airtable API error:", response.status, detail);
        return new Response(JSON.stringify({ error: "Falha ao consultar o Airtable" }), {
          status: 502,
          headers: { "content-type": "application/json; charset=utf-8" }
        });
      }

      const payload = await response.json();
      allRecords = allRecords.concat((payload.records || []).map((record) => ({
        apartamento: record.fields?.apartamento ?? "",
        data: record.fields?.data ?? ""
      })));
      offset = payload.offset || null;
    } while (offset);

    return new Response(JSON.stringify({ records: allRecords }), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=30, s-maxage=30"
      }
    });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: "Erro interno ao consultar reservas" }), {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8" }
    });
  }
};
