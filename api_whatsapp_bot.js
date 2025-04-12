// --- Dependências ---
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal'); // <<<--- Essencial para imprimir no terminal
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const axios = require('axios');
const FormData = require('form-data');
const { promises: fsPromises } = require('fs');
require('dotenv').config();
const express = require('express');
const cors = require('cors');

// --- Configurações ---
const puppeteerOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu'],
    timeout: 90000, // 90 segundos
};

const setores = {
    "admin": { nome: "admin", arquivo: "contexto_admin.txt" },
    "1": { nome: "pecas", arquivo: "contexto_pecas.txt" },
    "2": { nome: "recepcao", arquivo: "contexto_recepcao.txt" },
    "3": { nome: "financeiro", arquivo: "contexto_financeiro.txt" },
    "4": { nome: "pneus", arquivo: "contexto_pneus.txt" },
    "5": { nome: "troca_oleo", arquivo: "contexto_troca_oleo.txt" },
    "6": { nome: "oficina", arquivo: "contexto_oficina.txt" }
};

// --- Estado Global Compartilhado (Bot + API + SSE) ---
const clientesWhatsApp = {}; // { clientId: wwebClientInstance }
const clientStatus = {};     // { clientId: 'offline'|'initializing'|'qr'|'ready'|... }
const lastQrCodes = {};      // { clientId: qrCodeString }

// --- Configuração de Diretórios ---
const baseDir = __dirname;
const dataDir = path.join(baseDir, 'data');
const logDir = path.join(dataDir, 'logs');
const historyBaseDir = path.join(dataDir, 'history');
const imagesDir = path.join(baseDir, 'imagens');
const authDir = path.join(baseDir, '.wwebjs_auth');

// --- <<<< Gerenciamento de Conexões SSE >>>> ---
let sseClients = [];
function sendSseEvent(eventType, data) {
    const formattedData = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach((clientRes, index) => {
        try {
            if (clientRes.writableEnded) { sseClients.splice(index, 1); }
            else { clientRes.write(formattedData); }
        } catch (error) { console.error(`[SSE SEND] Erro cliente ${index}:`, error.message); sseClients.splice(index, 1); try { clientRes.end(); } catch (e) {} }
    });
}
// --- <<<< FIM: Gerenciamento de Conexões SSE >>>> ---


