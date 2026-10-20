import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, Zap } from 'lucide-react';
import { copyText, getAutoPostWorkflowUrl, shortId } from '../services/projectIdHelpers';

/**
 * Ferramentas para usar o ID do projeto na EXECUÇÃO FORÇADA do GitHub Actions.
 *
 * O workflow "Auto Post Video" pede o ID do projeto (campo opcional do "Run workflow") para gerar
 * um vídeo na hora, ignorando a programação. Esse ID é o `id` do projeto (o mesmo que aparece na
 * URL /project/<id>); aqui ele fica visível e copiável em qualquer lugar onde o projeto aparece.
 */

/** Estado "copiado!" por 1,5 s depois de copiar. */
function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    }
  };
  return { copied, copy };
}

/** Botão compacto (só ícone) que copia o ID. Não dispara cliques do elemento pai (ex.: links). */
export const CopyIdButton: React.FC<{ id: string; className?: string }> = ({ id, className = '' }) => {
  const { copied, copy } = useCopy(id);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void copy();
      }}
      className={className}
      title={copied ? 'ID copiado!' : 'Copiar ID do projeto (para execução forçada)'}
      aria-label="Copiar ID do projeto"
    >
      {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
    </button>
  );
};

/** Chip do cabeçalho do projeto: mostra o ID abreviado e copia o ID completo ao clicar. */
export const ProjectIdChip: React.FC<{ id: string }> = ({ id }) => {
  const { copied, copy } = useCopy(id);
  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="flex items-center gap-1.5 bg-slate-900 px-3 py-1.5 rounded-lg border border-slate-800 hover:border-orange-500/40 hover:text-orange-200 transition-colors"
      title={copied ? 'ID copiado!' : `ID do projeto: ${id} — clique para copiar`}
      aria-label="Copiar ID do projeto"
    >
      <span className="font-mono">ID: {shortId(id)}</span>
      {copied ? <Check className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

/** Painel da aba Settings: o ID completo + o passo a passo da execução forçada. */
export const ForceRunPanel: React.FC<{ projectId: string; workflowUrl?: string | null }> = ({
  projectId,
  workflowUrl,
}) => {
  const { copied, copy } = useCopy(projectId);
  const url = workflowUrl === undefined ? getAutoPostWorkflowUrl() : workflowUrl;

  return (
    <div className="space-y-4 bg-slate-900/40 p-6 rounded-2xl border border-slate-800">
      <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
        <Zap className="w-5 h-5 text-orange-400" />
        Execução forçada (GitHub Actions)
      </h2>
      <p className="text-sm text-slate-400">
        O robô verifica os projetos a cada 15 minutos e só gera vídeo quando chega a hora programada. Para gerar um
        vídeo <strong className="text-slate-200">agora</strong> deste projeto, use o ID abaixo no workflow{' '}
        <em>Auto Post Video</em>. A execução forçada ignora a programação (Auto-generate e próximo horário).
      </p>

      <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-3 rounded-xl border border-slate-800 bg-slate-950/60">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 flex-shrink-0">ID do projeto</span>
        <code className="flex-1 min-w-0 text-sm text-orange-200 font-mono break-all select-all" data-testid="project-id">
          {projectId}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex items-center justify-center gap-2 px-4 py-2 bg-orange-500/10 text-orange-300 hover:bg-orange-500/20 rounded-lg text-sm font-medium transition-colors flex-shrink-0"
        >
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Copiado!' : 'Copiar ID'}
        </button>
      </div>

      <ol className="list-decimal list-inside space-y-1.5 text-sm text-slate-400">
        <li>Copie o ID do projeto acima.</li>
        <li>
          {url ? (
            <>
              Abra o workflow{' '}
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-orange-400 hover:text-orange-300 hover:underline"
              >
                Auto Post Video no GitHub <ExternalLink className="w-3 h-3" />
              </a>
              .
            </>
          ) : (
            <>No repositório do GitHub, abra a aba <strong className="text-slate-300">Actions</strong> → <em>Auto Post Video</em>.</>
          )}
        </li>
        <li>
          Clique em <strong className="text-slate-300">Run workflow</strong>, cole o ID no campo{' '}
          <em>“ID do projeto para forçar execução”</em> e confirme.
        </li>
      </ol>
    </div>
  );
};
