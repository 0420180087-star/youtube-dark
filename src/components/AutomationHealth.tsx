/**
 * AutomationHealth — painel de diagnóstico da automação.
 *
 * Responde, sem abrir o console, às 4 perguntas que travam a automação:
 *   1. O schema do Supabase está completo? (bootstrap.sql aplicado?)
 *   2. As chaves de API estão salvas?
 *   3. O canal do YouTube está conectado e com token válido?
 *   4. O runner headless (GitHub Actions) está vivo?
 */

import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Loader2, Stethoscope, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';
import { useProjects } from '../context/ProjectContext';
import { getUserSettings, getProjectAuthStatuses } from '../services/userDataService';

type State = 'ok' | 'warn' | 'fail' | 'checking';

interface Check {
  label: string;
  state: State;
  detail: string;
}

const REQUIRED_TABLES = [
  'projects',
  'project_auth',
  'user_settings',
  'autopilot_logs',
  'automation_heartbeat',
] as const;

const StateIcon: React.FC<{ state: State }> = ({ state }) => {
  if (state === 'checking') return <Loader2 className="w-4 h-4 text-slate-500 animate-spin flex-shrink-0" />;
  if (state === 'ok') return <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />;
  if (state === 'warn') return <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0" />;
  return <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />;
};

