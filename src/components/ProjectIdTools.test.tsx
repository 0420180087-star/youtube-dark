/* eslint-disable @typescript-eslint/no-explicit-any -- fakes e fixtures de forma livre */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { CopyIdButton, ProjectIdChip, ForceRunPanel } from './ProjectIdTools';
import { copyText, getAutoPostWorkflowUrl, shortId } from '../services/projectIdHelpers';
import { ProjectCard } from './ProjectCard';

const ID = '68e2148b-4b36-49ba-9215-2ad2a04a123a';

const setClipboard = (value: unknown) =>
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  setClipboard({ writeText });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('copyText', () => {
  it('usa a Clipboard API quando disponível', async () => {
    expect(await copyText('abc')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('abc');
  });

  it('sem Clipboard API, usa o plano B (textarea + execCommand)', async () => {
    setClipboard(undefined);
    const exec = vi.fn(() => true);
    (document as any).execCommand = exec;
    expect(await copyText('abc')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull(); // textarea temporário removido
  });

  it('clipboard negado → plano B; se ele também falhar, devolve false', async () => {
    setClipboard({ writeText: vi.fn().mockRejectedValue(new Error('negado')) });
    (document as any).execCommand = vi.fn(() => false);
    expect(await copyText('abc')).toBe(false);
  });
});

describe('getAutoPostWorkflowUrl', () => {
  it('monta o link do workflow a partir de dono.github.io + base do app', () => {
    expect(getAutoPostWorkflowUrl({ hostname: '0420180087-star.github.io', baseUrl: '/youtube-dark/' }))
      .toBe('https://github.com/0420180087-star/youtube-dark/actions/workflows/auto-post.yml');
  });

  it('fora do GitHub Pages ou sem repositório na base, não inventa link', () => {
    expect(getAutoPostWorkflowUrl({ hostname: 'meusite.com.br', baseUrl: '/youtube-dark/' })).toBeNull();
    expect(getAutoPostWorkflowUrl({ hostname: 'user.github.io', baseUrl: '/' })).toBeNull();
    expect(getAutoPostWorkflowUrl({ hostname: 'localhost', baseUrl: '/' })).toBeNull();
  });
});

describe('shortId', () => {
  it('abrevia UUIDs e preserva IDs curtos', () => {
    expect(shortId(ID)).toBe('68e2148b…a123a');
    expect(shortId('abc123')).toBe('abc123');
  });
});

describe('CopyIdButton', () => {
  it('copia o ID, mostra "copiado" e volta ao normal depois de 1,5 s', async () => {
    vi.useFakeTimers();
    render(<CopyIdButton id={ID} />);
    const btn = screen.getByRole('button', { name: 'Copiar ID do projeto' });
    expect(btn.getAttribute('title')).toMatch(/Copiar ID/);

    await act(async () => { fireEvent.click(btn); });
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(btn.getAttribute('title')).toBe('ID copiado!');

    await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
    expect(btn.getAttribute('title')).toMatch(/Copiar ID/);
  });

  it('o clique NÃO chega ao elemento pai (não navega quando está dentro de um link)', async () => {
    const parentClick = vi.fn();
    render(<div onClick={parentClick}><CopyIdButton id={ID} /></div>);
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(parentClick).not.toHaveBeenCalled();
  });
});

describe('ProjectIdChip', () => {
  it('mostra o ID abreviado e copia o ID COMPLETO', async () => {
    render(<ProjectIdChip id={ID} />);
    const chip = screen.getByRole('button', { name: 'Copiar ID do projeto' });
    expect(chip.textContent).toContain('ID: 68e2148b…a123a');
    expect(chip.getAttribute('title')).toContain(ID); // tooltip com o ID inteiro
    await act(async () => { fireEvent.click(chip); });
    expect(writeText).toHaveBeenCalledWith(ID);
  });
});

describe('ForceRunPanel', () => {
  it('mostra o ID completo, o passo a passo e o link do workflow', async () => {
    const url = 'https://github.com/dono/repo/actions/workflows/auto-post.yml';
    render(<ForceRunPanel projectId={ID} workflowUrl={url} />);
    expect(screen.getByTestId('project-id').textContent).toBe(ID);
    expect(screen.getByText(/Execução forçada/)).toBeTruthy();
    expect(screen.getByText(/ignora a programação/)).toBeTruthy();
    expect(screen.getByText(/ID do projeto para forçar execução/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Auto Post Video no GitHub/ });
    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('target')).toBe('_blank');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copiar ID/ })); });
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(screen.getByRole('button', { name: /Copiado!/ })).toBeTruthy();
  });

  it('sem link do workflow (fora do GitHub Pages), explica onde achar', () => {
    render(<ForceRunPanel projectId={ID} workflowUrl={null} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Actions').tagName).toBe('STRONG'); // "abra a aba Actions → Auto Post Video"
    expect(screen.getAllByText('Auto Post Video').length).toBeGreaterThanOrEqual(2);
  });
});

describe('ProjectCard — botão de copiar o ID', () => {
  const project: any = {
    id: ID, title: 'Crimes impressionantes da vida real', description: 'd', createdAt: '2026-08-09T00:00:00.000Z',
    videos: [], defaultTone: 'Dark',
  };
  const Probe = () => <span data-testid="path">{useLocation().pathname}</span>;
  const mount = (onDelete?: any) =>
    render(<MemoryRouter initialEntries={['/projects']}><Probe /><ProjectCard project={project} onDelete={onDelete} /></MemoryRouter>);

  it('copia o ID do projeto SEM navegar para a página do projeto', async () => {
    mount(vi.fn());
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copiar ID do projeto' })); });
    expect(writeText).toHaveBeenCalledWith(ID);
    expect(screen.getByTestId('path').textContent).toBe('/projects'); // não navegou
  });

  it('o botão fica ao lado do Delete (right-14) e, sem Delete, no canto (right-3)', () => {
    const { unmount } = mount(vi.fn());
    expect(screen.getByRole('button', { name: 'Copiar ID do projeto' }).className).toContain('right-14');
    unmount();
    mount();
    expect(screen.getByRole('button', { name: 'Copiar ID do projeto' }).className).toContain('right-3');
  });

  it('o card continua levando ao projeto e mantendo o botão de excluir', () => {
    mount(vi.fn());
    expect(screen.getByRole('link').getAttribute('href')).toBe(`/project/${ID}`);
    expect(screen.getByTitle('Delete Niche')).toBeTruthy();
  });
});
