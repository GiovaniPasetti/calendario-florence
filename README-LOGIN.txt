CALENDÁRIO FLORENCE — PRIMEIRA ETAPA DO ACESSO WEB

Arquivos novos/alterados:
- index.html: acrescenta o link "Acesso do morador" sem alterar o calendário.
- login.html: tela inicial de login para o Bloco 1.
- netlify/functions/auth.mjs: autenticação via Airtable e sessão em cookie HttpOnly.
- netlify/functions/reservas.mjs: mantida a função existente de leitura do calendário.
- netlify.toml: configuração atual preservada.

CONFIGURAÇÃO NECESSÁRIA NO NETLIFY
1. AIRTABLE_TOKEN: configurar um token NOVO, depois de revogar o token que estava embutido no arquivo Florence.aia.
2. SESSION_SECRET: criar um segredo aleatório com pelo menos 32 caracteres (ex.: openssl rand -hex 32) e cadastrá-lo como variável de ambiente.
3. AIRTABLE_BASE_ID pode permanecer appdovTw57IDaQBrs (ou ser configurada explicitamente).

TABELA ESPERADA NO AIRTABLE
Base: Florence
Tabela: Identificacao
Campos utilizados: apartamento, bloco, senha
O login consulta somente registros do Bloco 1. O campo device_ID não é necessário para a sessão web.

IMPORTANTE
- A tela de login é a primeira etapa. Após validar o acesso, a área de reservas ainda será desenvolvida.
- A tabela atual guarda a senha no campo "senha". Esta primeira implementação compara a senha no servidor e não a envia de volta ao navegador. Uma etapa posterior deve migrar o armazenamento para hash seguro.
- Não publique nem compartilhe tokens do Airtable em arquivos HTML, JavaScript do navegador ou projetos Kodular.
