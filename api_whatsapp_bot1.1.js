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
const clientesWhatsApp = {};
const clientStatus = {};
const lastQrCodes = {};

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


// --- Funções Auxiliares (BOT - Mantidas como estavam) ---
const carregarContexto = (clientIdOuNomeSetor) => {
    const nomeSetor = setores[clientIdOuNomeSetor]?.nome || clientIdOuNomeSetor || 'admin';
    // console.log(`[Contexto - ${nomeSetor.toUpperCase()}] Carregando para: ${clientIdOuNomeSetor}`); // Log menos verboso
    let caminhoBase = baseDir;
    let caminhoRelativo = '';
    const setorInfo = Object.values(setores).find(s => s.nome === nomeSetor) || setores[clientIdOuNomeSetor];
    if (setorInfo) { caminhoRelativo = setorInfo.arquivo; } else { caminhoRelativo = setores["admin"].arquivo; console.warn(`[Contexto - ${nomeSetor.toUpperCase()}] Ctx não encontrado, fallback: ${caminhoRelativo}`); }
    const caminhoCompleto = path.join(caminhoBase, caminhoRelativo);
    try {
        if (!fs.existsSync(caminhoCompleto)) { const ctxPadrao = `Assistente virtual Chevrocar (${nomeSetor}). Seja cordial, pergunte o nome se não souber, e ofereça ajuda ou direcionamento para um setor específico (Peças, Recepção, Financeiro, Pneus, Troca de óleo, Oficina). Se for direcionar, informe claramente.`; console.warn(`[Contexto - ${nomeSetor.toUpperCase()}] ${caminhoCompleto} não encontrado. Criando.`); fs.writeFileSync(caminhoCompleto, ctxPadrao, 'utf8'); }
        const data = fs.readFileSync(caminhoCompleto, 'utf8'); console.log(`[Contexto - ${nomeSetor.toUpperCase()}] Ctx carregado.`); return [{ role: "system", content: data }];
    } catch (error) { console.error(`[Contexto - ${nomeSetor.toUpperCase()}] Erro carregar ${caminhoCompleto}:`, error); return [{ role: "system", content: "Assistente Chevrocar." }]; }
};
const getUserHistoryFilePath = (numero, clientId) => { const sanitizedNumber = numero.replace(/[^a-zA-Z0-9]/g, '_'); const validClientId = setores[clientId] ? clientId : 'admin'; const sectorHistoryDir = path.join(historyBaseDir, validClientId); return path.join(sectorHistoryDir, `${sanitizedNumber}.json`); };
const getUserHistory = async (numero, clientId) => {
    const nomeSetor = setores[clientId]?.nome?.toUpperCase() || clientId.toUpperCase(); const filePath = getUserHistoryFilePath(numero, clientId); const sectorHistoryDir = path.dirname(filePath);
    try {
        await fsPromises.mkdir(sectorHistoryDir, { recursive: true });
        if (fs.existsSync(filePath)) { const data = await fsPromises.readFile(filePath, 'utf8'); if (data) { return JSON.parse(data); } }
        console.log(`[History - ${nomeSetor}] Arquivo não/vazio ${numero}. Criando.`); const initialContext = carregarContexto(clientId);
        // ***** ALTERAÇÃO ***** Define estado inicial para o Admin como 'aguardando_escolha'
        const initialState = clientId === 'admin' ? 'aguardando_escolha' : clientId;
        return { historico: initialContext, setorAtual: initialState };
    } catch (error) { console.error(`[History - ${nomeSetor}] Erro ler/parse ${numero} (${filePath}):`, error); const fallbackContext = carregarContexto(clientId);
        // ***** ALTERAÇÃO ***** Define estado inicial para o Admin como 'aguardando_escolha' em caso de erro
        const initialStateOnError = clientId === 'admin' ? 'aguardando_escolha' : clientId;
        return { historico: fallbackContext, setorAtual: initialStateOnError };
    }
};
const saveUserHistory = async (numero, clientId, userData) => { const nomeSetor = setores[clientId]?.nome?.toUpperCase() || clientId.toUpperCase(); if (!userData?.historico) { console.error(`[History - ${nomeSetor}] Dados inválidos ${numero}. Abort save.`); return; } const filePath = getUserHistoryFilePath(numero, clientId); const sectorHistoryDir = path.dirname(filePath); try { await fsPromises.mkdir(sectorHistoryDir, { recursive: true }); const dataToSave = JSON.stringify(userData, null, 2); await fsPromises.writeFile(filePath, dataToSave, 'utf8'); } catch (error) { console.error(`[History - ${nomeSetor}] Erro salvar ${numero} (${filePath}):`, error); } };
const deleteUserHistoryFile = async (numero, oldClientId) => { const nomeSetor = setores[oldClientId]?.nome?.toUpperCase() || oldClientId.toUpperCase(); const filePath = getUserHistoryFilePath(numero, oldClientId); try { if (fs.existsSync(filePath)) { await fsPromises.unlink(filePath); console.log(`[Hist Transf - ${nomeSetor}] Arq antigo ${filePath} removido.`); } } catch (error) { console.error(`[Hist Transf - ${nomeSetor}] Erro remover ${filePath}:`, error); } };
const enviarParaChatGPT = async (mensagem, historicoAtual, setorContextoId) => {
    const nomeSetor = setores[setorContextoId]?.nome?.toUpperCase() || setorContextoId.toUpperCase(); if (!Array.isArray(historicoAtual)) { console.error(`[ChatGPT - ${nomeSetor}] Hist inválido. Reset.`); historicoAtual = carregarContexto(setorContextoId); } historicoAtual.push({ role: "user", content: mensagem });
    const maxTrocas = 10; if (historicoAtual.length > (maxTrocas * 2) + 1) { console.log(`[ChatGPT - ${nomeSetor}] Hist > ${maxTrocas}. Removendo.`); historicoAtual = [ historicoAtual[0], ...historicoAtual.slice(-(maxTrocas * 2)) ]; }
    try {
        const response = await axios.post('https://api.openai.com/v1/chat/completions', { model: "gpt-3.5-turbo", messages: historicoAtual }, { headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 });
        const resposta = response.data.choices[0].message.content; historicoAtual.push({ role: "assistant", content: resposta }); console.log(`[ChatGPT - ${nomeSetor}] Resp recebida.`); return { chatGPTResponse: resposta, updatedHistorico: historicoAtual };
    } catch (error) { console.error(`[ChatGPT - ${nomeSetor}] Erro API OpenAI:`, error.response?.data || error.message); historicoAtual.pop(); return { chatGPTResponse: "Desculpe, houve um problema ao conectar com a inteligência artificial no momento. Por favor, tente novamente mais tarde ou digite o número de um setor.", updatedHistorico: historicoAtual }; }
};
const analisarImagem = async (caminhoImagem, numero, setorContextoId, historicoAtual) => {
    const nomeSetor = setores[setorContextoId]?.nome?.toUpperCase() || setorContextoId.toUpperCase(); console.log(`[OCR - ${nomeSetor}] Analisando ${path.basename(caminhoImagem)} p/ ${numero}`); let textoAnalise = `O usuário ${numero} enviou uma imagem.`; let ocrSuccess = false;
    try {
        if (!process.env.OCR_API_KEY) { console.warn(`[OCR - ${nomeSetor}] Chave OCR ñ config.`); textoAnalise = `Recebi uma imagem do usuário ${numero}, mas não tenho capacidade de analisá-la. Peça para ele descrever o conteúdo ou perguntar o que deseja.`; } else {
            const imageFile = await fsPromises.readFile(caminhoImagem); const base64Image = imageFile.toString('base64'); const ext = path.extname(caminhoImagem).substring(1); const form = new FormData(); form.append('base64Image', `data:image/${ext};base64,${base64Image}`); form.append('language', 'por');
            const response = await axios.post('https://api.ocr.space/parse/image', form, { headers: { ...form.getHeaders(), apikey: process.env.OCR_API_KEY }, timeout: 20000 });
            if (response.data.IsErroredOnProcessing) { console.error(`[OCR - ${nomeSetor}] Erro OCR:`, response.data.ErrorMessage.join(', ')); textoAnalise = `Houve um erro ao processar a imagem enviada por ${numero} (Detalhe: ${response.data.ErrorMessage.join(', ')}). Informe que não foi possível processar e peça para descrever.`; } else {
                const txt = response.data.ParsedResults?.[0]?.ParsedText?.trim(); if (txt) { console.log(`[OCR - ${nomeSetor}] Txt: "${txt.substring(0, 50)}..."`); textoAnalise = `Analise o seguinte texto extraído de uma imagem enviada por ${numero}: "${txt}".`; ocrSuccess = true; } else { console.log(`[OCR - ${nomeSetor}] Ñ txt.`); textoAnalise = `Recebi uma imagem de ${numero} que não contém texto reconhecível. Informe que não extraiu texto e pergunte o que ele deseja ou peça para descrever.`; }
            }
        }
    } catch (err) { console.error(`[OCR - ${nomeSetor}] Erro crít img:`, err.response?.data || err.message); textoAnalise = `Ocorreu um erro técnico inesperado ao tentar processar a imagem de ${numero}. Informe o erro e peça para descrever.`; }
    finally { try { if (fs.existsSync(caminhoImagem)) { await fsPromises.unlink(caminhoImagem); } } catch (unlinkErr) { console.error(`[OCR - ${nomeSetor}] Erro remover ${caminhoImagem}:`, unlinkErr); } }
    // ***** ALTERAÇÃO ***** Chama a IA mesmo se o OCR falhar, passando a descrição do problema
    const { chatGPTResponse, updatedHistorico } = await enviarParaChatGPT(textoAnalise, historicoAtual, setorContextoId);
    // Não precisa mais adicionar prefixos, a IA recebe o contexto do problema
    return { response: chatGPTResponse, updatedHistorico };
};
const logInteraction = async (logData, clientId) => { const nomeSetor = setores[clientId]?.nome?.toUpperCase() || clientId.toUpperCase(); const validClientId = setores[clientId] ? clientId : 'unknown'; const logPath = path.join(logDir, `log_${validClientId}.jsonl`); try { await fsPromises.mkdir(logDir, { recursive: true }); const logEntry = JSON.stringify(logData); await fsPromises.appendFile(logPath, logEntry + '\n', 'utf8'); } catch (error) { console.error(`[Logging - ${nomeSetor}] Erro log (${logPath}):`, error); } };
// --- FIM DAS FUNÇÕES AUXILIARES ---


