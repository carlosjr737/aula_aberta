const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

const baseDir = process.env.VERCEL ? '/tmp' : process.cwd();
const UPLOADS_DIR = path.join(baseDir, 'uploads');
const RECORDINGS_DIR = path.join(baseDir, 'recordings');
const REPORTS_DIR = path.join(baseDir, 'reports');

function ensureStorageDirs() {
  fs.mkdirSync(path.join(baseDir, 'uploads'), { recursive: true });
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
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/reports', express.static(REPORTS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

const allowedExtensions = new Set(['.mp4', '.mov', '.avi']);
const MIN_FILE_SIZE_BYTES = 1 * 1024 * 1024;

const storage = multer.diskStorage({
  destination: (_, __, cb) => {
    try {
      ensureStorageDirs();
      cb(null, UPLOADS_DIR);
    } catch (error) {
      cb(error);
    }
  },
  filename: (_, file, cb) => {
    const safeName = file.originalname.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '');
    cb(null, `${Date.now()}_${safeName}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.has(ext)) {
      return cb(new Error('Formato inválido. Envie MP4, MOV ou AVI.'));
    }
    cb(null, true);
  }
});

function getFileMimeType(filePath) {
  const mimeByExt = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo'
  };
  const ext = path.extname(filePath).toLowerCase();
  return mimeByExt[ext] || 'application/octet-stream';
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

  const fileUri = uploadPayload?.file?.uri;
  if (!fileUri) {
    const error = new Error('Gemini Files API não retornou URI do arquivo.');
    error.statusCode = 500;
    throw error;
  }

  return { fileUri, mimeType };
}

async function analyzeVideo(filePath, metadata, customPrompt) {
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error('GEMINI_API_KEY não configurada. Análise real não executada.');
    error.statusCode = 500;
    throw error;
  }

  const { fileUri, mimeType } = await uploadToGeminiFiles(filePath);
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${process.env.GEMINI_API_KEY}`;
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
  const url = new URL(driveUrl);
  const idFromQuery = url.searchParams.get('id');
  if (idFromQuery) return idFromQuery;

  const patterns = [/\/d\/([a-zA-Z0-9_-]+)/, /\/file\/d\/([a-zA-Z0-9_-]+)/];
  for (const pattern of patterns) {
    const match = driveUrl.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

async function downloadDriveFile(driveUrl) {
  const fileId = extractDriveFileId(driveUrl);
  if (!fileId) {
    const error = new Error('Link do Google Drive inválido. Não foi possível extrair o fileId.');
    error.statusCode = 400;
    throw error;
  }

  const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
  const tmpPath = path.join('/tmp', `drive_video_${Date.now()}_${fileId}.mp4`);

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    const error = new Error('Falha ao baixar arquivo do Google Drive. Verifique permissões do link.');
    error.statusCode = 400;
    throw error;
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(tmpPath, Buffer.from(arrayBuffer));
  return tmpPath;
}

async function persistReport(report) {
  ensureStorageDirs();
  const reportId = `report_${Date.now()}`;
  const outputPath = path.join(REPORTS_DIR, `${reportId}.json`);
  fs.writeFileSync(outputPath, JSON.stringify({ reportId, ...report }, null, 2), 'utf-8');
  return { reportId, outputPath };
}

app.get('/api/default-prompt', (_req, res) => {
  res.json({ defaultPrompt: DEFAULT_PROMPT });
});

app.post('/api/analyze/upload', upload.single('video'), async (req, res) => {
  let fileInfo = { fileExists: false, fileSizeBytes: 0, fileSizeMB: 0 };
  try {
    ensureStorageDirs();

    if (!req.file) {
      return res.status(400).json({ error: 'Envie um arquivo de vídeo.' });
    }

    const metadata = {
      professor: req.body.professor || '',
      turma: req.body.turma || '',
      sala: req.body.sala || ''
    };
    const customPrompt = req.body.customPrompt || DEFAULT_PROMPT;

    fileInfo = getFileInspection(req.file.path);
    if (!fileInfo.fileExists || fileInfo.fileSizeBytes <= MIN_FILE_SIZE_BYTES) {
      return res.status(400).json({
        error: 'Arquivo de vídeo inválido. O arquivo deve existir e ter tamanho maior que 1MB.',
        fileExists: fileInfo.fileExists,
        fileSizeMB: fileInfo.fileSizeMB,
        usedRealAI: false,
        provider: 'gemini'
      });
    }

    const report = await analyzeVideo(req.file.path, metadata, customPrompt);
    const { reportId, outputPath } = await persistReport(report);

    res.json({
      reportId,
      report,
      reportFile: path.relative(__dirname, outputPath),
      uploadedFile: path.relative(__dirname, req.file.path),
      fileExists: fileInfo.fileExists,
      fileSizeMB: fileInfo.fileSizeMB,
      usedRealAI: true,
      provider: 'gemini'
    });
  } catch (error) {
    const statusCode = error.statusCode || 400;
    res.status(statusCode).json({
      error: error.message || 'Erro ao processar upload',
      fileExists: fileInfo.fileExists,
      fileSizeMB: fileInfo.fileSizeMB,
      usedRealAI: false,
      provider: 'gemini'
    });
  }
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
