# Calendário de Reservas — Florence

Página pública e somente de leitura. A página consulta o Airtable por uma Netlify Function; o token fica no servidor, nunca no navegador.

## Configuração

Variáveis de ambiente no Netlify (Project configuration → Environment variables):

- `AIRTABLE_TOKEN`: seu Personal Access Token do Airtable. Use apenas o scope `data.records:read` e acesso somente à base Florence.
- `AIRTABLE_BASE_ID`: `appdovTw57IDaQBrs` (já definido como padrão no código; opcional).
- `AIRTABLE_TABLE`: `Reservas_B1` (já definido como padrão no código; opcional).

A função consulta somente os campos `apartamento` e `data`. Ela trata datas em `YYYY/MM/DD` e `YYYY-MM-DD`.

## Publicação gratuita sugerida

1. Descompacte este arquivo.
2. Crie um repositório no GitHub e envie os arquivos mantendo a estrutura de pastas.
3. No Netlify, escolha **Add new project → Import an existing project** e conecte o repositório do GitHub.
4. Nas configurações do projeto Netlify, abra **Environment variables** e adicione `AIRTABLE_TOKEN` com o token criado no Airtable.
5. Faça o deploy. O Netlify fornecerá um endereço público `...netlify.app`.

Não coloque o token em `index.html`, no GitHub, no README ou em mensagens. Se o token tiver sido exposto, revogue-o no Airtable e crie outro.

## Atualização

A página busca os registros ao abrir e a cada 60 segundos. A função retorna apenas os campos de apartamento e data.
