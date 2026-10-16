/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures e fakes de JSON de forma livre */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Banco e IndexedDB falsos (hoisted: vi.mock é executado antes dos imports)
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const state = {
    db: new Map<string, any>(), // id -> linha da tabela projects
    idb: new Map<string, any>(), // idb-keyval
    clock: 0,
    fullRowSelects: 0, // quantas vezes alguém baixou a coluna "data" inteira
    upserts: [] as Array<{ id: string; data: any }>,
    loadGate: null as null | Promise<void>,
  };
  const stamp = () => `2026-10-14T00:00:${String(++state.clock).padStart(2, '0')}.000Z`;

  const pick = (row: any, cols: string) => {
    if (cols === '*') return structuredClone(row);
    const out: any = {};
    for (const c of cols.split(',').map((x) => x.trim())) out[c] = structuredClone(row[c]);
    return out;
  };

  const builder = () => {
    const st: any = { op: 'select', cols: '*', filters: [] as Array<(r: any) => boolean>, payload: null, returning: false };
    const run = async (single: boolean) => {
      if (st.op === 'select') {
        const isLoad = st.cols.includes('autopilot_locked_until') && st.cols.includes('data') && !st.cols.includes('id');
        if (st.cols.split(',').map((c: string) => c.trim()).includes('data')) state.fullRowSelects++;
        const rows = [...state.db.values()].filter((r) => st.filters.every((f: any) => f(r))).map((r) => pick(r, st.cols));
        if (isLoad && state.loadGate) await state.loadGate; // a resposta chega atrasada, mas já está "congelada"
        return single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null };
      }
      if (st.op === 'upsert') {
        const row = st.payload;
        state.upserts.push({ id: row.id, data: structuredClone(row.data) });
        const prev = state.db.get(row.id) || { autopilot_locked_until: null, autopilot_locked_by: null };
        state.db.set(row.id, { ...prev, ...structuredClone(row) });
        return st.returning
          ? { data: [pick(state.db.get(row.id), st.cols)], error: null }
          : { data: null, error: null };
      }
      if (st.op === 'delete') {
        [...state.db.values()].filter((r) => st.filters.every((f: any) => f(r))).forEach((r) => state.db.delete(r.id));
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };
    const b: any = {
      select(cols = '*') { st.cols = cols; if (st.op !== 'select') st.returning = true; return b; },
      eq(col: string, val: any) { st.filters.push((r: any) => r[col] === val); return b; },
      in(col: string, vals: any[]) { st.filters.push((r: any) => vals.includes(r[col])); return b; },
      maybeSingle() { return run(true); },
      upsert(row: any) { st.op = 'upsert'; st.payload = row; return b; },
      update(obj: any) { st.op = 'update'; st.payload = obj; return b; },
      delete() { st.op = 'delete'; return b; },
      then(res: any, rej: any) { return run(false).then(res, rej); },
    };
    return b;
  };

  const supabase = { from: () => builder(), rpc: async () => ({ data: null, error: null }) };
  return { state, stamp, supabase };
});

vi.mock('idb-keyval', () => ({
  get: async (k: string) => h.state.idb.get(k),
  set: async (k: string, v: any) => { h.state.idb.set(k, structuredClone(v)); },
  del: async (k: string) => { h.state.idb.delete(k); },
}));
vi.mock('../lib/supabaseClient', () => ({ supabase: h.supabase, setSupabaseUserEmail: async () => {} }));
vi.mock('./AuthContext', () => ({
  useAuth: () => ({ user: { email: 'u@x.com' }, accessToken: null, refreshYouTubeToken: async () => null }),
}));

import { ProjectProvider, useProjects } from './ProjectContext';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const KEY = 'darkstream_projects_u@x.com';
const iso = (d: string) => `${d}T10:00:00.000Z`;