// --- Funções Auxiliares (BOT - COLE AS SUAS AQUI) ---
// Certifique-se de que estas são as versões completas e funcionais do seu bot
const carregarContexto = (clientIdOuNomeSetor) => {
    const nomeSetor = setores[clientIdOuNomeSetor]?.nome || clientIdOuNomeSetor || 'admin';
    // console.log(`[Contexto - ${nomeSetor.toUpperCase()}] Carregando para: ${clientIdOuNomeSetor}`); // Log menos verboso
    let caminhoBase = baseDir;
    let caminhoRelativo = '';
    const setorInfo = Object.values(setores).find(s => s.nome === nomeSetor) || setores[clientIdOuNomeSetor];
    if (setorInfo) { caminhoRelativo = setorInfo.arquivo; } else { caminhoRelativo = setores["admin"].arquivo; console.warn(`[Contexto - ${nomeSetor.toUpperCase()}] Ctx não encontrado, fallback: ${caminhoRelativo}`); }
    const caminhoCompleto = path.join(caminhoBase, caminhoRelativo);
    try {
        if (!fs.existsSync(caminhoCompleto)) { const ctxPadrao = `Assistente virtual Chevrocar (${nomeSetor}).`; console.warn(`[Contexto - ${nomeSetor.toUpperCase()}] ${caminhoCompleto} não encontrado. Criando.`); fs.writeFileSync(caminhoCompleto, ctxPadrao, 'utf8'); }
        const data = fs.readFileSync(caminhoCompleto, 'utf8'); console.log(`[Contexto - ${nomeSetor.toUpperCase()}] Ctx carregado.`); return [{ role: "system", content: data }];
    } catch (error) { console.error(`[Contexto - ${nomeSetor.toUpperCase()}] Erro carregar ${caminhoCompleto}:`, error); return [{ role: "system", content: "Assistente Chevrocar." }]; }
};
const getUserHistoryFilePath = (numero, clientId) => { const sanitizedNumber = numero.replace(/[^a-zA-Z0-9]/g, '_'); const validClientId = setores[clientId] ? clientId : 'admin'; const sectorHistoryDir = path.join(historyBaseDir, validClientId); return path.join(sectorHistoryDir, `${sanitizedNumber}.json`); };
const getUserHistory = async (numero, clientId) => {
    const nomeSetor = setores[clientId]?.nome?.toUpperCase() || clientId.toUpperCase(); const filePath = getUserHistoryFilePath(numero, clientId); const sectorHistoryDir = path.dirname(filePath);
    try {
        await fsPromises.mkdir(sectorHistoryDir, { recursive: true });
        if (fs.existsSync(filePath)) { const data = await fsPromises.readFile(filePath, 'utf8'); if (data) { return JSON.parse(data); } }
        console.log(`[History - ${nomeSetor}] Arquivo não/vazio ${numero}. Criando.`); const initialContext = carregarContexto(clientId); return { historico: initialContext, setorAtual: clientId === 'admin' ? 'aguardando_escolha' : clientId };
    } catch (error) { console.error(`[History - ${nomeSetor}] Erro ler/parse ${numero} (${filePath}):`, error); const fallbackContext = carregarContexto(clientId); return { historico: fallbackContext, setorAtual: clientId === 'admin' ? 'aguardando_escolha' : clientId }; }
};
const saveUserHistory = async (numero, clientId, userData) => { const nomeSetor = setores[clientId]?.nome?.toUpperCase() || clientId.toUpperCase(); if (!userData?.historico) { console.error(`[History - ${nomeSetor}] Dados inválidos ${numero}. Abort save.`); return; } const filePath = getUserHistoryFilePath(numero, clientId); const sectorHistoryDir = path.dirname(filePath); try { await fsPromises.mkdir(sectorHistoryDir, { recursive: true }); const dataToSave = JSON.stringify(userData, null, 2); await fsPromises.writeFile(filePath, dataToSave, 'utf8'); } catch (error) { console.error(`[History - ${nomeSetor}] Erro salvar ${numero} (${filePath}):`, error); } };
const deleteUserHistoryFile = async (numero, oldClientId) => { const nomeSetor = setores[oldClientId]?.nome?.toUpperCase() || oldClientId.toUpperCase(); const filePath = getUserHistoryFilePath(numero, oldClientId); try { if (fs.existsSync(filePath)) { await fsPromises.unlink(filePath); console.log(`[Hist Transf - ${nomeSetor}] Arq antigo ${filePath} removido.`); } } catch (error) { console.error(`[Hist Transf - ${nomeSetor}] Erro remover ${filePath}:`, error); } };
const enviarParaChatGPT = async (mensagem, historicoAtual, setorContextoId) => {
    const nomeSetor = setores[setorContextoId]?.nome?.toUpperCase() || setorContextoId.toUpperCase(); if (!Array.isArray(historicoAtual)) { console.error(`[ChatGPT - ${nomeSetor}] Hist inválido. Reset.`); historicoAtual = carregarContexto(setorContextoId); } historicoAtual.push({ role: "user", content: mensagem });
    const maxTrocas = 10; if (historicoAtual.length > (maxTrocas * 2) + 1) { console.log(`[ChatGPT - ${nomeSetor}] Hist > ${maxTrocas}. Removendo.`); historicoAtual = [ historicoAtual[0], ...historicoAtual.slice(-(maxTrocas * 2)) ]; }
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', { model: "gpt-3.5-turbo", messages: historicoAtual }, { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 });
        const resposta = response.data.choices[0].message.content; historicoAtual.push({ role: "assistant", content: resposta }); console.log(`[ChatGPT - ${nomeSetor}] Resp recebida.`); return { chatGPTResponse: resposta, updatedHistorico: historicoAtual };
    } catch (error) { console.error(`[ChatGPT - ${nomeSetor}] Erro API OpenAI:`, error.response?.data || error.message); historicoAtual.pop(); return { chatGPTResponse: "Problema conectar IA. Tente + tarde.", updatedHistorico: historicoAtual }; }
};
const analisarImagem = async (caminhoImagem, numero, setorContextoId, historicoAtual) => {
    const nomeSetor = setores[setorContextoId]?.nome?.toUpperCase() || setorContextoId.toUpperCase(); console.log(`[OCR - ${nomeSetor}] Analisando ${path.basename(caminhoImagem)} p/ ${numero}`); let textoAnalise = `Recebi img ${numero}.`; let ocrSuccess = false;
    try {
        if (!process.env.OCR_API_KEY) { console.warn(`[OCR - ${nomeSetor}] Chave OCR ñ config.`); textoAnalise = `Recebi img, mas ñ analiso.`; } else {
            const imageFile = await fsPromises.readFile(caminhoImagem); const base64Image = imageFile.toString('base64'); const ext = path.extname(caminhoImagem).substring(1); const form = new FormData(); form.append('base64Image', `data:image/${ext};base64,${base64Image}`); form.append('language', 'por');
            const response = await axios.post('https://api.ocr.space/parse/image', form, { headers: { ...form.getHeaders(), apikey: process.env.OCR_API_KEY }, timeout: 20000 });
            if (response.data.IsErroredOnProcessing) { console.error(`[OCR - ${nomeSetor}] Erro OCR:`, response.data.ErrorMessage.join(', ')); textoAnalise = `Erro proc img (OCR: ${response.data.ErrorMessage.join(', ')}). Descreva.`; } else {
                const txt = response.data.ParsedResults?.[0]?.ParsedText?.trim(); if (txt) { console.log(`[OCR - ${nomeSetor}] Txt: "${txt.substring(0, 50)}..."`); textoAnalise = `Img ${numero} txt: "${txt}". Analise.`; ocrSuccess = true; } else { console.log(`[OCR - ${nomeSetor}] Ñ txt.`); textoAnalise = `Img ${numero} s/ txt. Descreva.`; }
            }
        }
    } catch (err) { console.error(`[OCR - ${nomeSetor}] Erro crít img:`, err.response?.data || err.message); textoAnalise = `Erro inesperado proc img. Descreva.`; }
    finally { try { if (fs.existsSync(caminhoImagem)) { await fsPromises.unlink(caminhoImagem); } } catch (unlinkErr) { console.error(`[OCR - ${nomeSetor}] Erro remover ${caminhoImagem}:`, unlinkErr); } }
    const { chatGPTResponse, updatedHistorico } = await enviarParaChatGPT(textoAnalise, historicoAtual, setorContextoId); let finalResponse = chatGPTResponse;
    if (!ocrSuccess && !textoAnalise.includes("Erro") && !textoAnalise.includes("descreva")) { finalResponse = "Ñ extraí txt img. " + chatGPTResponse; } else if (textoAnalise.includes("Erro")) { finalResponse = "Erro proc img. " + chatGPTResponse; }
    return { response: finalResponse, updatedHistorico };
};
const logInteraction = async (logData, clientId) => { const nomeSetor = setores[clientId]?.nome?.toUpperCase() || clientId.toUpperCase(); const validClientId = setores[clientId] ? clientId : 'unknown'; const logPath = path.join(logDir, `log_${validClientId}.jsonl`); try { await fsPromises.mkdir(logDir, { recursive: true }); const logEntry = JSON.stringify(logData); await fsPromises.appendFile(logPath, logEntry + '\n', 'utf8'); } catch (error) { console.error(`[Logging - ${nomeSetor}] Erro log (${logPath}):`, error); } };
// --- FIM DAS FUNÇÕES AUXILIARES ---


