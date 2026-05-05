const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

const baseDir = process.env.VERCEL ? '/tmp' : process.cwd();
const RECORDINGS_DIR = path.join(baseDir, 'recordings');
const REPORTS_DIR = path.join(baseDir, 'reports');

function ensureStorageDirs() {
  fs.mkdirSync(path.join(baseDir, 'recordings'), { recursive: true });
  fs.mkdirSync(path.join(baseDir, 'reports'), { recursive: true });
}

const DEFAULT_PROMPT = `Você é um especialista em pedagogia da dança, gestão de professores e análise de comportamento em sala de aula. Analise a aula inteira considerando o Perfil Professor DK.

Perfil Professor DK:
- conduz a aula com energia e presença
- explica com clareza e objetividade
- coloca os alunos em prática rapidamente
- corrige individualmente e coletivamente
- mantém a turma engajada
- usa bem o espaço da sala
- demonstra domínio técnico
- cria ambiente seguro, motivador e exigente
- equilibra técnica, disciplina, diversão e evolução

Gere um relatório direto, prático e útil para desenvolvimento do professor.

Formato do relatório:
- Resumo geral
- Pontos fortes
- Pontos de melhoria
- Energia e presença
- Clareza da condução
- Interação com alunos
- Explicação vs prática
- Correções realizadas
- Alinhamento com o Perfil Professor DK
- Nota geral de 0 a 10
- Recomendações práticas para próxima aula`;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/reports', express.static(REPORTS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const MIN_FILE_SIZE_BYTES = 1 * 1024 * 1024;

function getFileMimeType(filePath) {
  const mimeByExt = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo'
  };
  const ext = path.extname(filePath).toLowerCase();
  return mimeByExt[ext] || 'application/octet-stream';
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGeminiFileActive(fileName) {
  const maxAttempts = 30;

  for (let attempts = 0; attempts < maxAttempts; attempts += 1) {
    const fileInfoResp = await fetch(`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${process.env.GEMINI_API_KEY}`);
    const fileInfoData = await fileInfoResp.json();

    if (!fileInfoResp.ok) {
      const error = new Error(fileInfoData?.error?.message || 'Falha ao consultar status do arquivo na Gemini Files API.');
      error.statusCode = 500;
      throw error;
    }

    const state = fileInfoData?.state;
    if (state === 'ACTIVE') {
      return fileInfoData;
    }

    if (state === 'FAILED') {
      const error = new Error('Falha ao processar vídeo na Gemini Files API');
      error.statusCode = 500;
      throw error;
    }

    if (state === 'PROCESSING') {
      await sleep(2000);
      continue;
    }

    await sleep(2000);
  }

  const timeoutError = new Error('Vídeo ainda está processando na Gemini Files API. Tente novamente em alguns segundos.');
  timeoutError.statusCode = 408;
  throw timeoutError;
}

