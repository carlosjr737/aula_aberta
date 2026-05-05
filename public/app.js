let currentRecording = null;

const reportBox = document.getElementById('reportBox');
const tabs = [...document.querySelectorAll('.tab')];
const panels = [...document.querySelectorAll('.panel')];

function setStatus(id, message) {
  document.getElementById(id).textContent = message;
}

function showReport(data) {
  reportBox.textContent = JSON.stringify(data, null, 2);
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    panels.forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

async function loadDefaultPrompt() {
  const resp = await fetch('/api/default-prompt');
  const data = await resp.json();
  document.getElementById('recordPrompt').value = data.defaultPrompt;
  document.getElementById('uploadPrompt').value = data.defaultPrompt;
}

document.getElementById('startRecording').addEventListener('click', async () => {
  const rtspUrl = document.getElementById('rtspUrl').value.trim();
  currentRecording = {
    rtspUrl,
    startedAt: new Date().toISOString(),
    simulatedFilePath: `uploads/recorded_${Date.now()}.mp4`
  };
  setStatus('recordStatus', `Gravação iniciada (simulada). Origem: ${rtspUrl || 'sem RTSP'}`);
});

document.getElementById('stopAndAnalyze').addEventListener('click', async () => {
  if (!currentRecording) {
    setStatus('recordStatus', 'Inicie a gravação antes de encerrar e analisar.');
    return;
  }

  setStatus('recordStatus', 'Encerrando gravação e enviando para análise...');
  const body = {
    rtspUrl: currentRecording.rtspUrl,
    filePath: currentRecording.simulatedFilePath,
    professor: document.getElementById('recordProfessor').value,
    turma: document.getElementById('recordTurma').value,
    sala: document.getElementById('recordSala').value,
    customPrompt: document.getElementById('recordPrompt').value
  };

  const resp = await fetch('/api/analyze/recorded', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!resp.ok) {
    setStatus('recordStatus', data.error || 'Falha ao analisar gravação.');
    return;
  }

  setStatus('recordStatus', `Relatório gerado: ${data.reportId}`);
  showReport(data);
  currentRecording = null;
});

document.getElementById('analyzeUpload').addEventListener('click', async () => {
  const file = document.getElementById('uploadVideo').files[0];
  if (!file) {
    setStatus('uploadStatus', 'Selecione um vídeo.');
    return;
  }

  setStatus('uploadStatus', 'Enviando vídeo e analisando...');
  const form = new FormData();
  form.append('video', file);
  form.append('professor', document.getElementById('uploadProfessor').value);
  form.append('turma', document.getElementById('uploadTurma').value);
  form.append('sala', document.getElementById('uploadSala').value);
  form.append('customPrompt', document.getElementById('uploadPrompt').value);

  const resp = await fetch('/api/analyze/upload', { method: 'POST', body: form });
  const data = await resp.json();
  if (!resp.ok) {
    setStatus('uploadStatus', data.error || 'Falha no upload/análise.');
    return;
  }

  setStatus('uploadStatus', `Relatório gerado: ${data.reportId}`);
  showReport(data);
});

loadDefaultPrompt();