// --- Função Principal de Inicialização do Cliente WA (CORRIGIDA para imprimir QR no terminal) ---
const inicializarClienteWhatsApp = (clientId) => {
    const nomeSetor = setores[clientId]?.nome?.toUpperCase() || clientId.toUpperCase();
    return new Promise((resolve, reject) => {
        if (clientesWhatsApp[clientId] || ['initializing', 'restarting', 'ready', 'qr'].includes(clientStatus[clientId])) {
            // console.warn(`[${nomeSetor}] Tentativa init já ativo/processo. Status: ${clientStatus[clientId]}`); // Opcional: Log mais verboso
             if (clientStatus[clientId] === 'ready') resolve(clientesWhatsApp[clientId]);
             else if (['initializing', 'restarting'].includes(clientStatus[clientId])) reject(new Error(`Cliente ${nomeSetor} já em estado ${clientStatus[clientId]}`));
             else resolve(clientesWhatsApp[clientId] || { fakeClient: true, status: clientStatus[clientId] });
            return;
        }
        console.log(`\n--- [${nomeSetor}] INICIANDO (ID: ${clientId}) ---`);
        clientStatus[clientId] = 'initializing'; sendSseEvent('status_update', { clientId, nome: nomeSetor, status: 'initializing' });
        lastQrCodes[clientId] = null;

        const client = new Client({ puppeteer: puppeteerOptions, authStrategy: new LocalAuth({ clientId: clientId, dataPath: authDir }), qrTimeout: 0 });

        client.on('qr', (qr) => {
            console.log(`\n###### [${nomeSetor}] QR CODE ######`);
            console.log(`Escaneie para conectar ${nomeSetor}:`);
            // ---> LINHA ESSENCIAL RESTAURADA ABAIXO <---
            qrcode.generate(qr, { small: true }); // IMPRIME QR NO TERMINAL
            // ---> FIM DA LINHA RESTAURADA <---
            console.log(`################################`);
            clientStatus[clientId] = 'qr';
            lastQrCodes[clientId] = qr;
            sendSseEvent('qr', { clientId, nome: nomeSetor, qrCode: qr }); // Envia para o frontend via SSE
        });

        client.on('ready', async () => { console.log(`\n✅ [${nomeSetor}] Pronto!`); clientesWhatsApp[clientId] = client; clientStatus[clientId] = 'ready'; lastQrCodes[clientId] = null; sendSseEvent('status_update', { clientId, nome: nomeSetor, status: 'ready' }); try { const info = await client.info; console.log(`   - Conectado: ${info.pushname||'N/A'}`); } catch (e) {} resolve(client); });
        client.on('authenticated', () => console.log(`[${nomeSetor}] Autenticado (sessão).`));
        client.on('auth_failure', (msg) => { console.error(`\n❌ [${nomeSetor}] FALHA AUTH:`, msg); clientStatus[clientId] = 'auth_failure'; sendSseEvent('status_update', { clientId, nome: nomeSetor, status: 'auth_failure', reason: msg }); lastQrCodes[clientId] = null; delete clientesWhatsApp[clientId]; reject(new Error(`Falha auth ${nomeSetor}: ${msg}`)); });
        client.on('disconnected', (reason) => { console.warn(`\n⚠️ [${nomeSetor}] Desconectado:`, reason); const prev = clientStatus[clientId]; clientStatus[clientId] = 'disconnected'; sendSseEvent('status_update', { clientId, nome: nomeSetor, status: 'disconnected', reason: reason }); lastQrCodes[clientId] = null; delete clientesWhatsApp[clientId]; if (['initializing', 'qr'].includes(prev)) { reject(new Error(`Desconectado init ${nomeSetor}: ${reason}`)); } });

        // --- Handler Principal de Mensagens (SEU CÓDIGO ORIGINAL DEVE SER COLADO AQUI) ---
        client.on('message', async (message) => {
            // ==============================================================
            // >>> COLE AQUI SUA LÓGICA COMPLETA DO client.on('message', ...) <<<
            // Exemplo mínimo apenas para estrutura:
            if (message.isGroupMsg || message.from === 'status@broadcast') return;
            const numero = message.from;
            const texto = message.body?.trim();
            const receivingClientId = clientId;
            const receivingClientName = setores[receivingClientId]?.nome?.toUpperCase() || receivingClientId.toUpperCase();
            console.log(`[MSG IN - ${receivingClientName}] De: ${numero} | Texto: ${texto}`);
            // Aqui viria sua lógica de getUserHistory, saveUserHistory, enviarParaChatGPT, analisarImagem, logInteraction, etc.
             if(texto?.toLowerCase() === 'ping') {
                await message.reply(`Pong de ${receivingClientName}`);
            }
            // ==============================================================
        });
        // --- Fim do Handler de Mensagens ---

        // --- Inicialização Efetiva ---
        client.initialize().catch(err => {
            console.error(`\n❌ [${nomeSetor}] ERRO initialize():`, err);
            clientStatus[clientId] = 'error'; sendSseEvent('status_update', { clientId, nome: nomeSetor, status: 'error', reason: err.message || 'Erro init' });
            lastQrCodes[clientId] = null; delete clientesWhatsApp[clientId]; reject(err);
        });
    }); // Fim da Promise
};