export const AutomationHealth: React.FC = () => {
  const { user } = useAuth();
  const { projects } = useProjects();
  const [checks, setChecks] = useState<Check[]>([]);
  const [isChecking, setIsChecking] = useState(false);

  const runChecks = async () => {
    setIsChecking(true);
    const result: Check[] = [];

    if (!supabase) {
      setChecks([{
        label: 'Supabase',
        state: 'fail',
        detail: 'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY ausentes no build. A automação headless não funciona sem isso.',
      }]);
      setIsChecking(false);
      return;
    }

    // 1. Schema
    const missing: string[] = [];
    for (const table of REQUIRED_TABLES) {
      const { error } = await supabase.from(table).select('*').limit(1);
      const msg = (error?.message || '').toLowerCase();
      if (error && (msg.includes('does not exist') || msg.includes('permission denied'))) {
        missing.push(table);
      }
    }
    const { error: rpcError } = await supabase.rpc('acquire_autopilot_lock', {
      p_project_id: '__health_probe__',
      p_locked_by: 'health-check',
      p_lock_minutes: 1,
    });
    if (rpcError) missing.push('acquire_autopilot_lock()');

    result.push({
      label: 'Schema do banco',
      state: missing.length === 0 ? 'ok' : 'fail',
      detail: missing.length === 0
        ? 'Todas as tabelas e funções necessárias existem.'
        : `Faltando: ${missing.join(', ')}. Execute supabase/bootstrap.sql no SQL Editor.`,
    });

    // 2. Chaves de API — via Edge Function (user_settings não é legível pelo navegador)
    if (user?.email) {
      try {
        const settings = await getUserSettings();
        const geminiCount = settings.gemini_api_keys?.length || 0;
        const hasPexels = !!settings.pexels_api_key;
        result.push({
          label: 'Chaves de API',
          state: geminiCount > 0 ? (hasPexels ? 'ok' : 'warn') : 'fail',
          detail: geminiCount === 0
            ? 'Nenhuma chave Gemini salva. Sem ela o runner não gera nada — salve em Configurações.'
            : `${geminiCount} chave(s) Gemini${hasPexels ? ' + Pexels' : ' — Pexels ausente, os visuais cairão para geração por IA'}.`,
        });
      } catch (e: any) {
        result.push({
          label: 'Chaves de API',
          state: 'fail',
          detail: `Não foi possível ler as configurações: ${e?.message || e}. Faça deploy da Edge Function user-data e rode supabase/bootstrap.sql.`,
        });
      }
    }

    // 2b. Cota do Gemini — lida de automation_quota_events (compartilhado entre
    // o navegador e o runner do GitHub Actions). O estado em memória da aba
    // (getKeysStatusSummary) só reflete ESTA aba, então não serve para o painel.
    if (user?.email) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: quota, error: quotaError } = await supabase
        .from('automation_quota_events')
        .select('runner, key_masked, reason, cooldown_ms, created_at')
        .eq('user_email', user.email.trim().toLowerCase())
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(50);

      if (quotaError) {
        result.push({
          label: 'Cota Gemini',
          state: 'warn',
          detail: `Não foi possível ler automation_quota_events: ${quotaError.message}. Execute supabase/bootstrap.sql no SQL Editor.`,
        });
      } else if (!quota?.length) {
        result.push({
          label: 'Cota Gemini',
          state: 'ok',
          detail: 'Nenhum erro 429/503 do Gemini nas últimas 24h.',
        });
      } else {
        const keys = new Set(quota.map((q: any) => q.key_masked));
        const last = quota[0] as any;
        const daily = quota.filter((q: any) => (q.cooldown_ms || 0) >= 30 * 60 * 1000).length;
        result.push({
          label: 'Cota Gemini',
          state: daily > 0 ? 'fail' : 'warn',
          detail: `${quota.length} evento(s) de cota nas últimas 24h em ${keys.size} chave(s)${daily > 0 ? ` — ${daily} de limite diário` : ''}. Último: ${last.reason} (${last.runner}, chave ${last.key_masked}, ${new Date(last.created_at).toLocaleString('pt-BR')}).${daily > 0 ? ' Adicione outra chave em Configurações ou aumente o limite no Google AI Studio.' : ''}`,
        });
      }
    }


    // 3. Canais do YouTube por projeto (com Auto-Pilot ligado) — via Edge Function
    const autoProjects = projects.filter(p => p.scheduleSettings?.autoGenerate);
    if (autoProjects.length > 0 && user?.email) {
      try {
        const authRows = await getProjectAuthStatuses();
        const disconnected = autoProjects.filter(p => {
          const row = authRows.find(r => r.project_id === p.id);
          return !row?.has_refresh_token || row?.token_status === 'revoked';
        });
        result.push({
          label: 'Canais do YouTube',
          state: disconnected.length === 0 ? 'ok' : 'warn',
          detail: disconnected.length === 0
            ? `${autoProjects.length} projeto(s) com canal conectado e token válido.`
            : `${disconnected.length} projeto(s) sem canal válido (${disconnected.map(p => p.title).join(', ')}). Os vídeos serão gerados e ficarão agendados até a reconexão.`,
        });
      } catch (e: any) {
        result.push({
          label: 'Canais do YouTube',
          state: 'warn',
          detail: `Falha ao verificar: ${e?.message || e}`,
        });
      }
    }

    // 4. Heartbeat do runner headless
    const { data: hb } = await supabase
      .from('automation_heartbeat')
      .select('last_seen_at, detail')
      .eq('runner', 'github-actions')
      .maybeSingle();

    if (!hb?.last_seen_at) {
      result.push({
        label: 'Runner headless',
        state: 'fail',
        detail: 'O GitHub Actions nunca rodou. Configure os secrets do repositório (veja SETUP.md, passo 3).',
      });
    } else {
      const ageMin = Math.round((Date.now() - new Date(hb.last_seen_at).getTime()) / 60000);
      result.push({
        label: 'Runner headless',
        state: ageMin <= 60 ? 'ok' : 'warn',
        detail: ageMin <= 60
          ? `Vivo — último sinal há ${ageMin} min. ${hb.detail || ''}`
          : `Sem sinal há ${ageMin} min (cron roda a cada 15 min). Verifique a aba Actions do repositório.`,
      });
    }

    setChecks(result);
    setIsChecking(false);
  };

  useEffect(() => {
    runChecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email, projects.length]);

  const worst: State = checks.some(c => c.state === 'fail')
    ? 'fail'
    : checks.some(c => c.state === 'warn') ? 'warn' : 'ok';

  const borderClass = worst === 'fail'
    ? 'border-red-500/30 bg-red-950/10'
    : worst === 'warn' ? 'border-yellow-500/30 bg-yellow-950/10' : 'border-green-500/20 bg-green-950/10';

  return (
    <div className={`rounded-2xl border p-5 space-y-3 ${borderClass}`}>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          <Stethoscope className="w-5 h-5 text-orange-400" />
          Saúde da Automação
        </h2>
        <button
          onClick={runChecks}
          disabled={isChecking}
          className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-white disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
          Reverificar
        </button>
      </div>

      <div className="space-y-2">
        {checks.length === 0 && isChecking && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Verificando...
          </div>
        )}
        {checks.map(c => (
          <div key={c.label} className="flex items-start gap-2 bg-slate-950/50 px-3 py-2 rounded-lg border border-slate-800/50">
            <div className="mt-0.5"><StateIcon state={c.state} /></div>
            <div className="min-w-0">
              <p className="text-xs font-bold text-slate-200">{c.label}</p>
              <p className="text-[11px] text-slate-400">{c.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
