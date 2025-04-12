# Bot Multi-Setor WhatsApp com API e Frontend SSE

Este projeto implementa um sistema de bot para WhatsApp capaz de gerenciar múltiplas contas (representando diferentes "setores" de atendimento) usando a biblioteca `whatsapp-web.js`. Ele fornece uma API RESTful (construída com Express.js) para interagir com os clientes WhatsApp e um endpoint Server-Sent Events (SSE) para atualizações em tempo real, ideal para um frontend que exibe QR Codes e status de conexão.

## Funcionalidades Principais

*   **Gerenciamento Multi-Cliente:** Inicia e gerencia múltiplas instâncias do cliente `whatsapp-web.js`, uma para cada "setor" definido.
*   **Autenticação via QR Code:** Gera QR codes para autenticação inicial de cada conta/setor.
    *   Exibe QR Codes no **terminal** onde o backend roda.
    *   Envia QR Codes via **SSE** para atualização em tempo real no frontend.
*   **Sessões Persistentes:** Utiliza `LocalAuth` para salvar e reutilizar sessões, evitando a necessidade de escanear o QR code a cada reinicialização (após a primeira conexão bem-sucedida).
*   **API RESTful:** Interface HTTP (Express.js) para:
    *   Listar setores e seus status.
    *   Obter status de um setor específico.
    *   Enviar mensagens de texto através de um setor.
    *   Listar usuários que interagiram com um setor.
    *   Obter histórico de conversa de um usuário.
    *   Obter logs recentes de um setor.
    *   Controlar os clientes (Reiniciar, Parar, Deslogar).
*   **Server-Sent Events (SSE):** Endpoint `/api/events` para que frontends possam receber atualizações em tempo real sobre:
    *   Geração de QR Codes.
    *   Mudanças de status dos clientes (conectando, pronto, desconectado, falha).
*   **Frontend Simples (Exemplo):** Inclui um exemplo de frontend (HTML/CSS/JS puro) que se conecta ao SSE para exibir os QR codes necessários dinamicamente e sem piscar.
*   **Histórico de Conversas:** Salva o histórico de cada conversa individualmente em arquivos JSON, separados por setor.
*   **Inteligência Artificial (Opcional):** Estrutura preparada para integração com ChatGPT (via `enviarParaChatGPT`) e análise de imagens (via `analisarImagem` com OCR). *(Requer configuração de API Keys)*.
*   **Configuração Flexível:** Utiliza variáveis de ambiente (`.env`) para configurações sensíveis (API Keys, Porta).
*   **Logging:** Registra interações e requisições da API para depuração.

## Pré-requisitos

*   **Node.js:** Versão 18.x ou superior recomendada.
*   **npm:** (Normalmente incluído com Node.js).
*   **Contas WhatsApp:** Uma conta WhatsApp válida para cada "setor" que você deseja conectar.
*   **API Keys (Opcional, se usar IA):**
    *   `OPENAI_API_KEY`: Para integração com ChatGPT.
    *   `OCR_API_KEY`: Para análise de imagens com OCR.space.

## Instalação

1.  **Clone ou Baixe o Repositório:**
    ```bash
    # Se estiver usando git
    git clone <url-do-seu-repositorio>
    cd <nome-da-pasta-do-projeto>

    # Ou apenas coloque os arquivos em uma pasta
    cd C:\testes\apiwhatsapp
    ```
2.  **Instale as Dependências:**
    ```bash
    npm install express cors whatsapp-web.js qrcode-terminal axios form-data dotenv
    ```
    *(O Puppeteer será instalado como dependência do `whatsapp-web.js`)*

## Configuração

1.  **Crie um arquivo `.env`** na raiz do projeto (mesma pasta do `api_whatsapp_bot_sse_full_terminalqr.js`).
2.  **Adicione as seguintes variáveis** (ajuste conforme necessário):

    ```dotenv
    # Chave da API da OpenAI (necessária para a função enviarParaChatGPT)
    OPENAI_API_KEY=sua_chave_openai_aqui

    # Chave da API do OCR.space (necessária para a função analisarImagem)
    OCR_API_KEY=sua_chave_ocrspace_aqui

    # Porta em que a API Express vai rodar (opcional, padrão 3001)
    API_PORT=3001
    ```