// --- Orquestração da Inicialização (Bot - Concorrente com Delay) ---
const iniciarTodosOsClientes = async () => {
    console.log("\n--- INICIANDO AUTENTICAÇÃO (CONCORRENTE + DELAY + SSE) ---");
    const todosSetoresIds = Object.keys(setores); const initializationPromises = []; const delayEntreDisparosMs = 500;
    console.log(`Disparando inicializações com ${delayEntreDisparosMs}ms de atraso...`);
    for (const setorId of todosSetoresIds) {
        const nomeSetor = setores[setorId].nome.toUpperCase(); if (!clientStatus[setorId]) { clientStatus[setorId] = 'offline'; sendSseEvent('status_update', { clientId: setorId, nome: nomeSetor, status: 'offline'}); }
        if (['offline', 'disconnected', 'error', 'auth_failure'].includes(clientStatus[setorId])) {
            const initPromise = inicializarClienteWhatsApp(setorId).catch(error => ({ status: 'failed_init', clientId: setorId, nomeSetor: nomeSetor, reason: error.message }));
            initializationPromises.push({ promise: initPromise, clientId: setorId, nomeSetor: nomeSetor });
            if (delayEntreDisparosMs > 0 && todosSetoresIds.indexOf(setorId) < todosSetoresIds.length - 1) { await new Promise(resolve => setTimeout(resolve, delayEntreDisparosMs)); }
        } else { console.log(`   -> ${nomeSetor} (ID: ${setorId}) já '${clientStatus[setorId]}'. Pulando.`); sendSseEvent('status_update', { clientId: setorId, nome: nomeSetor, status: clientStatus[setorId] }); if(clientStatus[setorId] === 'qr' && lastQrCodes[setorId]) { sendSseEvent('qr', { clientId: setorId, nome: nomeSetor, qrCode: lastQrCodes[setorId] });} }
    }
    if (initializationPromises.length === 0) { console.log("\nNenhum cliente precisou iniciar."); return; }
    console.log(`\n--- Aguardando conclusão das ${initializationPromises.length} tentativas... ---`);
    const results = await Promise.allSettled(initializationPromises.map(p => p.promise));
    console.log("\n--- Resultados Finais das Tentativas ---");
    results.forEach((result, index) => { const clientInfo = initializationPromises[index]; const nomeSetor = clientInfo.nomeSetor; if (result.status === 'fulfilled') { if (result.value && !result.value.fakeClient) { console.log(`✅ [${nomeSetor}] INICIALIZADO (Ready).`); } } else { const reason = result.reason?.message || result.reason?.reason || 'Erro desconhecido'; console.error(`❌ [${nomeSetor}] FALHA INICIALIZAÇÃO. Razão: ${reason}`); } });
    console.log("\n========================================"); console.log("🏁 FIM TENTATIVAS INICIALIZAÇÃO!"); console.log("   API/SSE prontos."); console.log("========================================");
    if (results.some(r => r.status === 'rejected' && r.reason?.message?.includes('Execution context'))) { console.warn("\n⚠️ ATENÇÃO: Erros 'Execution context'. Considere aumentar delay ou usar modo sequencial."); }
};

