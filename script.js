document.addEventListener('DOMContentLoaded', () => {
    const apiUrl = 'http://localhost:3001/api'; // URL base da API
    const sseUrl = `${apiUrl}/events`; // URL do endpoint SSE
    const qrContainer = document.getElementById('qr-container');
    const statusMessage = document.getElementById('status-message');
    const lastUpdateElement = document.getElementById('last-update');

    // Objeto para armazenar o estado atual dos QR codes exibidos
    // Chave: clientId, Valor: { qrCodeString: string, element: HTMLElement, qrInstance: QRCode, nome: string }
    let displayedQrCodes = {};

    // Função para criar ou atualizar o card de um cliente
    function displayOrUpdateQrCard(clientId, nomeSetor, qrCodeString) {
        let qrItemElement = document.getElementById(`qr-item-${clientId}`);
        let qrDisplayElement;

        if (qrItemElement) {
            // Card já existe
             const existingData = displayedQrCodes[clientId];
             if (existingData && existingData.qrCodeString === qrCodeString) {
                 return; // Não faz nada se o QR é o mesmo
             }
             console.log(`Atualizando QR para ${nomeSetor} (${clientId})...`);
             qrDisplayElement = qrItemElement.querySelector('.qr-code-display');
             if (qrDisplayElement) qrDisplayElement.innerHTML = ''; // Limpa QR antigo
             else { console.error(`Div .qr-code-display não encontrado para ${nomeSetor}`); return; } // Sai se não encontrar onde desenhar
        } else {
            // Card não existe, cria
            console.log(`Criando card QR para ${nomeSetor} (${clientId})...`);
            qrItemElement = createQrCodeElementStructure(clientId, nomeSetor);
            qrContainer.appendChild(qrItemElement);
            qrDisplayElement = qrItemElement.querySelector('.qr-code-display');
             if (!qrDisplayElement) { console.error(`Div .qr-code-display não encontrado ao criar ${nomeSetor}`); return; } // Sai se não encontrar onde desenhar
        }

         // Gera o novo QRCode
         let qrInstance = null;
         try {
             qrInstance = new QRCode(qrDisplayElement, {
                 text: qrCodeString, width: 180, height: 180, colorDark: "#000000", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M
             });
         } catch(e) { console.error(`Erro gerar QR para ${nomeSetor}:`, e); qrDisplayElement.textContent = 'Erro QR';}

         // Armazena no estado interno
         displayedQrCodes[clientId] = {
             qrCodeString: qrCodeString,
             element: qrItemElement,
             qrInstance: qrInstance,
             nome: nomeSetor
         };

         // Garante que a mensagem de status geral esteja limpa
         statusMessage.textContent = '';
         statusMessage.classList.remove('error');
    }

    // Função para remover o card de um cliente
    function removeQrCard(clientId) {
        if (displayedQrCodes[clientId]) {
            const nomeSetor = displayedQrCodes[clientId].nome || clientId;
            console.log(`Removendo card QR para ${nomeSetor}...`);
            if(displayedQrCodes[clientId].element) {
                displayedQrCodes[clientId].element.remove();
            }
            delete displayedQrCodes[clientId]; // Remove do estado interno

             // Se não houver mais QRs, mostra mensagem
             if (Object.keys(displayedQrCodes).length === 0) {
                statusMessage.textContent = 'Nenhum QR Code para exibir no momento.';
                statusMessage.classList.remove('error'); // Garante que não fique msg de erro antiga
             }
        }
    }

    // Função auxiliar para criar a ESTRUTURA HTML de um QR Code
    function createQrCodeElementStructure(clientId, nomeSetor) {
        const itemDiv = document.createElement('div');
        itemDiv.classList.add('qr-item');
        itemDiv.id = `qr-item-${clientId}`;

        const title = document.createElement('h2');
        title.textContent = `Setor: ${nomeSetor.toUpperCase()} (${clientId})`;

        const qrCodeDisplayDiv = document.createElement('div');
        qrCodeDisplayDiv.classList.add('qr-code-display');

        const infoText = document.createElement('p');
        infoText.textContent = 'Escaneie com o WhatsApp para conectar.';

        itemDiv.appendChild(title);
        itemDiv.appendChild(qrCodeDisplayDiv);
        itemDiv.appendChild(infoText);

        return itemDiv;
    }

    // --- Conexão SSE ---
    function connectSSE() {
        console.log('Conectando ao SSE em', sseUrl);
        statusMessage.textContent = 'Conectando ao servidor de eventos...';
        statusMessage.classList.remove('error');
        const eventSource = new EventSource(sseUrl);

        // Listener para eventos de QR Code
        eventSource.addEventListener('qr', (event) => {
            try {
                const data = JSON.parse(event.data);
                // console.log('[SSE QR Received]', data);
                if (data.clientId && data.qrCode) {
                    displayOrUpdateQrCard(data.clientId, data.nome || data.clientId, data.qrCode);
                    lastUpdateElement.textContent = `QR ${data.nome || data.clientId} recebido: ${new Date().toLocaleTimeString()}`;
                }
            } catch (e) { console.error("Erro ao processar evento 'qr' SSE:", e, event.data); }
        });

        // Listener para eventos de atualização de status
        eventSource.addEventListener('status_update', (event) => {
             try {
                const data = JSON.parse(event.data);
                // console.log('[SSE Status Received]', data);
                 if (data.clientId && data.status) {
                     // Se o novo status NÃO é 'qr', remove o card correspondente (se existir)
                     if (data.status !== 'qr') {
                         removeQrCard(data.clientId);
                     }
                     // Atualiza mensagem geral se não houver mais QRs
                     if (Object.keys(displayedQrCodes).length === 0 && data.status !== 'qr') {
                        if(data.status === 'ready') {
                            statusMessage.textContent = `Setor ${data.nome || data.clientId} conectou!`;
                        } else if (data.status === 'disconnected') {
                            statusMessage.textContent = `Setor ${data.nome || data.clientId} desconectou.`;
                        } else {
                             statusMessage.textContent = 'Nenhum QR Code para exibir no momento.';
                        }
                        statusMessage.classList.remove('error');
                     }
                     lastUpdateElement.textContent = `Status ${data.nome || data.clientId}: ${data.status} - ${new Date().toLocaleTimeString()}`;
                 }
             } catch (e) { console.error("Erro ao processar evento 'status_update' SSE:", e, event.data); }
        });

        // Tratamento de erro na conexão SSE
        eventSource.onerror = (error) => {
            console.error("Erro na conexão SSE:", error);
            statusMessage.textContent = 'Erro na conexão com o servidor de eventos. Verifique se o backend está rodando e tente recarregar a página.';
            statusMessage.classList.add('error');
            lastUpdateElement.textContent = `Falha na conexão: ${new Date().toLocaleTimeString()}`;
            eventSource.close(); // Fecha a conexão com erro
             // Limpa QRs exibidos pois a conexão caiu
             Object.keys(displayedQrCodes).forEach(clientId => {
                if (displayedQrCodes[clientId]?.element) displayedQrCodes[clientId].element.remove();
                delete displayedQrCodes[clientId];
             });
            // Não tenta reconectar automaticamente para evitar loops em caso de erro persistente.
            // O usuário precisará recarregar a página.
        };

         eventSource.onopen = () => {
             console.log("Conexão SSE aberta.");
             statusMessage.textContent = 'Conectado ao servidor de eventos.';
             statusMessage.classList.remove('error');
             lastUpdateElement.textContent = `Conectado: ${new Date().toLocaleTimeString()}`;
         };
    }

    // --- Inicialização ---
    connectSSE(); // Inicia a conexão SSE

});
