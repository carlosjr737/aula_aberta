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

async function analyzeVideo(filePath, metadata, customPrompt) {
  if (!process.env.GEMINI_API_KEY) {
    const error = new Error('GEMINI_API_KEY não configurada. A análise real não foi executada.');
    error.statusCode = 500;
    throw error;
  }

  const mimeByExt = {
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo'
  };
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = mimeByExt[ext] || 'application/octet-stream';
  const videoBuffer = fs.readFileSync(filePath);
  const fileBase64 = videoBuffer.toString('base64');

  console.log(`Vídeo recebido: ${(videoBuffer.length / (1024 * 1024)).toFixed(2)} MB`);
  console.log('Enviando para Gemini...');

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
            { inlineData: { mimeType, data: fileBase64 } }
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
  console.log('Resposta Gemini recebida.');

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

    const fileInfo = getFileInspection(req.file.path);
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
      usedRealAI: false,
      provider: 'gemini'
    });
  }
});

app.post('/api/analyze/recorded', async (req, res) => {
  try {
    ensureStorageDirs();

    const { filePath } = req.body;

    if (!filePath) {
      return res.status(400).json({ error: 'filePath não informado' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(400).json({ error: 'Arquivo não encontrado', filePath });
    }

    const stats = fs.statSync(filePath);

    if (stats.size < 100000) {
      return res.status(400).json({
        error: 'Arquivo muito pequeno',
        size: stats.size
      });
    }

    console.log('Arquivo:', filePath);
    console.log('Tamanho:', stats.size);

    return res.json({
      fileExists: true,
      fileSizeMB: (stats.size / 1024 / 1024).toFixed(2),
      usedRealAI: false
    });
  } catch (error) {
    console.error('Erro detalhado:', error);
    return res.status(500).json({
      error: 'Erro interno',
      message: error.message,
      stack: error.stack
    });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
