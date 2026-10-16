/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures de JSON de forma livre */
import { describe, it, expect } from 'vitest';
import {
  mergeProjectData,
  restoreCloudBlobs,
  stableSignature,
  isCloudPlaceholder,
  isUsableImageUrl,
  persistMerged,
  createPersistState,
  replaceContents,
  type ProjectStore,
} from './projectSync';

const video = (id: string, extra: Record<string, any> = {}) => ({
  id,
  projectId: 'p1',
  title: `Video ${id}`,
  status: 'DRAFT',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

const idea = (id: string, status = 'new', extra: Record<string, any> = {}) => ({
  id,
  topic: `Tópico ${id} único`,
  context: 'c',
  status,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...extra,
});

describe('placeholders de blobs', () => {
  it('reconhece marcadores do app e do runner, mas não URLs reais', () => {
    expect(isCloudPlaceholder('__has_audio__')).toBe(true);
    expect(isCloudPlaceholder('__runner_image__')).toBe(true);
    expect(isCloudPlaceholder('https://images.pexels.com/a.jpg')).toBe(false);
    expect(isCloudPlaceholder('data:image/png;base64,AAA')).toBe(false);
    expect(isUsableImageUrl('__runner_image__')).toBe(false);
    expect(isUsableImageUrl('https://images.pexels.com/a.jpg')).toBe(true);
    expect(isUsableImageUrl(undefined)).toBe(false);
  });

  it('assinatura ignora ordem de chaves, undefined e o nome do marcador', () => {
    expect(stableSignature({ a: 1, b: { c: 2 } })).toBe(stableSignature({ b: { c: 2 }, a: 1, z: undefined }));
    expect(stableSignature({ audioUrl: '__has_audio__' })).toBe(stableSignature({ audioUrl: '__runner_audio__' }));
    expect(stableSignature({ audioUrl: '__has_audio__' })).not.toBe(stableSignature({ audioUrl: undefined }));
  });
});

describe('mergeProjectData — o app NÃO apaga o que o runner fez', () => {
  it('mantém vídeo novo, ideias usadas/novas e agenda do runner, e preserva edições do usuário', () => {
    const base = {
      id: 'p1',
      videos: [video('m1')],
      ideas: [idea('i1'), idea('i2')],
      library: [],
      scheduleSettings: { frequencyDays: 1, autoGenerate: true, nextScheduledRun: 'A' },
    };
    // Nuvem depois que o runner trabalhou
    const remote = {
      ...base,
      videos: [video('auto_1', { status: 'PUBLISHED', ideaId: 'i1' }), video('m1')],
      ideas: [
        idea('i1', 'used', { videoId: 'auto_1' }),
        idea('i2'),
        idea('i3'),
        idea('i4'),
      ],
      scheduleSettings: { frequencyDays: 1, autoGenerate: true, nextScheduledRun: 'B' },
    };
    // App (aba antiga): usuário só adicionou item na biblioteca e mudou a frequência
    const local = {
      ...base,
      library: [{ id: 'l1', type: 'text', title: 'Fonte', content: 'x', createdAt: 'z' }],
      scheduleSettings: { frequencyDays: 2, autoGenerate: true, nextScheduledRun: 'A' },
    };

    const merged: any = mergeProjectData(base, local, remote);

    expect(merged.videos.map((v: any) => v.id)).toEqual(['auto_1', 'm1']);
    expect(merged.videos[0].status).toBe('PUBLISHED');
    expect(merged.ideas.map((i: any) => [i.id, i.status])).toEqual([
      ['i1', 'used'],
      ['i2', 'new'],
      ['i3', 'new'],
      ['i4', 'new'],
    ]);
    expect(merged.ideas[0].videoId).toBe('auto_1');
    expect(merged.library).toHaveLength(1);
    // campo a campo: frequência do usuário + próxima execução do runner
    expect(merged.scheduleSettings).toEqual({ frequencyDays: 2, autoGenerate: true, nextScheduledRun: 'B' });
  });

  it('respeita a exclusão feita pelo usuário (vídeo apagado continua apagado)', () => {
    const base = { videos: [video('a'), video('b')] };
    const local = { videos: [video('a')] };
    const remote = { videos: [video('a'), video('b')] };
    const merged: any = mergeProjectData(base, local, remote);
    expect(merged.videos.map((v: any) => v.id)).toEqual(['a']);
  });

  it('se o runner mexeu num vídeo que o usuário apagou, o trabalho do runner é preservado', () => {
    const base = { videos: [video('a'), video('b')] };
    const local = { videos: [video('a')] };
    const remote = { videos: [video('a'), video('b', { status: 'PUBLISHED', updatedAt: '2026-10-02T00:00:00.000Z' })] };
    const merged: any = mergeProjectData(base, local, remote);
    expect(merged.videos.map((v: any) => v.id).sort()).toEqual(['a', 'b']);
    expect(merged.videos.find((v: any) => v.id === 'b').status).toBe('PUBLISHED');
  });

  it('remove duplicatas de id (bug antigo do merge de carga)', () => {
    const dup = [video('auto_2'), video('auto_1'), video('auto_2'), video('auto_1'), video('m1')];
    const merged: any = mergeProjectData({ videos: [video('m1')] }, { videos: dup }, { videos: dup });
    expect(merged.videos.map((v: any) => v.id)).toEqual(['auto_2', 'auto_1', 'm1']);
  });

  it('sem base, faz a UNIÃO (nunca perde dado) e o local vence conflito de campo simples', () => {
    const local = { title: 'Local', videos: [video('x')], ideas: [idea('i1')] };
    const remote = { title: 'Nuvem', videos: [video('auto_1')], ideas: [idea('i9')] };
    const merged: any = mergeProjectData(undefined, local, remote);
    expect(merged.title).toBe('Local');
    expect(merged.videos.map((v: any) => v.id).sort()).toEqual(['auto_1', 'x']);
    expect(merged.ideas.map((i: any) => i.id)).toEqual(['i1', 'i9']);
  });

  it('sem base, uma cópia velha local NUNCA reverte "used" para "new" (evita vídeo duplicado)', () => {
    const local = { ideas: [idea('i1', 'new')] }; // IndexedDB velho
    const remote = { ideas: [idea('i1', 'used', { videoId: 'auto_1' })] }; // runner já usou
    const merged: any = mergeProjectData(undefined, local, remote);
    expect(merged.ideas[0].status).toBe('used');
    expect(merged.ideas[0].videoId).toBe('auto_1');
  });

  it('não duplica ideia da nuvem cujo tópico já existe localmente', () => {
    const local = { ideas: [{ ...idea('local1'), topic: 'O caso do farol' }] };
    const remote = { ideas: [{ ...idea('remote1'), topic: 'o caso do farol ' }] };
    const merged: any = mergeProjectData({ ideas: [] }, local, remote);
    expect(merged.ideas).toHaveLength(1);
  });

  it('conflito no mesmo vídeo: vence o updatedAt mais recente', () => {
    const base = { videos: [video('a')] };
    const local = { videos: [video('a', { title: 'Local', updatedAt: '2026-10-03T00:00:00.000Z' })] };
    const remote = { videos: [video('a', { title: 'Nuvem', updatedAt: '2026-10-04T00:00:00.000Z' })] };
    expect((mergeProjectData(base, local, remote) as any).videos[0].title).toBe('Nuvem');
    const remoteOlder = { videos: [video('a', { title: 'Nuvem', updatedAt: '2026-10-02T00:00:00.000Z' })] };
    expect((mergeProjectData(base, local, remoteOlder) as any).videos[0].title).toBe('Local');
  });

  it('marcador do app e do runner não geram "mudança" (sem briga entre os dois)', () => {
    const base = { videos: [video('a', { audioUrl: '__runner_audio__' })] };
    const local = { videos: [video('a', { audioUrl: '__has_audio__' })] };
    const remote = { videos: [video('a', { audioUrl: '__runner_audio__', status: 'PUBLISHED' })] };
    const merged: any = mergeProjectData(base, local, remote);
    expect(merged.videos[0].status).toBe('PUBLISHED'); // só a nuvem mudou de verdade
  });

  it('nunca mescla as colunas de lock do runtime', () => {
    const merged: any = mergeProjectData({}, { autopilotLockedBy: 'local' }, { autopilotLockedBy: 'remote', title: 't' });
    expect(merged.autopilotLockedBy).toBe('local');
    expect(merged.title).toBe('t');
  });
});

describe('mergeProjectData — o runner NÃO apaga o que o usuário fez', () => {
  it('preserva biblioteca e vídeo manual criados no app enquanto o runner trabalhava', () => {
    const base = { videos: [video('m1')], ideas: [idea('i1')], library: [] };
    // runner (working): pegou a ideia e criou o vídeo
    const working = {
      videos: [video('auto_1', { status: 'SCRIPTING', ideaId: 'i1' }), video('m1')],
      ideas: [idea('i1', 'used')],
      library: [],
    };
    // nuvem: o usuário adicionou item na biblioteca e criou um vídeo manual
    const remote = {
      videos: [video('m2'), video('m1')],
      ideas: [idea('i1')],
      library: [{ id: 'l1', type: 'text', title: 'Nova fonte', content: 'abc', createdAt: 'z' }],
    };
    const merged: any = mergeProjectData(base, working, remote, { ownedVideoIds: ['auto_1'], ownedIdeaIds: ['i1'] });
    expect(merged.videos.map((v: any) => v.id).sort()).toEqual(['auto_1', 'm1', 'm2']);
    expect(merged.library.map((l: any) => l.id)).toEqual(['l1']);
    expect(merged.ideas[0].status).toBe('used');
  });

  it('o vídeo do runner é re-gravado mesmo que um push antigo do app o tenha apagado da nuvem', () => {
    const base = { videos: [video('auto_1'), video('m1')] };
    const working = { videos: [video('auto_1', { status: 'AUDIO_GENERATED' }), video('m1')] };
    const wiped = { videos: [video('m1')] }; // a nuvem perdeu o vídeo
    const kept: any = mergeProjectData(base, working, wiped, { ownedVideoIds: ['auto_1'] });
    expect(kept.videos.map((v: any) => v.id)).toEqual(['auto_1', 'm1']);
    expect(kept.videos[0].status).toBe('AUDIO_GENERATED');
  });

  it('o runner "dono" do vídeo vence a versão da nuvem', () => {
    const base = { videos: [video('auto_1')] };
    const working = { videos: [video('auto_1', { status: 'PUBLISHED' })] };
    const remote = { videos: [video('auto_1', { status: 'DRAFT', updatedAt: '2030-01-01T00:00:00.000Z' })] };
    const merged: any = mergeProjectData(base, working, remote, { ownedVideoIds: ['auto_1'] });
    expect(merged.videos[0].status).toBe('PUBLISHED');
  });
});

describe('restoreCloudBlobs', () => {
  it('"__has_*": devolve o blob local (e mantém o comportamento original quando não há blob local)', () => {
    const merged = {
      videos: [
        video('a', { audioUrl: '__has_audio__', thumbnailUrl: '__has_thumbnail__' }),
        video('b', { audioUrl: '__has_audio__' }),
      ],
    };
    const local = { videos: [video('a', { audioUrl: 'data:audio/wav;base64,AAA', thumbnailUrl: 'data:image/png;base64,BBB' }), video('b')] };
    const out: any = restoreCloudBlobs(merged, local);
    expect(out.videos[0].audioUrl).toBe('data:audio/wav;base64,AAA');
    expect(out.videos[0].thumbnailUrl).toBe('data:image/png;base64,BBB');
    expect(out.videos[1].audioUrl).toBeUndefined();
  });

  it('"__runner_*": mantém o marcador quando não há blob local (a fase continua "feita")', () => {
    const merged = { videos: [video('auto_1', { audioUrl: '__runner_audio__' })] };
    const local = { videos: [video('auto_1')] };
    expect((restoreCloudBlobs(merged, local) as any).videos[0].audioUrl).toBe('__runner_audio__');
    const localWithBlob = { videos: [video('auto_1', { audioUrl: 'data:audio/wav;base64,ZZZ' })] };
    expect((restoreCloudBlobs(merged, localWithBlob) as any).videos[0].audioUrl).toBe('data:audio/wav;base64,ZZZ');
  });

  it('restaura imagem de cena por startTime + segmentIndex', () => {
    const merged = {
      videos: [
        video('a', {
          visualScenes: [
            { startTime: 0, segmentIndex: 0, imageUrl: '__has_image__' },
            { startTime: 5, segmentIndex: 0, imageUrl: 'https://x/y.jpg' },
          ],
        }),
      ],
    };
    const local = { videos: [video('a', { visualScenes: [{ startTime: 0, segmentIndex: 0, imageUrl: 'data:image/png;base64,QQ' }] })] };
    const out: any = restoreCloudBlobs(merged, local);
    expect(out.videos[0].visualScenes[0].imageUrl).toBe('data:image/png;base64,QQ');
    expect(out.videos[0].visualScenes[1].imageUrl).toBe('https://x/y.jpg');
  });
});

// --- store falso (simula a linha da tabela projects) -------------------------
const makeStore = (initial: any) => {
  const state: { row: any; writes: number; failRead?: boolean; failWrite?: boolean } = {
    row: JSON.parse(JSON.stringify(initial)),
    writes: 0,
  };
  const store: ProjectStore = {
    async read() {
      if (state.failRead) return { data: null, error: 'boom-read' };
      return { data: JSON.parse(JSON.stringify(state.row)) };
    },
    async write(_id, data) {
      if (state.failWrite) return { error: 'boom-write' };
      state.row = JSON.parse(JSON.stringify(data));
      state.writes++;
      return {};
    },
  };
  return { state, store };
};

describe('persistMerged — fluxo completo do runner', () => {
  it('grava sem apagar o que o usuário fez durante a execução e adota o resultado', async () => {
    const start = { id: 'p1', videos: [video('m1')], ideas: [idea('i1'), idea('i2')], library: [] };
    const { state, store } = makeStore(start);
    const persist = createPersistState(start);
    const working: any = JSON.parse(JSON.stringify(start));

    // runner escolhe a ideia e cria o vídeo
    working.ideas[0].status = 'used';
    working.videos.unshift(video('auto_1', { ideaId: 'i1' }));
    persist.ownedVideoIds.add('auto_1');
    persist.ownedIdeaIds.add('i1');
    expect((await persistMerged(store, 'p1', working, persist)).ok).toBe(true);

    // enquanto isso o usuário (app) adiciona uma fonte na biblioteca
    state.row.library = [{ id: 'l1', type: 'text', title: 'Fonte', content: 'abc', createdAt: 'z' }];

    // runner avança de fase
    const idx = working.videos.findIndex((v: any) => v.id === 'auto_1');
    working.videos[idx] = { ...working.videos[idx], status: 'PUBLISHED', youtubeUrl: 'https://youtu.be/abc' };
    const res = await persistMerged(store, 'p1', working, persist);

    expect(res.ok).toBe(true);
    expect(state.row.library).toHaveLength(1); // preservado na nuvem
    expect(working.library).toHaveLength(1); // e adotado no trabalho do runner
    expect(state.row.videos.find((v: any) => v.id === 'auto_1').status).toBe('PUBLISHED');
    expect(state.row.ideas.find((i: any) => i.id === 'i1').status).toBe('used');
  });

  it('se um push antigo do app apagar o vídeo do runner, a próxima etapa o recoloca', async () => {
    const start = { id: 'p1', videos: [video('m1')], ideas: [], library: [] };
    const { state, store } = makeStore(start);
    const persist = createPersistState(start);
    const working: any = JSON.parse(JSON.stringify(start));
    working.videos.unshift(video('auto_1'));
    persist.ownedVideoIds.add('auto_1');
    await persistMerged(store, 'p1', working, persist);
    expect(state.row.videos.map((v: any) => v.id)).toEqual(['auto_1', 'm1']);

    state.row = { id: 'p1', videos: [video('m1')], ideas: [], library: [] }; // app sobrescreveu com estado velho

    working.videos[0] = { ...working.videos[0], status: 'SCRIPTING' };
    await persistMerged(store, 'p1', working, persist);
    expect(state.row.videos.map((v: any) => v.id)).toEqual(['auto_1', 'm1']);
    expect(state.row.videos[0].status).toBe('SCRIPTING');
  });

  it('falha de leitura: ainda grava o progresso (comportamento antigo)', async () => {
    const start = { id: 'p1', videos: [] };
    const { state, store } = makeStore(start);
    state.failRead = true;
    const working: any = { id: 'p1', videos: [video('auto_1')] };
    const res = await persistMerged(store, 'p1', working, createPersistState(start));
    expect(res.ok).toBe(true);
    expect(res.readFailed).toBe(true);
    expect(state.row.videos).toHaveLength(1);
  });

  it('falha de escrita: reporta erro e não avança a base', async () => {
    const start = { id: 'p1', videos: [] };
    const { state, store } = makeStore(start);
    state.failWrite = true;
    const persist = createPersistState(start);
    const res = await persistMerged(store, 'p1', { id: 'p1', videos: [video('a')] }, persist);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('boom-write');
    expect(persist.base).toEqual(start);
  });

  it('replaceContents mantém a referência do objeto', () => {
    const target: any = { a: 1, b: 2 };
    const ref = target;
    replaceContents(target, { b: 3, c: 4 });
    expect(ref).toBe(target);
    expect(target).toEqual({ b: 3, c: 4 });
  });
});