3.  **Configure os Setores:** Edite o objeto `setores` dentro do arquivo JavaScript principal (`api_whatsapp_bot_sse_full_terminalqr.js`) se precisar adicionar, remover ou renomear setores e seus arquivos de contexto.

    ```javascript
    const setores = {
        "admin": { nome: "admin", arquivo: "contexto_admin.txt" },
        "1": { nome: "pecas", arquivo: "contexto_pecas.txt" },
        // ... adicione mais setores conforme necessário
    };
    ```

4.  **Crie os Arquivos de Contexto:** Crie os arquivos de texto (ex: `contexto_admin.txt`, `contexto_pecas.txt`) na raiz do projeto, contendo as instruções iniciais para o ChatGPT para cada setor.

## Executando a Aplicação

O sistema consiste em duas partes principais: o Backend (bot + API) e o Frontend (para visualização).

**1. Executando o Backend:**

*   Abra seu terminal (Prompt de Comando, PowerShell, etc.).
*   Navegue até a pasta do projeto: `cd C:\testes\apiwhatsapp`.
*   Execute o script principal:
    ```bash
    node api_whatsapp_bot_sse_full_terminalqr.js
    ```
*   **Mantenha este terminal aberto!** Ele rodará o servidor da API e a lógica do bot.
*   Observe os logs neste terminal. QR Codes necessários serão impressos aqui.
*   **Para forçar novos QR Codes:** Pare o backend (Ctrl+C), delete a pasta `.wwebjs_auth` que foi criada dentro da pasta do projeto, e reinicie o backend.

**2. Executando o Frontend (Exemplo HTML/JS/SSE):**

*   **NÃO** acesse `http://localhost:3001` (ou a porta da API) diretamente no navegador para ver o frontend.
*   Abra seu explorador de arquivos.
*   Navegue até a pasta onde você salvou os arquivos do frontend (ex: `C:\testes\apiwhatsapp\front`).
*   **Dê um duplo clique no arquivo `index.html`**.
*   Isso abrirá a página no seu navegador usando o protocolo `file:///`.
*   O JavaScript (`script_sse.js`) nesta página se conectará automaticamente ao endpoint SSE (`http://localhost:3001/api/events`) do backend.
*   Os QR Codes necessários serão exibidos dinamicamente na página, atualizados em tempo real via SSE.

## Documentação da API

A API RESTful permite interagir com o backend. Assumindo que a API está rodando em `http://localhost:3001`:

*   **`GET /api`**
    *   **Descrição:** Rota base para verificar se a API está online.
    *   **Resposta (Sucesso 200):** `{ "message": "...", "status": "ok", ... }`

*   **`GET /api/clients`**
    *   **Descrição:** Lista todos os setores configurados e seus status atuais.
    *   **Resposta (Sucesso 200):** Array de objetos: `[{ "id": "admin", "nome": "admin", "status": "ready" }, { "id": "1", "nome": "pecas", "status": "qr" }, ...]`

*   **`GET /api/clients/:clientId/status`**
    *   **Descrição:** Obtém o status detalhado de um setor específico.
    *   **Parâmetros:** `:clientId` (ID do setor, ex: `admin`, `1`, `2`).
    *   **Resposta (Sucesso 200):** `{ "id": "1", "nome": "pecas", "status": "ready" }`
    *   **Resposta (Erro 404):** Se o clientId não for encontrado.

*   **`POST /api/clients/:clientId/send/text`**
    *   **Descrição:** Envia uma mensagem de texto através de um setor específico. O setor deve estar com status `ready`.
    *   **Parâmetros:** `:clientId` (ID do setor).
    *   **Corpo da Requisição (JSON):** `{ "number": "5511999998888", "message": "Sua mensagem aqui" }` (Use o número completo com código do país e DDD).
    *   **Resposta (Sucesso 200):** `{ "success": true, "messageId": "...", "number": "...", "client": "..." }`
    *   **Resposta (Erro 400):** Faltando `number` ou `message`.
    *   **Resposta (Erro 404):** `clientId` não encontrado.
    *   **Resposta (Erro 409):** Cliente não está `ready`.
    *   **Resposta (Erro 500):** Falha interna no envio.

*   **`GET /api/clients/:clientId/users`**
    *   **Descrição:** Lista os identificadores (números sanitizados) dos usuários que possuem um arquivo de histórico salvo para um setor específico.
    *   **Parâmetros:** `:clientId`.
    *   **Resposta (Sucesso 200):** `{ "client": "pecas", "users": ["5511999998888_c_us", ...] }` (Retorna array vazio se não houver usuários).

