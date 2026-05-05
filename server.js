const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 3000;

const UPLOADS_DIR = path.join(__dirname, 'uploads');
const REPORTS_DIR = path.join(__dirname, 'reports');

for (const dir of [UPLOADS_DIR, REPORTS_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
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
  // Aqui entraria a chamada real da Gemini API enviando:
  // 1) arquivo de vídeo
  // 2) customPrompt
  // 3) metadata (professor, turma, sala)
  const mockScore = (Math.random() * 2 + 8).toFixed(1);

  return {
    resumoGeral: `Aula do professor(a) ${metadata.professor} com turma ${metadata.turma} analisada com base no Perfil Professor DK.`,
    pontosFortes: [
      'Boa condução da turma e energia consistente.',
      'Bom equilíbrio entre explicação e prática.'
    ],
    pontosDeMelhoria: [
      'Aumentar o número de correções individuais.',
      'Variar estratégias de engajamento nos momentos finais.'
    ],
    energiaEPresenca: 'Energia positiva e presença ativa durante a maior parte da aula.',
    clarezaDaConducao: 'Comandos diretos e objetivos, com boa progressão de blocos.',
    interacaoComAlunos: 'Interação frequente, com incentivo coletivo e validação de esforço.',
    explicacaoVsPratica: 'Transição rápida para prática após explicações iniciais.',
    correcoesRealizadas: 'Foram observadas correções coletivas e algumas intervenções pontuais.',
    alinhamentoPerfilDK: 'Alinhamento alto com o Perfil Professor DK, especialmente em energia e condução.',
    notaGeral: Number(mockScore),
    recomendacoes: [
      'Planejar 2 checkpoints para feedback individual por bloco.',
      'Definir objetivo técnico único por sequência para maior foco.'
    ],
    promptUsado: customPrompt,
    metadata,
    filePath,
    analyzedAt: new Date().toISOString()
  };
}

async function persistReport(report) {
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
    if (!req.file) {
      return res.status(400).json({ error: 'Envie um arquivo de vídeo.' });
    }

    const metadata = {
      professor: req.body.professor || '',
      turma: req.body.turma || '',
      sala: req.body.sala || ''
    };
    const customPrompt = req.body.customPrompt || DEFAULT_PROMPT;

    const report = await analyzeVideo(req.file.path, metadata, customPrompt);
    const { reportId, outputPath } = await persistReport(report);

    res.json({
      reportId,
      report,
      reportFile: path.relative(__dirname, outputPath),
      uploadedFile: path.relative(__dirname, req.file.path)
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Falha ao analisar vídeo enviado.' });
  }
});

app.post('/api/analyze/recorded', async (req, res) => {
  try {
    const { rtspUrl, filePath, professor, turma, sala, customPrompt } = req.body;
    const resolvedFile = filePath || null;

    if (!resolvedFile) {
      return res.status(400).json({
        error: 'filePath é obrigatório neste MVP para o fluxo de gravação (simulação após encerrar gravação).'
      });
    }

    const metadata = { professor: professor || '', turma: turma || '', sala: sala || '', rtspUrl: rtspUrl || '' };
    const report = await analyzeVideo(resolvedFile, metadata, customPrompt || DEFAULT_PROMPT);
    const { reportId, outputPath } = await persistReport(report);

    res.json({ reportId, report, reportFile: path.relative(__dirname, outputPath) });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Falha ao analisar gravação.' });
  }
});

app.listen(port, () => {
  console.log(`Servidor rodando em http://localhost:${port}`);
});