// --- Cria diretórios necessários (Bot) ---
const ensureDirectoriesExist = async () => { console.log("Verificando/Criando diretórios..."); const dirs = [dataDir, logDir, historyBaseDir, imagesDir, authDir, ...Object.keys(setores).map(id => path.join(historyBaseDir, id))]; try { for (const dir of dirs) { await fsPromises.mkdir(dir, { recursive: true }); } console.log("Diretórios OK."); } catch (error) { console.error("❌ Erro fatal criar dirs:", error); process.exit(1); } };

// --- Tratamento de Encerramento Graceful (Bot + API + SSE) ---
const cleanup = async (signal) => { console.log(`\n\n--- ${signal} recebido. ENCERRANDO ---`); let exitCode = 0; console.log('[Cleanup] Fechando SSE...'); sseClients.forEach(res => { try { res.end(); } catch(e){} }); sseClients = []; console.log('[Cleanup] SSE fechadas.'); if (server) { console.log("[Cleanup] Fechando API..."); await new Promise((resolve, reject) => { server.close((err) => { if (err) { console.error("[Cleanup] Erro fechar API:", err); exitCode = 1; reject(err); } else { console.log("[Cleanup] API fechada."); resolve(); } }); }); } console.log("[Cleanup] Parando clientes WA..."); const active = Object.keys(clientesWhatsApp); const promises = active.map(id => { const c = clientesWhatsApp[id]; if (c?.destroy) { const nome = setores[id]?.nome || id; console.log(`[Cleanup] Destruindo ${nome}...`); return c.destroy().then(() => console.log(`[Cleanup] ${nome} destruído.`)).catch(err => { console.error(`[Cleanup] Erro destruir ${nome}:`, err); exitCode = 1; }); } return Promise.resolve(); }); try { await Promise.allSettled(promises); console.log("[Cleanup] Clientes parados."); } catch (error) { console.error("[Cleanup] Erro parada clientes:", error); exitCode = 1; } console.log(`--- Encerrado com código ${exitCode}. ---`); process.exit(exitCode); };


