// Monta a versão estática do painel (GitHub Pages) a partir do painel real.
//
// Não é uma cópia mantida à mão: pega `dashboard/index.html` como está, injeta o
// shim que responde à API no próprio navegador (`docs/demo-api.js`, compilado de
// `src/browser-demo.ts`) e uma faixa avisando que os dados são fictícios. Assim a
// página publicada é sempre o painel de verdade, só que sem servidor.
//
// Uso: npm run build:pages
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

const AVISO = `
<div style="background:#fff4d6;border-bottom:1px solid #f0d9a0;padding:10px 32px;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#5c4813">
  <strong>Demonstração.</strong> Este é o painel real de um projeto em produção, rodando aqui com
  <strong>dados fictícios</strong> gerados no seu navegador — nenhum número, telefone ou nome nesta
  página é de cliente. Todas as visões, filtros, gráficos, paginação e o CSV funcionam.
  <a href="https://github.com/PedroPethes/painel-disparos" style="color:#8a6d1f">Ver o código no GitHub</a>.
</div>
`.trim();

const html = await readFile(join(raiz, 'dashboard', 'index.html'), 'utf8');

if (!html.includes('<header>')) throw new Error('não achei <header> em dashboard/index.html');

const saida = html
  // o shim precisa existir antes do script do painel rodar o boot()
  .replace('</head>', '  <script src="./demo-api.js"></script>\n</head>')
  .replace('<header>', `${AVISO}\n\n<header>`)
  .replace('<title>Disparos & Respostas</title>', '<title>Disparos & Respostas — demo</title>');

await mkdir(join(raiz, 'docs'), { recursive: true });
await writeFile(join(raiz, 'docs', 'index.html'), saida);
console.log(`docs/index.html gerado (${saida.length} bytes)`);