const manualVideo = (id = 'm1') => ({
  id, projectId: 'p1', title: 'Vídeo manual', status: 'PUBLISHED', createdAt: iso('2026-09-08'), updatedAt: iso('2026-09-08'),
  script: { title: 't', description: 'd', segments: [] }, youtubeUrl: 'https://youtu.be/old',
});
const runnerVideo = (n: number, extra: Record<string, any> = {}) => ({
  id: `auto_${n}`, projectId: 'p1', ideaId: `i${n}`, title: `TÍTULO FINAL ${n}`, status: 'PUBLISHED',
  createdAt: iso('2026-10-10'), updatedAt: iso('2026-10-10'), youtubeUrl: `https://youtu.be/auto${n}`,
  audioUrl: '__runner_audio__', visualScenes: [{ startTime: 0, segmentIndex: 0, imageUrl: '__runner_image__' }],
  ...extra,
});
const idea = (id: string, status = 'new', extra: Record<string, any> = {}) => ({
  id, topic: `Tópico ${id} exclusivo`, context: 'c', specificContext: `detalhe ${id}`, status, createdAt: iso('2026-10-01'), ...extra,
});
const baseProject = (extra: Record<string, any> = {}) => ({
  id: 'p1', channelTheme: 'Crimes reais', description: 'Casos', language: 'Portuguese (BR)', createdAt: iso('2026-08-09'),
  videos: [manualVideo()], ideas: [idea('i1')], library: [], scheduleSettings: { frequencyDays: 1, autoGenerate: true, nextScheduledRun: 'A' },
  ...extra,
});

const putRemote = (data: any) => {
  h.state.db.set(data.id, { id: data.id, user_email: 'u@x.com', data: structuredClone(data), updated_at: h.stamp(), autopilot_locked_until: null, autopilot_locked_by: null });
};
/** O runner grava na linha (muda `data` e `updated_at`). */
const runnerWrites = (mutate: (d: any) => any) => {
  const row = h.state.db.get('p1');
  row.data = mutate(structuredClone(row.data));
  row.updated_at = h.stamp();
};

let ctx: ReturnType<typeof useProjects>;
const Probe = () => { ctx = useProjects(); return null; };
const settle = async (ms = 50) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const project = () => ctx.projects.find((p) => p.id === 'p1')!;
const ids = (list: any[]) => list.map((x) => x.id);