*   **`GET /api/clients/:clientId/conversations/:userNumber`**
    *   **Descrição:** Obtém o histórico completo da conversa de um usuário específico com um setor.
    *   **Parâmetros:** `:clientId`, `:userNumber` (Número completo do usuário, ex: `5511999998888@c.us`).
    *   **Resposta (Sucesso 200):** `{ "clientId": "1", "nome": "pecas", "userNumber": "...", "historico": [...], "setorAtual": "1" }`
    *   **Resposta (Erro 404):** Se não encontrar histórico para o usuário/setor.

*   **`GET /api/logs/:clientId`**
    *   **Descrição:** Obtém as linhas mais recentes do arquivo de log para um setor.
    *   **Parâmetros:** `:clientId`.
    *   **Query Params (Opcional):** `?limit=N` (Define o número máximo de linhas a retornar, padrão 100).
    *   **Resposta (Sucesso 200):** `{ "client": "admin", "logs": [...] }` (Array de objetos JSON ou strings se houver erro no parse do log).

*   **`POST /api/clients/:clientId/restart`**
    *   **Descrição:** Tenta reiniciar a conexão de um cliente/setor específico.
    *   **Parâmetros:** `:clientId`.
    *   **Resposta (Sucesso 200):** `{ "success": true, "message": "Reinicialização iniciada." }`

*   **`POST /api/clients/:clientId/stop`**
    *   **Descrição:** Para (desconecta e destrói) a instância de um cliente/setor.
    *   **Parâmetros:** `:clientId`.
    *   **Resposta (Sucesso 200):** `{ "success": true, "message": "Cliente parado." }`

*   **`POST /api/clients/:clientId/logout`**
    *   **Descrição:** Desconecta e invalida a sessão de um cliente/setor (requer novo QR code). O cliente deve estar `ready`.
    *   **Parâmetros:** `:clientId`.
    *   **Resposta (Sucesso 200):** `{ "success": true, "message": "Logout iniciado." }`

*   **`GET /api/events` (Server-Sent Events)**
    *   **Descrição:** Endpoint para conexão SSE. Clientes se conectam aqui para receber atualizações em tempo real. **Use com `EventSource` no JavaScript do frontend.**
    *   **Eventos Enviados:**
        *   `event: qr`
            *   `data: { "clientId": "...", "nome": "...", "qrCode": "..." }` (Enviado quando um QR code é gerado)
        *   `event: status_update`
            *   `data: { "clientId": "...", "nome": "...", "status": "...", "reason": "..." }` (Enviado quando o status muda: initializing, ready, disconnected, auth_failure, error)

## Troubleshooting Comum

*   **QR Code não aparece (Terminal ou Frontend):**
    *   Pare o backend (Ctrl+C).
    *   **Delete a pasta `.wwebjs_auth`**.
    *   Reinicie o backend. Isso força a geração de novos QRs.
    *   Verifique os logs do terminal do backend por mensagens de erro durante a inicialização.
*   **Frontend (SSE) não conecta ou não atualiza:**
    *   Verifique se o backend está rodando e acessível na URL/porta correta (`http://localhost:3001` por padrão).
    *   Verifique se a URL do `EventSource` no `script_sse.js` está correta.
    *   Abra o Console do Desenvolvedor do navegador (F12) na aba "Console" e "Network" para procurar erros de conexão SSE ou JavaScript.
    *   Confirme que `app.use(cors());` está presente no backend.
*   **Erro "Execution context was destroyed":**
    *   Geralmente causado por sobrecarga ao iniciar muitos clientes rapidamente.
    *   Certifique-se de que o `delayEntreDisparosMs` em `iniciarTodosOsClientes` tem um valor (ex: 500). Tente aumentá-lo (ex: 1000, 2000).
    *   Verifique os recursos do sistema (CPU/RAM).
    *   Como último recurso, considere voltar para a inicialização sequencial (usando `await` dentro do loop em `iniciarTodosOsClientes`).
*   **Erros da API:**
    *   Verifique os logs do terminal do backend para detalhes do erro.
    *   Confirme que você está enviando as requisições com o método HTTP correto (GET/POST) e o corpo JSON esperado (para POST).
    *   Verifique se os `:clientId` e outros parâmetros na URL estão corretos.