// ======================================================
//               CONFIGURAÇÃO DA API EXPRESS
// ======================================================
const app = express();
const port = process.env.API_PORT || 3001;
app.use(cors());
app.use(express.json());

// --- Middleware de Log da API ---
app.use((req, res, next) => { const start = Date.now(); const tsReq = new Date().toISOString().substring(11,23); console.log(`[API REQ] ${tsReq} ${req.method} ${req.originalUrl}`); res.on('finish', () => {const dur = Date.now()-start; const tsRes = new Date().toISOString().substring(11,23); const st = res.statusCode; const clr=st>=500?'\x1b[31m':st>=400?'\x1b[33m':st>=300?'\x1b[36m':'\x1b[32m'; console.log(`[API RES] ${tsRes} ${req.method} ${req.originalUrl} Status:${clr}${st}\x1b[0m ${dur}ms`);}); next(); });

// --- ROTAS DA API ---

// <<<< ENDPOINT SSE >>>>
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
    console.log('[SSE Connect] Cliente conectado.'); sseClients.push(res);
    Object.keys(setores).forEach(id => { const st = clientStatus[id] || 'offline'; const nm = setores[id]?.nome || id; sendSseEvent('status_update', { clientId: id, nome: nm, status: st }); if (st === 'qr' && lastQrCodes[id]) { sendSseEvent('qr', { clientId: id, nome: nm, qrCode: lastQrCodes[id] }); } });
    req.on('close', () => { console.log('[SSE Disconnect] Cliente desconectado.'); sseClients = sseClients.filter(c => c !== res); res.end(); });
    const keepAlive = setInterval(() => { try { res.write(':ka\n\n'); } catch (e) { clearInterval(keepAlive); } }, 20000); req.on('close', () => clearInterval(keepAlive));
});

// --- Rotas API REST (MANTENHA AS QUE VOCÊ USA) ---
app.get('/api/clients', (req, res) => { const clientList = Object.keys(setores).map(id => ({ id, nome: setores[id]?.nome || id, status: clientStatus[id] || 'offline' })); res.json(clientList); });
app.post('/api/clients/:clientId/send/text', async (req, res) => { /* Sua lógica de envio */ });
// ... (Mantenha suas outras rotas REST aqui)


// --- Middlewares de Erro ---
app.use((req, res, next) => { res.status(404).json({ error: 'Not Found', path: req.originalUrl }); });
app.use((err, req, res, next) => { console.error("[API Error Handler]:", err); res.status(500).json({ error: 'Internal Server Error', details: err.message }); });


// --- Iniciar o Servidor e o Bot ---
let server;
const startApp = async () => {
    await ensureDirectoriesExist();
    server = app.listen(port, () => { console.log(`\n🚀 API Server (SSE) rodando em http://localhost:${port}`); console.log('   SSE em /api/events'); iniciarTodosOsClientes(); });
    server.on('error', (error) => { if (error.code === 'EADDRINUSE') { console.error(`\n❌ Porta ${port} em uso.`); } else { console.error('\n❌ ERRO FATAL API:', error); } process.exit(1); });
};

// --- Tratamento de Encerramento ---
process.on('SIGINT', () => cleanup('SIGINT')); process.on('SIGTERM', () => cleanup('SIGTERM'));
process.on('uncaughtException', (error, origin) => { console.error('\n!!! EXCEÇÃO NÃO TRATADA !!!'); console.error('Origem:', origin); console.error('Erro:', error); Promise.race([cleanup('uncaughtException'), new Promise(res => setTimeout(res, 5000))]).finally(() => process.exit(1)); });
process.on('unhandledRejection', (reason, promise) => { console.error('\n!!! PROMISE REJEITADA NÃO TRATADA !!!'); console.error('Promise:', promise); console.error('Razão:', reason); /* Considerar encerrar aqui */ });

// --- Inicia ---
startApp();