const mount = async () => {
  render(<ProjectProvider><Probe /></ProjectProvider>);
  await settle(20); // IndexedDB + resposta da nuvem
  expect(ctx.isLoading).toBe(false);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  h.state.db.clear(); h.state.idb.clear(); h.state.clock = 0; h.state.fullRowSelects = 0; h.state.upserts = []; h.state.loadGate = null;
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

// ---------------------------------------------------------------------------
describe('ProjectProvider ↔ nuvem (runner do GitHub Actions)', () => {
  it('carga: vídeos criados pela automação aparecem UMA vez (sem duplicar) e com a ideia ligada', async () => {
    h.state.idb.set(KEY, [baseProject()]); // IndexedDB não conhece os vídeos do runner
    putRemote(baseProject({
      videos: [runnerVideo(2), runnerVideo(1), manualVideo()],
      ideas: [idea('i1', 'used', { videoId: 'auto_1', videoTitle: 'TÍTULO FINAL 1' }), idea('i2', 'used'), idea('i3'), idea('i4')],
    }));
    await mount();
    expect(ids(project().videos)).toEqual(['auto_2', 'auto_1', 'm1']);
    expect(project().ideas?.find((i) => i.id === 'i1')?.videoId).toBe('auto_1');
    expect(project().ideas?.filter((i) => i.status === 'new')).toHaveLength(2);
  });

  it('carga: duplicatas que o bug antigo já gravou na nuvem são removidas', async () => {
    h.state.idb.set(KEY, [baseProject()]);
    putRemote(baseProject({ videos: [runnerVideo(1), runnerVideo(1), manualVideo(), manualVideo()] }));
    await mount();
    expect(ids(project().videos)).toEqual(['auto_1', 'm1']);
    await settle(1700); // a gravação de cura sobe o projeto já sem duplicatas
    expect(ids(h.state.db.get('p1').data.videos)).toEqual(['auto_1', 'm1']);
  });

  it('atualização periódica: o vídeo novo do runner aparece SEM recarregar a página', async () => {
    h.state.idb.set(KEY, [baseProject()]);
    putRemote(baseProject());
    await mount();
    await settle(1700);
    expect(ids(project().videos)).toEqual(['m1']);

    runnerWrites((d) => ({
      ...d,
      videos: [runnerVideo(5), ...d.videos],
      ideas: [idea('i1', 'used', { videoId: 'auto_5' }), idea('i6'), idea('i7')],
      scheduleSettings: { ...d.scheduleSettings, nextScheduledRun: 'B' },
    }));
    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle(50);

    expect(ids(project().videos)).toEqual(['auto_5', 'm1']);
    expect(project().videos[0].status).toBe('PUBLISHED');
    expect(project().ideas?.map((i) => i.id)).toEqual(['i1', 'i6', 'i7']);
    expect(project().scheduleSettings?.nextScheduledRun).toBe('B');
  });

  it('atualização periódica é barata: sem mudança na nuvem NÃO baixa a linha inteira', async () => {
    h.state.idb.set(KEY, [baseProject()]);
    putRemote(baseProject());
    await mount();
    await settle(1700);
    const before = h.state.fullRowSelects;
    for (let i = 0; i < 3; i++) {
      await act(async () => { window.dispatchEvent(new Event('focus')); });
      await settle(20);
    }
    await settle(61_000); // e o intervalo de 1 minuto
    expect(h.state.fullRowSelects).toBe(before);
  });

  it('gravação com merge: uma aba velha NÃO apaga o vídeo que o runner publicou enquanto isso', async () => {
    h.state.idb.set(KEY, [baseProject()]);
    putRemote(baseProject());
    await mount();
    await settle(1700);

    // o runner publica; a aba ainda não sabe (nenhuma atualização periódica rodou)
    runnerWrites((d) => ({ ...d, videos: [runnerVideo(7), ...d.videos], ideas: [idea('i1', 'used', { videoId: 'auto_7' }), idea('i8')] }));

    // o usuário mexe numa configuração (isso grava o projeto inteiro)
    await act(async () => { ctx.updateProject('p1', { description: 'Descrição nova do usuário' }); });
    await settle(1700);

    const cloud = h.state.db.get('p1').data;
    expect(cloud.description).toBe('Descrição nova do usuário'); // edição do usuário gravada
    expect(ids(cloud.videos)).toEqual(['auto_7', 'm1']); // vídeo do runner preservado na nuvem
    expect(cloud.ideas.find((i: any) => i.id === 'i1').status).toBe('used');
    expect(ids(cloud.ideas)).toEqual(['i1', 'i8']);
    expect(ids(project().videos)).toEqual(['auto_7', 'm1']); // e já aparece na tela
    expect(project().description).toBe('Descrição nova do usuário');
  });

  it('exclusão feita pelo usuário é respeitada e não "ressuscita" na atualização seguinte', async () => {
    h.state.idb.set(KEY, [baseProject({ videos: [runnerVideo(1), manualVideo()] })]);
    putRemote(baseProject({ videos: [runnerVideo(1), manualVideo()] }));
    await mount();
    await settle(1700);

    await act(async () => { ctx.deleteVideo('p1', 'm1'); });
    await settle(1700);
    expect(ids(h.state.db.get('p1').data.videos)).toEqual(['auto_1']);

    await act(async () => { window.dispatchEvent(new Event('focus')); });
    await settle(1700);
    expect(ids(project().videos)).toEqual(['auto_1']);
    expect(ids(h.state.db.get('p1').data.videos)).toEqual(['auto_1']);
  });

  it('não grava o estado velho do IndexedDB enquanto a 1ª leitura da nuvem ainda não chegou', async () => {
    h.state.idb.set(KEY, [baseProject()]); // velho: sem o vídeo do runner
    putRemote(baseProject({ videos: [runnerVideo(3), manualVideo()] }));
    let release!: () => void;
    h.state.loadGate = new Promise<void>((r) => { release = r; });

    render(<ProjectProvider><Probe /></ProjectProvider>);
    await settle(5000); // bem mais que os 1,5 s do debounce
    expect(h.state.upserts).toHaveLength(0); // nada foi gravado com dado velho

    release();
    await settle(2000);
    expect(ids(project().videos)).toEqual(['auto_3', 'm1']);
    expect(ids(h.state.db.get('p1').data.videos)).toEqual(['auto_3', 'm1']); // a nuvem continua com o vídeo do runner
  });
});