async function uploadToGeminiFiles(filePath) {
  const mimeType = getFileMimeType(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  const uploadEndpoint = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${process.env.GEMINI_API_KEY}`;
  const uploadResponse = await fetch(uploadEndpoint, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': path.basename(filePath),
      'Content-Type': mimeType
    },
    body: fileBuffer
  });

  const uploadPayload = await uploadResponse.json();
  if (!uploadResponse.ok) {
    const error = new Error(uploadPayload?.error?.message || 'Falha ao enviar arquivo para Gemini Files API.');
    error.statusCode = 500;
    throw error;
  }

  const fileName = uploadPayload?.file?.name;
  const fileUri = uploadPayload?.file?.uri;
  if (!fileUri || !fileName) {
    const error = new Error('Gemini Files API não retornou name/uri do arquivo.');
    error.statusCode = 500;
    throw error;
  }

  const activeFile = await waitForGeminiFileActive(fileName);
  return { fileUri: activeFile.uri || fileUri, mimeType };
}

async function analyzeVideo(filePath, metadata, customPrompt) {
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error('GEMINI_API_KEY não configurada. Análise real não executada.');
    error.statusCode = 500;
    throw error;
  }

  const { fileUri, mimeType } = await uploadToGeminiFiles(filePath);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const geminiResponse = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: `${customPrompt}\n\nMetadata da aula: ${JSON.stringify(metadata)}` },
            { fileData: { mimeType, fileUri } }
          ]
        }
      ]
    })
  });

  const payload = await geminiResponse.json();
  if (!geminiResponse.ok) {
    const error = new Error(payload?.error?.message || 'Falha na Gemini API.');
    error.statusCode = 500;
    throw error;
  }

  const answer = payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('\n').trim();
  if (!answer) {
    const error = new Error('Resposta vazia da Gemini API.');
    error.statusCode = 500;
    throw error;
  }

  return {
    provider: 'gemini',
    rawResponse: answer,
    promptUsado: customPrompt,
    metadata,
    filePath,
    analyzedAt: new Date().toISOString()
  };
}

function getFileInspection(filePath) {
  const fileExists = !!filePath && fs.existsSync(filePath);
  const fileSizeBytes = fileExists ? fs.statSync(filePath).size : 0;
  const fileSizeMB = Number((fileSizeBytes / (1024 * 1024)).toFixed(2));
  return { fileExists, fileSizeBytes, fileSizeMB };
}

function extractDriveFileId(driveUrl) {
  if (!driveUrl || typeof driveUrl !== 'string') return null;

  try {
    const url = new URL(driveUrl);
    const idFromQuery = url.searchParams.get('id');
    if (idFromQuery) return idFromQuery;
  } catch (_error) {
    // fallback para regex
  }

  const patterns = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/uc\?export=download&id=([a-zA-Z0-9_-]+)/,
    /\bid=([a-zA-Z0-9_-]+)/
  ];

  for (const pattern of patterns) {
    const match = driveUrl.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}


function parseSetCookie(headers) {
  const rawCookies = headers.get('set-cookie') || '';
  return rawCookies
    .split(/,(?=\s*[^;]+=[^;]+)/)
    .map((cookie) => cookie.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function extractConfirmTokenFromHtml(html) {
  const patterns = [
    /confirm=([0-9A-Za-z_\-]+)/,
    /name="confirm"\s+value="([0-9A-Za-z_\-]+)"/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function isVideoContentType(contentType) {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('video/');
}

async function downloadDriveFile(driveUrl) {
  const fileId = extractDriveFileId(driveUrl);
  if (!fileId) {
    const error = new Error('Link do Google Drive inválido. Não foi possível extrair o fileId.');
    error.statusCode = 400;
    throw error;
  }

  const baseDownloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const tmpPath = path.join('/tmp', `drive_video_${Date.now()}_${fileId}.mp4`);

  const firstResponse = await fetch(baseDownloadUrl, { redirect: 'follow' });
  if (!firstResponse.ok) {
    const error = new Error('Falha ao baixar arquivo do Google Drive. Verifique permissões do link.');
    error.statusCode = 400;
    throw error;
  }

  const firstContentType = firstResponse.headers.get('content-type') || '';

  let downloadResponse = firstResponse;
  if (firstContentType.toLowerCase().includes('text/html')) {
    const html = await firstResponse.text();
    const confirmToken = extractConfirmTokenFromHtml(html);
    const cookieHeader = parseSetCookie(firstResponse.headers);

    if (!confirmToken) {
      const error = new Error('Google Drive retornou página de confirmação. Use um arquivo menor ou configure download autenticado.');
      error.statusCode = 400;
      throw error;
    }

    const confirmUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=${confirmToken}`;
    downloadResponse = await fetch(confirmUrl, {
      redirect: 'follow',
      headers: cookieHeader ? { Cookie: cookieHeader } : {}
    });

    if (!downloadResponse.ok) {
      const error = new Error('Google Drive retornou página de confirmação. Use um arquivo menor ou configure download autenticado.');
      error.statusCode = 400;
      throw error;
    }
  }

  const finalContentType = downloadResponse.headers.get('content-type') || '';
  if (!isVideoContentType(finalContentType)) {
    const error = new Error('Google Drive retornou página de confirmação. Use um arquivo menor ou configure download autenticado.');
    error.statusCode = 400;
    throw error;
  }

  const arrayBuffer = await downloadResponse.arrayBuffer();
  fs.writeFileSync(tmpPath, Buffer.from(arrayBuffer));
  return tmpPath;
}

app.get('/api/default-prompt', (_req, res) => {
  res.json({ defaultPrompt: DEFAULT_PROMPT });
});


app.post('/api/analyze/drive', async (req, res) => {
  let fileInfo = { fileExists: false, fileSizeBytes: 0, fileSizeMB: 0 };
  let tempFilePath = null;

  try {
    const { driveUrl, professor = '', turma = '', sala = '', prompt } = req.body;
    const customPrompt = prompt || DEFAULT_PROMPT;

    if (!driveUrl) {
      return res.status(400).json({ error: 'driveUrl é obrigatório.' });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'GEMINI_API_KEY não configurada. Análise real não executada.' });
    }

    tempFilePath = await downloadDriveFile(driveUrl);
    fileInfo = getFileInspection(tempFilePath);

    if (!fileInfo.fileExists || fileInfo.fileSizeBytes <= MIN_FILE_SIZE_BYTES) {
      return res.status(400).json({
        error: 'Arquivo de vídeo inválido. O arquivo deve existir e ter tamanho maior que 1MB.',
        fileExists: fileInfo.fileExists,
        fileSizeMB: fileInfo.fileSizeMB,
        usedRealAI: false,
        provider: 'gemini'
      });
    }

    const metadata = { professor, turma, sala, driveUrl };
    const report = await analyzeVideo(tempFilePath, metadata, customPrompt);

    return res.json({
      fileSizeMB: fileInfo.fileSizeMB,
      usedRealAI: true,
      provider: 'gemini',
      report
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      error: error.message || 'Erro ao analisar vídeo do Drive.',
      fileSizeMB: fileInfo.fileSizeMB,
      usedRealAI: false,
      provider: 'gemini'
    });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
});

app.post('/api/analyze/recorded', async (req, res) => {
  return res.status(400).json({
    error: 'Gravação RTSP não é suportada de forma confiável na Vercel. Use esta função apenas em backend local/Railway/Render.',
    fileExists: false,
    fileSizeMB: 0,
    usedRealAI: false,
    provider: 'gemini'
  });
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
