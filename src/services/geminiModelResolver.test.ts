import { describe, it, expect } from 'vitest';
import { isModelUnavailableError, extractModelNameFromError } from './geminiModelResolver';

describe('geminiModelResolver', () => {
  it('reconhece o 404 de modelo desligado pelo Google', () => {
    const err = { status: 404, message: 'This model models/gemini-2.5-flash is no longer available to new users.' };
    expect(isModelUnavailableError(err)).toBe(true);
    expect(extractModelNameFromError(err)).toBe('gemini-2.5-flash');
  });

  it('não confunde erro de cota (429) com modelo indisponível', () => {
    expect(isModelUnavailableError({ status: 429, message: 'RESOURCE_EXHAUSTED' })).toBe(false);
  });
});