// --- Função Principal de Inicialização do Cliente WA (Com impressão de QR) ---
const inicializarClienteWhatsApp = (clientId) => {
    const nomeSetor = setores[clientId]?.nome?.toUpperCase() || clientId.toUpperCase();
    return new Promise((resolve, reject) => {
        if (clientesWhatsApp[clientId] || ['initializing', 'restarting', 'ready', 'qr'].includes(clientStatus[clientId])) { console.log(`[Init - ${nomeSetor}] Tentativa ignorada, status atual: ${clientStatus[clientId] || 'objeto existe'}`); return reject(new Error(`Cliente ${nomeSetor} já em processo ou ativo.`)); } // Evita re-inicialização
        console.log(`\n--- [${nomeSetor}] INICIANDO (ID: ${clientId}) ---`);
        clientStatus[clientId] = 'initializing'; sendSseEvent('status_update', { clientId, nome: nomeSetor, status: 'initializing' });
        lastQrCodes[clientId] = null;

        const client = new Client({ puppeteer: puppeteerOptions, authStrategy: new LocalAuth({ clientId: clientId, dataPath: authDir }), qrTimeout: 0 });

        client.on('qr', (qr) => {
            console.log(`\n###### [${nomeSetor}] QR CODE ######`);
            console.log(`Escaneie para conectar ${nomeSetor}:`);
            qrcode.generate(qr, { small: true }); // IMPRIME QR NO TERMINAL
            console.log(`################################`);
            clientStatus[clientId] = 'qr';
            lastQrCodes[clientId] = qr;
            sendSseEvent('qr', { clientId, nome: nomeSetor, qrCode: qr });
        });

        client.on('ready', async () => { console.log(`\n✅ [${nomeSetor}] Pronto!`); clientesWhatsApp[clientId] = client; clientStatus[clientId] = 'ready'; lastQrCodes[clientId] = null; sendSseEvent('status_update', { clientId, nome: nomeSetor, status: 'ready' }); try { const info = await client.info; console.log(`   - Conectado: ${info.pushname||'N/A'}`); } catch (e) {} resolve(client); });
        client.on('authenticated', () => console.log(`[${nomeSetor}] Autenticado (sessão).`));
        client.on('auth_failure', (msg) => { console.error(`\n❌ [${nomeSetor}] FALHA AUTH:`, msg); clientStatus[clientId] = 'auth_failure'; sendSseEvent('status_update', { clientId, nome: nomeSetor, status: 'auth_failure', reason: msg }); lastQrCodes[clientId] = null; delete clientesWhatsApp[clientId]; reject(new Error(`Falha auth ${nomeSetor}: ${msg}`)); });
        client.on('disconnected', (reason) => { console.warn(`\n⚠️ [${nomeSetor}] Desconectado:`, reason); const prevStatus = clientStatus[clientId]; clientStatus[clientId] = 'disconnected'; sendSseEvent('status_update', { clientId, nome: nomeSetor, status: 'disconnected', reason: reason }); lastQrCodes[clientId] = null; delete clientesWhatsApp[clientId]; if (['initializing', 'qr'].includes(prevStatus)) { reject(new Error(`Desconectado init ${nomeSetor}: ${reason}`)); } });

        // --- Handler Principal de Mensagens (LÓGICA DO BOT COM IA NO ADMIN) ---
        client.on('message', async (message) => {
            if (message.isGroupMsg || message.from === 'status@broadcast' || message.type === 'revoked') return; // Ignora grupos, status e mensagens apagadas
            const numero = message.from;
            const nomeContato = message._data?.notifyName || (await message.getContact())?.pushname || numero.split('@')[0];
            const texto = message.body?.trim() || '';
            const timestamp = new Date().toISOString();
            const receivingClientId = clientId; // ID do bot que recebeu a mensagem ('admin', '1', '2', etc.)
            const receivingClientName = setores[receivingClientId]?.nome?.toUpperCase() || receivingClientId.toUpperCase();

            const logData = { timestamp, clientId: receivingClientId, userNumber: numero, userName: nomeContato, messageType: message.type, incomingText: texto || null, mediaProcessed: message.hasMedia, ocrTextExtracted: null, chatGPTRequestContent: null, chatGPTResponseContent: null, actionTaken: null, currentContext: null, finalContext: null, error: null };
            let currentUserData;
            let targetClientIdForHistory = receivingClientId; // Onde salvar o histórico no final (padrão)
            let responseToSend = null; // Resposta a ser enviada ao usuário

            try {
                // Carrega o estado/histórico do usuário para o cliente que recebeu a msg
                currentUserData = await getUserHistory(numero, receivingClientId);
                logData.currentContext = currentUserData.setorAtual;
                console.log(`[MSG IN - ${receivingClientName}] De: ${nomeContato} | Estado: ${currentUserData.setorAtual} | Msg: ${texto.substring(0,30)}...`);

                // ***** INÍCIO DA LÓGICA AJUSTADA PARA O ADMIN COM IA *****
                if (receivingClientId === 'admin') {
                    if (currentUserData.setorAtual === 'aguardando_escolha') {
                        const escolhaNumerica = texto;

                        // 1. VERIFICA SE É UMA ESCOLHA DE SETOR VÁLIDA
                        if (setores[escolhaNumerica] && escolhaNumerica !== 'admin') {
                            // ---> TRANSFERÊNCIA PARA SETOR <---
                            const setorEscolhidoInfo = setores[escolhaNumerica];
                            const newClientId = escolhaNumerica;
                            const newSectorName = setorEscolhidoInfo.nome;
                            const newSectorNameFormatted = newSectorName.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

                            console.log(`[Admin Flow] ${numero} escolheu ${newSectorNameFormatted} (${newClientId}). Transferindo...`);
                            logData.actionTaken = `Admin Flow: Escolheu ${newSectorName} (${newClientId}).`;

                            currentUserData.historico = carregarContexto(newClientId); // Novo histórico para o setor
                            currentUserData.setorAtual = newClientId; // Define novo setor
                            logData.finalContext = newClientId;
                            targetClientIdForHistory = newClientId; // ***** ALTERAÇÃO ***** Define onde salvar

                            await saveUserHistory(numero, newClientId, currentUserData); // Salva no dir do NOVO setor
                            await deleteUserHistoryFile(numero, 'admin'); // Remove do dir admin

                            responseToSend = `✅ Direcionando para *${newSectorNameFormatted}*. Por favor, aguarde um momento enquanto conectamos você, ou envie sua mensagem diretamente para o atendente que irá responder.`; // Mensagem de transferência

                            logData.chatGPTResponseContent = responseToSend; // Loga a mensagem de transferência
                            // Não precisa de 'return' aqui, o finally cuidará de salvar/logar e enviar

                        } else if (texto) {
                            // ---> NÃO É NÚMERO DE SETOR VÁLIDO, MAS TEM TEXTO -> USA IA DO ADMIN <---
                            console.log(`[Admin Flow] ${numero} não escolheu setor válido. Acionando IA Admin...`);
                            logData.actionTaken = 'Admin Flow: Invoked Admin AI.';
                            logData.chatGPTRequestContent = texto;

                            const { chatGPTResponse, updatedHistorico } = await enviarParaChatGPT(texto, currentUserData.historico, 'admin'); // Usa contexto 'admin'

                            currentUserData.historico = updatedHistorico; // Atualiza histórico com a resposta da IA
                            responseToSend = chatGPTResponse; // Guarda a resposta para enviar
                            logData.chatGPTResponseContent = responseToSend;

                            // MANTÉM o estado 'aguardando_escolha' para permitir escolha futura
                            currentUserData.setorAtual = 'aguardando_escolha';
                            logData.finalContext = 'aguardando_escolha';
                            targetClientIdForHistory = 'admin'; // ***** ALTERAÇÃO ***** Garante salvar no Admin
                             // Não precisa de 'return', o finally cuidará de salvar/logar e enviar

                        } else if (message.hasMedia && message.type === 'image') {
                             // ---> RECEBEU IMAGEM ENQUANTO AGUARDAVA ESCOLHA -> PROCESSA COM IA ADMIN <---
                             console.log(`[Admin Flow] ${numero} enviou imagem enquanto aguardava escolha. Processando com IA Admin...`);
                             logData.actionTaken = 'Admin Flow: Processing image with Admin AI.';
                             logData.mediaProcessed = true;
                             try {
                                const media = await message.downloadMedia();
                                if (media?.mimetype && media.data) {
                                    await fsPromises.mkdir(imagesDir, { recursive: true }); const ext = media.mimetype.split('/')[1] || 'png'; const nomeArq = path.join(imagesDir, `img_${receivingClientId}_${numero.split('@')[0]}_${Date.now()}.${ext}`);
                                    await fsPromises.writeFile(nomeArq, media.data, 'base64');
                                    const { response, updatedHistorico } = await analisarImagem(nomeArq, numero, 'admin', currentUserData.historico); // Usa contexto 'admin'
                                    currentUserData.historico = updatedHistorico;
                                    responseToSend = response;
                                    logData.ocrTextExtracted = "[Img proc]";
                                    logData.chatGPTResponseContent = responseToSend;
                                } else { throw new Error("Falha ao baixar mídia."); }
                             } catch(imgError) {
                                 console.error(`[Admin Flow - Media] Erro proc img ${numero}:`, imgError);
                                 responseToSend = "Erro técnico ao processar a imagem. Por favor, descreva o que você precisa ou digite o número do setor.";
                                 logData.error = `Erro proc img: ${imgError.message}`;
                                 logData.chatGPTResponseContent = responseToSend;
                             }
                             // MANTÉM o estado 'aguardando_escolha'
                             currentUserData.setorAtual = 'aguardando_escolha';
                             logData.finalContext = 'aguardando_escolha';
                             targetClientIdForHistory = 'admin'; // Garante salvar no Admin

                        } else {
                            // ---> Mensagem vazia ou mídia não suportada enquanto aguarda escolha <---
                            console.log(`[Admin Flow] ${numero} enviou msg ${message.type} vazia/inválida enquanto aguardava escolha. Reenviando menu.`);
                            logData.actionTaken = `Admin Flow: Ignored ${message.type}, resent menu.`;
                            // ***** ALTERAÇÃO ***** Reenvia o menu se a entrada for inválida
                            const menuTexto = "Por favor, digite o número do setor desejado ou faça sua pergunta:\n\n" +
                                              "1. Peças\n" +
                                              "2. Recepção\n" +
                                              "3. Financeiro\n" +
                                              "4. Pneus\n" +
                                              "5. Troca de Óleo\n" +
                                              "6. Oficina";
                            responseToSend = menuTexto;
                            logData.chatGPTResponseContent = responseToSend; // Loga o menu reenviado
                            // MANTÉM o estado 'aguardando_escolha'
                            currentUserData.setorAtual = 'aguardando_escolha';
                            logData.finalContext = 'aguardando_escolha';
                            targetClientIdForHistory = 'admin'; // Garante salvar no Admin
                        }
                         // Fim da lógica 'aguardando_escolha'
                    } else if (currentUserData.setorAtual !== 'admin') {
                        // ---> LÓGICA DE RESET (Usuário deveria estar em outro setor) <---
                        const previousSectorId = currentUserData.setorAtual;
                        const previousSectorName = setores[previousSectorId]?.nome || previousSectorId;
                        console.warn(`[Admin Flow] ${receivingClientName} recebeu msg ${numero} (estado ${previousSectorName}). Resetando p/ admin.`);
                        logData.actionTaken = `Admin Flow: Resetou user de ${previousSectorName}.`;

                        currentUserData.setorAtual = 'admin'; // Volta para o admin
                        currentUserData.historico = carregarContexto('admin'); // Reseta histórico para o do admin
                        logData.finalContext = 'admin';
                        targetClientIdForHistory = 'admin'; // Garante salvar no admin

                        // Salva o estado resetado IMEDIATAMENTE
                        await saveUserHistory(numero, 'admin', currentUserData);
                        // Loga o reset IMEDIATAMENTE
                        await logInteraction({ ...logData }, receivingClientId); // Usa cópia para não alterar logData principal

                        // Envia mensagem de reset e processa a mensagem atual com a IA do Admin
                        await message.reply(`⚠️ Houve uma interrupção no atendimento anterior (${previousSectorName}). Sua conversa foi redirecionada para o atendimento geral. Processando sua última mensagem...`);

                        // Agora, processa a MENSAGEM ATUAL (texto ou imagem) com a IA do Admin
                        logData.actionTaken += ' | Processing current message with Admin AI after reset.'; // Adiciona info ao log
                        if (message.hasMedia && message.type === 'image') {
                             // Repete lógica de processamento de imagem com contexto 'admin'
                            try {
                                const media = await message.downloadMedia(); if (media?.mimetype && media.data) { /* ... */ await fsPromises.mkdir(imagesDir, { recursive: true }); const ext = media.mimetype.split('/')[1] || 'png'; const nomeArq = path.join(imagesDir, `img_${receivingClientId}_${numero.split('@')[0]}_${Date.now()}.${ext}`); await fsPromises.writeFile(nomeArq, media.data, 'base64'); const { response, updatedHistorico } = await analisarImagem(nomeArq, numero, 'admin', currentUserData.historico); currentUserData.historico = updatedHistorico; responseToSend = response; /* ... logs ... */ } else { throw new Error("Falha download."); }
                            } catch(imgErr) { /* ... erro ... */ responseToSend = "Erro proc. img pós-reset."; }
                        } else if (texto) {
                            // Repete lógica de processamento de texto com contexto 'admin'
                            const { chatGPTResponse, updatedHistorico } = await enviarParaChatGPT(texto, currentUserData.historico, 'admin'); currentUserData.historico = updatedHistorico; responseToSend = chatGPTResponse;
                        } else {
                            responseToSend = "Sua última mensagem estava vazia ou não pôde ser processada após o redirecionamento. Como posso ajudar agora?";
                        }
                        // O finally cuidará de enviar 'responseToSend' e salvar o estado 'admin' atualizado

                    } else {
                        // ---> Já estava falando com o Admin (setorAtual === 'admin') <---
                        // Deixa cair para o processamento comum abaixo, que usará o contexto 'admin' corretamente.
                        console.log(`[Admin Flow] Continuando conversa com ${numero} no contexto Admin.`);
                        logData.actionTaken = 'Admin Flow: Continuing conversation with Admin AI.';
                        // O processamento comum cuidará de chamar a IA e atualizar o histórico
                    }
                    // Fim da lógica específica do Admin
                }

                // --- PROCESSAMENTO COMUM (PARA SETORES ou ADMIN após lógica acima resolvida) ---
                // Só executa se 'responseToSend' ainda for null (ou seja, Admin não transferiu, não respondeu IA, não reenviou menu, nem resetou e processou)
                if (responseToSend === null) {
                    let contextForIA = currentUserData.setorAtual;
                    // Fallback: se por algum motivo chegou aqui como 'aguardando_escolha', usa 'admin'
                    if (contextForIA === 'aguardando_escolha') {
                        console.warn(`[WARN] Usuário ${numero} chegou ao processamento comum como 'aguardando_escolha'. Usando contexto 'admin'.`);
                        contextForIA = 'admin';
                        currentUserData.setorAtual = 'admin'; // Corrige o estado
                        logData.finalContext = 'admin';
                        targetClientIdForHistory = 'admin';
                    }

                    const contextForIAName = setores[contextForIA]?.nome?.toUpperCase() || contextForIA.toUpperCase();
                    logData.currentContext = contextForIA; // Loga o contexto que será usado

                    if (message.hasMedia && message.type === 'image') {
                        logData.mediaProcessed = true; console.log(`[Media - ${contextForIAName}] Baixando img ${numero}...`);
                        try {
                            const media = await message.downloadMedia(); if (media?.mimetype && media.data) {
                                await fsPromises.mkdir(imagesDir, { recursive: true }); const ext = media.mimetype.split('/')[1] || 'png'; const nomeArq = path.join(imagesDir, `img_${contextForIA}_${numero.split('@')[0]}_${Date.now()}.${ext}`); // Usa contexto no nome
                                await fsPromises.writeFile(nomeArq, media.data, 'base64');
                                const { response, updatedHistorico } = await analisarImagem(nomeArq, numero, contextForIA, currentUserData.historico); // Passa o contexto correto
                                currentUserData.historico = updatedHistorico; responseToSend = response; logData.ocrTextExtracted = "[Img proc]"; logData.actionTaken = `Proc Img (${contextForIAName})`;
                            } else { throw new Error("Falha ao baixar mídia."); }
                        } catch (error) { console.error(`[Media - ${contextForIAName}] Erro proc img ${numero}:`, error); responseToSend = "Erro técnico ao processar a imagem. Por favor, descreva o que você precisa."; logData.error = `Erro proc img: ${error.message}`; logData.actionTaken = `Error Proc Img (${contextForIAName})`; }
                    } else if (message.hasMedia) {
                        console.log(`[Media - ${contextForIAName}] Mídia '${message.type}' ignorada ${numero}.`); logData.actionTaken = `Ignored media: ${message.type}`;
                         // Poderia enviar uma mensagem padrão informando que não processa esse tipo de mídia
                         // responseToSend = `Desculpe, não consigo processar mídias do tipo '${message.type}'. Por favor, envie texto ou imagem.`;
                    } else if (texto) {
                        logData.chatGPTRequestContent = texto;
                        const { chatGPTResponse, updatedHistorico } = await enviarParaChatGPT(texto, currentUserData.historico, contextForIA); // Passa o contexto correto
                        currentUserData.historico = updatedHistorico; responseToSend = chatGPTResponse; logData.chatGPTResponseContent = responseToSend; logData.actionTaken = `Sent ChatGPT Reply (${contextForIAName})`;
                    } else {
                        console.log(`[MSG IN - ${contextForIAName}] Msg vazia ignorada ${numero}.`); logData.actionTaken = 'Ignored empty';
                        // Poderia enviar uma mensagem como "Não entendi, pode repetir?"
                        // responseToSend = "Não recebi sua mensagem. Poderia tentar novamente?";
                    }
                } // Fim do if (responseToSend === null)

            } catch (error) {
                console.error(`\n🚨 [Handler - ${receivingClientName}] Erro CRÍTICO ${numero}:`, error);
                logData.error = `Crit Hand Err: ${error.message || error}`; logData.actionTaken = 'Crit Err'; logData.finalContext = 'error_state'; // Marca estado de erro
                try {
                    // Tenta enviar uma mensagem de erro genérica, mas só se nenhuma outra resposta foi definida
                    if (responseToSend === null) {
                         responseToSend = "Desculpe, ocorreu um erro interno inesperado. Por favor, tente novamente mais tarde.";
                         logData.chatGPTResponseContent = responseToSend; // Loga msg de erro
                    }
                } catch (replyError) {
                    console.error(`[Handler - ${receivingClientName}] Falha CRÍTICA enviar msg erro ${numero}:`, replyError);
                }
            } finally {
                // Envia a resposta final (seja da IA, transferência, menu, ou erro)
                if (responseToSend && client) { // Verifica se client ainda existe
                     try {
                         await client.sendMessage(numero, responseToSend.trim());
                     } catch (sendError) {
                         console.error(`[Handler - ${receivingClientName}] Erro ao ENVIAR msg para ${numero}:`, sendError);
                         logData.error = (logData.error ? logData.error + ' | ' : '') + `Send Error: ${sendError.message}`;
                     }
                }

                // Salva o estado final do usuário no diretório CORRETO
                if (currentUserData) {
                    await saveUserHistory(numero, targetClientIdForHistory, currentUserData);
                }
                // Loga a interação completa
                await logInteraction(logData, receivingClientId);
            }
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
    const todosSetoresIds = Object.keys(setores); const initializationPromises = []; const delayEntreDisparosMs = 500; // Reduzido, ajuste se necessário
    console.log(`Disparando inicializações com ${delayEntreDisparosMs}ms de atraso...`);
    for (const setorId of todosSetoresIds) {
        const nomeSetor = setores[setorId].nome.toUpperCase(); if (!clientStatus[setorId]) { clientStatus[setorId] = 'offline'; sendSseEvent('status_update', { clientId: setorId, nome: nomeSetor, status: 'offline'}); }
        // Tenta iniciar APENAS se estiver offline, desconectado, com erro ou falha de auth
        if (['offline', 'disconnected', 'error', 'auth_failure'].includes(clientStatus[setorId])) {
             console.log(`   -> [${nomeSetor}] Tentando iniciar...`);
             // Usa uma função anônima para capturar o erro da Promise de inicialização
            const startClient = async (id, name) => {
                try {
                    await inicializarClienteWhatsApp(id);
                    return { status: 'fulfilled', clientId: id, nomeSetor: name }; // Retorna sucesso
                } catch (error) {
                     // Não precisa logar o erro aqui, pois 'inicializarClienteWhatsApp' já loga
                    return { status: 'rejected', clientId: id, nomeSetor: name, reason: error.message }; // Retorna falha
                }
            };
            initializationPromises.push(startClient(setorId, nomeSetor)); // Adiciona a PROMISE da função anônima
            if (delayEntreDisparosMs > 0 && todosSetoresIds.indexOf(setorId) < todosSetoresIds.length - 1) { await new Promise(resolve => setTimeout(resolve, delayEntreDisparosMs)); }
        } else { console.log(`   -> [${nomeSetor}] (ID: ${setorId}) já '${clientStatus[setorId]}'. Pulando.`); sendSseEvent('status_update', { clientId: setorId, nome: nomeSetor, status: clientStatus[setorId] }); if(clientStatus[setorId] === 'qr' && lastQrCodes[setorId]) { sendSseEvent('qr', { clientId: setorId, nome: nomeSetor, qrCode: lastQrCodes[setorId] });} }
    }
    if (initializationPromises.length === 0) { console.log("\nNenhum cliente precisou iniciar."); return; }
    console.log(`\n--- Aguardando conclusão das ${initializationPromises.length} tentativas de inicialização... ---`);
    const results = await Promise.all(initializationPromises); // Espera todas as funções anônimas terminarem
    console.log("\n--- Resultados Finais das Tentativas ---");
    results.forEach((result) => {
        const nomeSetor = result.nomeSetor;
        if (result.status === 'fulfilled') {
            console.log(`✅ [${nomeSetor}] Status pós-tentativa: ${clientStatus[result.clientId] || 'Desconhecido (OK?)'}.`); // Verifica o status real
        } else {
            console.error(`❌ [${nomeSetor}] FALHA INICIALIZAÇÃO. Razão: ${result.reason}`);
        }
    });
    console.log("\n========================================"); console.log("🏁 FIM TENTATIVAS INICIALIZAÇÃO!"); console.log("   API/SSE prontos."); console.log("========================================");
    if (results.some(r => r.status === 'rejected' && r.reason?.includes('Execution context'))) { console.warn("\n⚠️ ATENÇÃO: Erros 'Execution context'. Considere aumentar delay ou usar modo sequencial."); }
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
    // Envia status atual de todos ao conectar
    Object.keys(setores).forEach(id => { const st = clientStatus[id] || 'offline'; const nm = setores[id]?.nome || id; sendSseEvent('status_update', { clientId: id, nome: nm, status: st }); if (st === 'qr' && lastQrCodes[id]) { sendSseEvent('qr', { clientId: id, nome: nm, qrCode: lastQrCodes[id] }); } });
    req.on('close', () => { console.log('[SSE Disconnect] Cliente desconectado.'); sseClients = sseClients.filter(c => c !== res); res.end(); });
    // Envia keep-alive para evitar timeout
    const keepAlive = setInterval(() => { try { if (!res.writableEnded) { res.write(':ka\n\n'); } else { clearInterval(keepAlive); } } catch (e) { console.warn('[SSE KeepAlive] Erro ao enviar keep-alive:', e.message); clearInterval(keepAlive); sseClients = sseClients.filter(c => c !== res); } }, 20000); req.on('close', () => clearInterval(keepAlive));
});

// --- Rotas API REST (MANTENHA AS QUE VOCÊ USA) ---
app.get('/api/clients', (req, res) => { const clientList = Object.keys(setores).map(id => ({ id, nome: setores[id]?.nome || id, status: clientStatus[id] || 'offline' })); res.json(clientList); });
// Exemplo de rota para enviar mensagem (PRECISA IMPLEMENTAR A LÓGICA)
app.post('/api/clients/:clientId/send/text', async (req, res) => {
    const { clientId } = req.params;
    const { number, message } = req.body; // Espera número (ex: 55119...) e mensagem no corpo

    if (!number || !message) { return res.status(400).json({ error: 'Parâmetros "number" e "message" são obrigatórios.' }); }
    if (!clientesWhatsApp[clientId]) { return res.status(404).json({ error: `Cliente ${clientId} não encontrado ou não está pronto.` }); }
    if (clientStatus[clientId] !== 'ready') { return res.status(409).json({ error: `Cliente ${clientId} não está pronto (Status: ${clientStatus[clientId]}).` }); }

    try {
        const chatId = number.includes('@c.us') ? number : `${number}@c.us`; // Formata o número se necessário
        const sentMessage = await clientesWhatsApp[clientId].sendMessage(chatId, message);
        console.log(`[API Send] Mensagem enviada via API para ${chatId} pelo cliente ${clientId}`);
        // Loga a mensagem enviada pela API
         await logInteraction({
            timestamp: new Date().toISOString(), clientId: clientId, userNumber: chatId, userName: 'API', messageType: 'text', incomingText: null, outgoingText: message, // Adiciona outgoingText
             actionTaken: 'API Send Message', currentContext: 'api', finalContext: 'api', error: null
         }, clientId);
        res.status(200).json({ success: true, messageId: sentMessage.id._serialized });
    } catch (error) {
        console.error(`[API Send] Erro ao enviar mensagem para ${number} via ${clientId}:`, error);
        res.status(500).json({ error: 'Erro ao enviar mensagem.', details: error.message });
    }
});

// --- Middlewares de Erro ---
app.use((req, res, next) => { res.status(404).json({ error: 'Not Found', path: req.originalUrl }); });
app.use((err, req, res, next) => { console.error("[API Error Handler]:", err); res.status(err.status || 500).json({ error: err.message || 'Internal Server Error', details: err.stack }); });


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
process.on('unhandledRejection', (reason, promise) => { console.error('\n!!! PROMISE REJEITADA NÃO TRATADA !!!'); /* console.error('Promise:', promise); */ console.error('Razão:', reason); /* Considerar encerrar aqui, mas pode ser ruidoso */ });

// --- Inicia ---
startApp();
